import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	GranolaSyncSettings,
	DEFAULT_SETTINGS,
	GranolaSyncSettingTab,
	SYNC_FREQUENCY_MS,
	migrateSettings,
} from "./settings";
import { GranolaAuthProvider, type AuthStorage } from "./auth";
import { GranolaMcpClient } from "./mcp-client";
import { syncFolderFirst } from "./note-scope";
import { RateLimiter } from "./rate-limiter";
import { fetchMeetingTranscript, spokenRange, formatSegments } from "./granola-api";
import type { SpokenRange } from "./granola-api";
import {
	parseMeetingsResponse,
	parseTranscriptResponse,
	parseAccountInfo,
	parseClockTime,
	buildMeetingData,
	excludeSelf,
	type ParsedMeeting,
	type ParsedMeetingDetails,
	type MeetingData,
} from "./response-parser";
import {
	GranolaCacheStore,
	type CachedMeetingRecord,
} from "./cache-manager";
import {
	loadTemplate,
	applyTemplate,
	getFolderBasePath,
	resolveNotePath,
	resolveTranscriptPath,
	sanitizeFilename,
} from "./template";
import { formatFolderIndexContent } from "./folder-index";
import {
	createInitialSyncProgress,
	formatStatusBarText,
	type SyncProgressState,
} from "./sync-progress";
import DEFAULT_TRANSCRIPT_TEMPLATE from "./default-transcript-template.md";

export interface GranolaAccount {
	id: string;
	label?: string;
	/** Signed-in address, used to keep the account owner out of attendee lists. */
	email?: string;
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	/** Set when the stored tokens could no longer be refreshed and a login is required. */
	needsReauth?: boolean;
}

interface PluginData extends GranolaSyncSettings {
	accounts?: GranolaAccount[];
	// Legacy single-account fields, migrated into `accounts` on load.
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	autoSyncOnStartup?: boolean;
}

interface AccountRuntime {
	auth: GranolaAuthProvider;
	mcp: GranolaMcpClient;
}

export default class GranolaSyncPlugin extends Plugin {
	settings: GranolaSyncSettings = DEFAULT_SETTINGS;
	accounts: GranolaAccount[] = [];
	public cacheStore!: GranolaCacheStore;
	private pluginData: PluginData = { ...DEFAULT_SETTINGS };
	private isSyncing = false;
	private syncAbortController: AbortController | null = null;
	private statusBarItemEl: HTMLElement | null = null;
	private progressState: SyncProgressState = createInitialSyncProgress();
	private progressListeners = new Set<(state: SyncProgressState) => void>();
	private syncIntervalId: number | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private settingTab: GranolaSyncSettingTab | null = null;
	private runtimes = new Map<string, AccountRuntime>();
	private pendingAuthAccountId: string | null = null;
	/** Folders created or confirmed during the current sync run. */
	private ensuredFolders = new Set<string>();
	private rateLimiter = new RateLimiter();
	private transcriptRateLimiter = new RateLimiter({ baseIntervalMs: 65000 });

	get isSyncActive(): boolean {
		return this.isSyncing;
	}

	get currentSyncProgress(): SyncProgressState {
		return this.progressState;
	}

	onProgress(listener: (state: SyncProgressState) => void): () => void {
		this.progressListeners.add(listener);
		listener(this.progressState);
		return () => {
			this.progressListeners.delete(listener);
		};
	}

	notifyProgress(state: SyncProgressState): void {
		this.progressState = state;
		this.updateStatusBar();
		for (const listener of this.progressListeners) {
			try {
				listener(state);
			} catch (e) {
				console.error("Granola: error in progress listener", e);
			}
		}
	}

	private updateStatusBar(): void {
		if (!this.statusBarItemEl) return;
		const text = formatStatusBarText(this.progressState);
		this.statusBarItemEl.setText(text);
		this.statusBarItemEl.style.display = text ? "inline-block" : "none";
	}

	cancelSync(): void {
		if (this.syncAbortController && !this.syncAbortController.signal.aborted) {
			this.notifyProgress({
				...this.progressState,
				phase: "stopping",
				message: "Stopping sync...",
			});
			this.syncAbortController.abort();
			new Notice("Stopping Granola sync...");
		}
	}

	private isAbortError(error: unknown): boolean {
		return (
			(error instanceof DOMException && error.name === "AbortError") ||
			(error instanceof Error &&
				(error.name === "AbortError" || error.message.toLowerCase().includes("abort")))
		);
	}

	override async onload(): Promise<void> {
		await this.loadSettings();

		const cacheBasePath = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/cache`,
		);
		this.cacheStore = new GranolaCacheStore(this.app.vault.adapter, cacheBasePath);
		await this.cacheStore.init();

		// Create status bar element
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Register OAuth callback handler
		this.registerObsidianProtocolHandler("granola-auth", (params) => {
			const code = params.code;
			if (code) {
				void this.handleAuthCallback(code, params.state);
			}
		});

		// Add ribbon icon if enabled
		this.updateRibbonIcon();

		// Add commands
		this.addCommand({
			id: "sync-meetings",
			name: "Sync meetings",
			callback: () => void this.syncMeetings(true),
		});

		this.addCommand({
			id: "refresh-meeting-summaries",
			name: "Refresh meeting summaries from Granola",
			callback: () => void this.refreshMeetingSummaries(true),
		});

		this.addCommand({
			id: "rerender-notes-from-cache",
			name: "Re-render notes from cache",
			callback: () => void this.reRenderAllNotesFromCache(),
		});

		this.addCommand({
			id: "reroute-notes",
			name: "Re-route notes to match folder pattern",
			callback: () => void this.reRouteAllNotes(),
		});

		this.addCommand({
			id: "rerender-transcripts-from-cache",
			name: "Re-render transcripts from cache",
			callback: () => void this.reRenderAllTranscriptsFromCache(),
		});

		this.addCommand({
			id: "reroute-transcripts",
			name: "Re-route transcripts to match folder pattern",
			callback: () => void this.reRouteAllTranscripts(),
		});

		this.addCommand({
			id: "update-folder-indices",
			name: "Update folder index notes",
			callback: () => void this.updateFolderIndexNotes(true),
		});

		this.addCommand({
			id: "clear-cache",
			name: "Clear local cache",
			callback: () => void this.clearCache(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				const appWithSetting = this.app as typeof this.app & {
					setting: { open: () => void; openTabById: (id: string) => void };
				};
				appWithSetting.setting.open();
				appWithSetting.setting.openTabById(this.manifest.id);
			},
		});

		// Add settings tab
		this.settingTab = new GranolaSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle startup sync and intervals
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncFrequency !== "manual") {
				void this.syncMeetings();
			}
			this.setupSyncInterval();
		});
	}

	/**
	 * Runs once, when the user first enables the plugin. Write the default
	 * templates now rather than leaving it to the first sync.
	 */
	override onUserEnable(): void {
		void loadTemplate(this.app, this.settings.templatePath).catch((error: unknown) => {
			console.error("Granola: failed to create the default template", error);
		});
		void loadTemplate(
			this.app,
			this.settings.transcriptTemplatePath,
			DEFAULT_TRANSCRIPT_TEMPLATE,
		).catch((error: unknown) => {
			console.error("Granola: failed to create default transcript template", error);
		});
	}

	override onunload(): void {
		this.clearSyncInterval();
		this.rateLimiter.reset();
		if (this.syncAbortController) {
			this.syncAbortController.abort();
			this.syncAbortController = null;
		}
		this.progressListeners.clear();
		for (const runtime of this.runtimes.values()) {
			void runtime.mcp.disconnect();
		}
		this.runtimes.clear();
	}

	setupSyncInterval(): void {
		this.clearSyncInterval();
		const intervalMs = SYNC_FREQUENCY_MS[this.settings.syncFrequency];
		if (intervalMs) {
			this.syncIntervalId = window.setInterval(() => {
				void this.syncMeetings();
			}, intervalMs);
			this.registerInterval(this.syncIntervalId);
		}
	}

	private clearSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	updateRibbonIcon(): void {
		if (this.settings.showRibbonIcon && !this.ribbonIconEl) {
			this.ribbonIconEl = this.addRibbonIcon("calendar-sync", "Sync Granola meetings", () => {
				void this.syncMeetings(true);
			});
		} else if (!this.settings.showRibbonIcon && this.ribbonIconEl) {
			this.ribbonIconEl.remove();
			this.ribbonIconEl = null;
		}
	}

	/** True when at least one account is connected. */
	isAuthenticated(): boolean {
		return this.accounts.some((a) => a.oauthTokens !== undefined);
	}

	/** Build (or reuse) the auth provider + MCP client for an account. */
	private getRuntime(account: GranolaAccount): AccountRuntime {
		const existing = this.runtimes.get(account.id);
		if (existing) return existing;

		const storage: AuthStorage = {
			getTokens: () => this.findAccount(account.id)?.oauthTokens,
			saveTokens: async (tokens) => {
				const a = this.findAccount(account.id);
				if (a) {
					a.oauthTokens = tokens;
					await this.savePluginData();
				}
			},
			clearTokens: async () => {
				const a = this.findAccount(account.id);
				if (a) {
					delete a.oauthTokens;
					delete a.oauthClientInfo;
					await this.savePluginData();
				}
			},
			getClientInfo: () => this.findAccount(account.id)?.oauthClientInfo,
			saveClientInfo: async (info) => {
				const a = this.findAccount(account.id);
				if (a) {
					a.oauthClientInfo = info;
					await this.savePluginData();
				}
			},
		};
		const auth = new GranolaAuthProvider(storage, account.id, () => {
			const a = this.findAccount(account.id);
			if (a && !a.needsReauth) {
				a.needsReauth = true;
				void this.savePluginData();
				this.refreshSettingsTab();
			}
		});
		const mcp = new GranolaMcpClient(auth, this.rateLimiter, this.transcriptRateLimiter);
		const runtime: AccountRuntime = { auth, mcp };
		this.runtimes.set(account.id, runtime);
		return runtime;
	}

	private findAccount(id: string): GranolaAccount | undefined {
		return this.accounts.find((a) => a.id === id);
	}

	/** Start the OAuth flow for a brand-new account. */
	async addAccount(): Promise<void> {
		const account: GranolaAccount = { id: generateAccountId() };
		this.accounts.push(account);
		this.pendingAuthAccountId = account.id;
		await this.savePluginData();

		const { mcp } = this.getRuntime(account);
		try {
			await mcp.connect();
			// Already authorized (unlikely for a fresh account) — finalize now.
			await this.finalizeAccount(account);
			new Notice("Connected to Granola!");
		} catch {
			// Auth redirect happened — user completes login in browser.
			new Notice("Opening Granola login in your browser...");
		}
	}

	async disconnectAccount(id: string): Promise<void> {
		const runtime = this.runtimes.get(id);
		if (runtime) {
			await runtime.mcp.disconnect();
			this.runtimes.delete(id);
		}
		this.accounts = this.accounts.filter((a) => a.id !== id);
		if (this.pendingAuthAccountId === id) this.pendingAuthAccountId = null;
		await this.savePluginData();
		new Notice("Disconnected from Granola");
	}

	/** Re-run the login flow for an existing account whose tokens went stale. */
	async reconnectAccount(id: string): Promise<void> {
		const account = this.findAccount(id);
		if (!account) return;
		this.pendingAuthAccountId = account.id;

		const { mcp } = this.getRuntime(account);
		try {
			await mcp.connect();
			// Tokens refreshed silently — no login window was needed.
			await this.finalizeAccount(account);
			new Notice("Reconnected to Granola!");
			this.refreshSettingsTab();
		} catch {
			new Notice("Opening Granola login in your browser...");
		}
	}

	private async handleAuthCallback(code: string, state?: string): Promise<void> {
		// Prefer the `state` param (survives multiple concurrent logins);
		// fall back to the pending id for older flows.
		const accountId = state || this.pendingAuthAccountId;
		const account = accountId ? this.findAccount(accountId) : undefined;
		if (!account) {
			console.error("Granola: auth callback with no matching account");
			return;
		}
		try {
			const { mcp } = this.getRuntime(account);
			await mcp.finishAuth(code);
			await this.finalizeAccount(account);
			new Notice("Successfully connected to Granola!");
			this.refreshSettingsTab();
		} catch (error) {
			console.error("Granola auth callback failed:", error);
			new Notice("Failed to connect to Granola. Please try again.");
			// Drop the half-connected account so it doesn't linger in settings.
			await this.disconnectAccount(account.id);
		} finally {
			if (this.pendingAuthAccountId === account.id) {
				this.pendingAuthAccountId = null;
			}
		}
	}

	/** After a successful auth, fetch the account's email/name as its label. */
	private async finalizeAccount(account: GranolaAccount): Promise<void> {
		const { mcp } = this.getRuntime(account);
		account.needsReauth = false;
		try {
			if (!mcp.isConnected) await mcp.connect();
			const { label, email } = parseAccountInfo(await mcp.getAccountInfo());
			if (label) account.label = label;
			if (email) account.email = email;
		} catch (error) {
			console.error("Granola: failed to fetch account info", error);
		}
		await this.savePluginData();
	}

	/** Re-read the setting definitions so account rows reflect the current state. */
	private refreshSettingsTab(): void {
		this.settingTab?.update();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		const migrated = migrateSettings(data ?? {});
		this.pluginData = { ...migrated, ...data };
		this.settings = migrated;

		// Migrate old autoSyncOnStartup setting
		if (data?.autoSyncOnStartup !== undefined && !data.syncFrequency) {
			this.settings.syncFrequency = data.autoSyncOnStartup ? "startup" : "manual";
		}

		// Migrate legacy includeTranscripts to syncTranscripts if present
		if (data?.includeTranscripts !== undefined && data.syncTranscripts === undefined) {
			this.settings.syncTranscripts = Boolean(data.includeTranscripts);
			this.pluginData.syncTranscripts = Boolean(data.includeTranscripts);
		}

		// Load accounts, migrating a legacy single-account connection if present.
		this.accounts = this.pluginData.accounts ?? [];
		if (this.accounts.length === 0 && this.pluginData.oauthTokens) {
			this.accounts = [
				{
					id: generateAccountId(),
					oauthTokens: this.pluginData.oauthTokens,
					oauthClientInfo: this.pluginData.oauthClientInfo,
				},
			];
		}
		delete this.pluginData.oauthTokens;
		delete this.pluginData.oauthClientInfo;
		this.pluginData.accounts = this.accounts;
	}

	/**
	 * `data.json` was rewritten underneath us — with the vault on a file sync,
	 * that is usually another machine storing tokens it just refreshed. Adopt
	 * them: keeping the copy loaded at startup means the next local write puts
	 * stale tokens back, and once the refresh token has rotated that signs both
	 * machines out.
	 */
	override async onExternalSettingsChange(): Promise<void> {
		const previousAccounts = this.accounts;
		const previousFrequency = this.settings.syncFrequency;

		await this.loadSettings();

		// A login in flight is only in our copy — the machine that wrote this
		// file has never heard of it. Without this the OAuth callback comes back
		// to no account and the sign-in has to be started over.
		const pending = previousAccounts.find((a) => a.id === this.pendingAuthAccountId);
		if (pending && !this.findAccount(pending.id)) {
			this.accounts.push(pending);
			this.pluginData.accounts = this.accounts;
		}

		// Drop the clients for accounts disconnected on the other machine.
		for (const account of previousAccounts) {
			if (!this.findAccount(account.id)) {
				const runtime = this.runtimes.get(account.id);
				if (runtime) {
					void runtime.mcp.disconnect();
					this.runtimes.delete(account.id);
				}
			}
		}

		// Only on a real change: restarting the timer resets its countdown, and
		// the other machine's own syncs write this file on their own schedule.
		if (this.settings.syncFrequency !== previousFrequency) {
			this.setupSyncInterval();
		}
		this.updateRibbonIcon();
		this.refreshSettingsTab();
	}

	async saveSettings(): Promise<void> {
		Object.assign(this.pluginData, this.settings);
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		this.pluginData.accounts = this.accounts;
		await this.saveData(this.pluginData);
	}

	async refreshMeetingSummaries(manual = true): Promise<void> {
		await this.syncMeetings(manual, true);
	}

	async syncMeetings(manual = false, forceRefreshSummaries = false): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;
		this.syncAbortController = new AbortController();
		// Folders can be deleted between runs, so never trust the last run's memo.
		this.ensuredFolders.clear();

		try {
			await this.doSync(manual, this.syncAbortController.signal, forceRefreshSummaries);
		} catch (error) {
			if (this.isAbortError(error)) {
				if (manual) new Notice("Granola sync stopped");
			} else {
				console.error("Granola: sync error", error);
				if (manual) {
					new Notice(
						`Granola sync error: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}
		} finally {
			this.isSyncing = false;
			this.syncAbortController = null;
			this.notifyProgress(createInitialSyncProgress());
		}
	}

	private async doSync(
		manual: boolean,
		signal: AbortSignal,
		forceRefreshSummaries = false,
	): Promise<void> {
		if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");

		const connectedAccounts = this.accounts.filter((a) => a.oauthTokens !== undefined);
		if (connectedAccounts.length === 0) {
			if (manual) {
				new Notice("Please connect your Granola account first in plugin settings");
			}
			return;
		}

		this.notifyProgress({
			phase: "listing",
			current: 0,
			total: 0,
			message: "Checking for meetings in Granola...",
		});

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		const transcriptFolderSetting =
			this.settings.transcriptFolder || DEFAULT_SETTINGS.transcriptFolder;
		const transcriptFilenamePattern =
			this.settings.transcriptFilenamePattern || DEFAULT_SETTINGS.transcriptFilenamePattern;
		const transcriptTemplatePath =
			this.settings.transcriptTemplatePath || DEFAULT_SETTINGS.transcriptTemplatePath;

		// Load templates
		let template: string;
		let transcriptTemplate = "";
		try {
			template = await loadTemplate(this.app, templatePath);
			if (this.settings.syncTranscripts) {
				transcriptTemplate = await loadTemplate(
					this.app,
					transcriptTemplatePath,
					DEFAULT_TRANSCRIPT_TEMPLATE,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");

		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);
		try {
			await this.ensureFolderExists(folderBasePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error creating folder: ${message}`);
			return;
		}

		// Build map of existing granola_id -> file (shared across all accounts).
		// Notes with type: transcript go to existingTranscripts; others go to existingDocs.
		const { existingDocs, existingTranscripts, emailToNoteTitle } =
			this.indexVaultFiles(folderBasePath);

		const ctx: SyncContext = {
			template,
			transcriptTemplate,
			folderPathPattern,
			filenamePattern,
			transcriptFolderPattern: transcriptFolderSetting,
			transcriptFilenamePattern,
			existingDocs,
			existingTranscripts,
			emailToNoteTitle,
			signal,
			forceRefreshSummaries,
		};

		let created = 0;
		let updated = 0;
		let skipped = 0;
		let transcriptsCreated = 0;
		let failedAccounts = 0;

		for (const account of connectedAccounts) {
			if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			try {
				const result = await this.syncAccount(account, ctx);
				created += result.created;
				updated += result.updated;
				skipped += result.skipped;
				transcriptsCreated += result.transcriptsCreated;
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				failedAccounts++;
				console.error(`Granola: sync failed for account ${account.label ?? account.id}`, error);
			}
		}

		if (this.settings.generateFolderIndexNotes) {
			try {
				await this.updateFolderIndexNotes(false, ctx.existingDocs);
			} catch (error) {
				console.error("Granola: failed to update folder index notes", error);
			}
		}

		if (manual) {
			const accountSuffix =
				connectedAccounts.length > 1 ? ` across ${connectedAccounts.length} accounts` : "";
			let message: string;
			if (forceRefreshSummaries) {
				message = `Refreshed summaries: ${updated} note${updated !== 1 ? "s" : ""} updated, ${created} new${accountSuffix}`;
			} else if (!this.settings.updateNoteContent && !this.settings.rerouteExistingNotes) {
				message = `Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)${accountSuffix}`;
			} else {
				message = `Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}${accountSuffix}`;
			}
			if (transcriptsCreated > 0) {
				message += `, ${transcriptsCreated} transcript${transcriptsCreated !== 1 ? "s" : ""}`;
			}
			if (failedAccounts > 0) {
				message += `. ${failedAccounts} account${failedAccounts !== 1 ? "s" : ""} failed — check console.`;
			}
			new Notice(message);
		}
	}

	async reRenderAllNotesFromCache(): Promise<void> {
		const cachedMeetings = await this.cacheStore.listMeetings();
		if (cachedMeetings.length === 0) {
			new Notice("Granola: No cached meetings found. Run a sync first.");
			return;
		}

		new Notice(`Granola: Re-rendering ${cachedMeetings.length} notes from cache...`);

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		const transcriptFolderSetting =
			this.settings.transcriptFolder || DEFAULT_SETTINGS.transcriptFolder;
		const transcriptFilenamePattern =
			this.settings.transcriptFilenamePattern || DEFAULT_SETTINGS.transcriptFilenamePattern;

		let template: string;
		try {
			template = await loadTemplate(this.app, templatePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);
		try {
			await this.ensureFolderExists(folderBasePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error creating folder: ${message}`);
			return;
		}

		const { existingDocs, existingTranscripts, emailToNoteTitle } =
			this.indexVaultFiles(folderBasePath);

		const accountEmails = new Set<string>();
		if (this.settings.excludeSelfFromAttendees) {
			for (const a of this.accounts) {
				if (a.email) accountEmails.add(a.email.toLowerCase());
			}
		}

		let notesRendered = 0;

		for (const cached of cachedMeetings) {
			let participants = cached.participants;
			if (accountEmails.size > 0) {
				participants = participants.filter(
					(p) => !p.email || !accountEmails.has(p.email.toLowerCase()),
				);
			}

			const folders = cached.folders && cached.folders.length > 0
				? cached.folders
				: (cached.folder ? [cached.folder] : []);
			const primaryFolder = folders[0] ?? cached.folder;

			const meetingData: MeetingData = {
				id: cached.id,
				title: cached.title,
				date: cached.date,
				startTime: cached.startTime,
				startMinutes: cached.startMinutes !== undefined ? cached.startMinutes : parseClockTime(cached.startTime),
				endMinutes: cached.endMinutes ?? null,
				durationMinutes: cached.durationMinutes ?? "",
				created: cached.created,
				url: cached.url,
				folder: primaryFolder,
				folders,
				participants,
				privateNotes: cached.privateNotes,
				enhancedNotes: cached.enhancedNotes,
				transcript: "",
			};

			const meetingPathInfo = resolveNotePath(
				folderPathPattern,
				filenamePattern,
				meetingData,
			);
			const transcriptPathInfo = resolveTranscriptPath(
				transcriptFolderSetting,
				transcriptFilenamePattern,
				meetingData,
				meetingPathInfo.folder,
				meetingPathInfo.filename,
			);

			const existingTranscriptFile = existingTranscripts.get(cached.id);
			const transcriptFilename = existingTranscriptFile
				? existingTranscriptFile.basename
				: transcriptPathInfo.filename;

			const content = applyTemplate(
				template,
				meetingData,
				emailToNoteTitle,
				{
					granola_meeting_transcript: transcriptFilename,
				},
				this.settings.durationStyle,
			);

			const existingFile = existingDocs.get(cached.id);
			if (existingFile) {
				await this.app.vault.modify(existingFile, content);
			} else {
				await this.ensureFolderExists(meetingPathInfo.folder);
				const newFile = await this.app.vault.create(meetingPathInfo.path, content);
				existingDocs.set(cached.id, newFile);
			}
			notesRendered++;
		}

		new Notice(
			`Granola: Re-rendered ${notesRendered} note${notesRendered !== 1 ? "s" : ""} from cache`,
		);
		this.refreshSettingsTab();
	}

	async reRouteAllNotes(): Promise<void> {
		const cachedMeetings = await this.cacheStore.listMeetings();
		if (cachedMeetings.length === 0) {
			new Notice("Granola: No cached meetings found. Run a sync first.");
			return;
		}

		new Notice("Granola: Re-routing notes...");

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;
		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);

		const { existingDocs } = this.indexVaultFiles(folderBasePath);

		let movedCount = 0;
		let inPlaceCount = 0;
		let conflictCount = 0;

		for (const cached of cachedMeetings) {
			const existingFile = existingDocs.get(cached.id);
			if (!existingFile) continue;

			const folders = cached.folders && cached.folders.length > 0
				? cached.folders
				: (cached.folder ? [cached.folder] : []);
			const primaryFolder = folders[0] ?? cached.folder;

			const meetingData: MeetingData = {
				id: cached.id,
				title: cached.title,
				date: cached.date,
				startTime: cached.startTime,
				startMinutes: cached.startMinutes !== undefined ? cached.startMinutes : parseClockTime(cached.startTime),
				endMinutes: cached.endMinutes ?? null,
				durationMinutes: cached.durationMinutes ?? "",
				created: cached.created,
				url: cached.url,
				folder: primaryFolder,
				folders,
				participants: cached.participants,
				privateNotes: cached.privateNotes,
				enhancedNotes: cached.enhancedNotes,
				transcript: "",
			};

			const meetingPathInfo = resolveNotePath(
				folderPathPattern,
				filenamePattern,
				meetingData,
			);

			if (existingFile.path === meetingPathInfo.path) {
				inPlaceCount++;
				continue;
			}

			const moved = await this.moveFileSafely(existingFile, meetingPathInfo.path);
			if (moved) {
				movedCount++;
			} else {
				conflictCount++;
			}
		}

		let message = `Granola: Re-routed ${movedCount} note${movedCount !== 1 ? "s" : ""} (${inPlaceCount} already in place)`;
		if (conflictCount > 0) {
			message += ` (${conflictCount} conflicts skipped)`;
		}
		new Notice(message);
	}

	async reRenderAllTranscriptsFromCache(): Promise<void> {
		const cachedMeetings = await this.cacheStore.listMeetings();
		if (cachedMeetings.length === 0) {
			new Notice("Granola: No cached meetings found. Run a sync first.");
			return;
		}

		new Notice("Granola: Re-rendering transcripts from cache...");

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		const transcriptFolderSetting =
			this.settings.transcriptFolder || DEFAULT_SETTINGS.transcriptFolder;
		const transcriptFilenamePattern =
			this.settings.transcriptFilenamePattern || DEFAULT_SETTINGS.transcriptFilenamePattern;
		const transcriptTemplatePath =
			this.settings.transcriptTemplatePath || DEFAULT_SETTINGS.transcriptTemplatePath;

		let transcriptTemplate = "";
		try {
			transcriptTemplate = await loadTemplate(
				this.app,
				transcriptTemplatePath,
				DEFAULT_TRANSCRIPT_TEMPLATE,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading transcript template: ${message}`);
			return;
		}

		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);

		const { existingDocs, existingTranscripts, emailToNoteTitle } =
			this.indexVaultFiles(folderBasePath);

		const accountEmails = new Set<string>();
		if (this.settings.excludeSelfFromAttendees) {
			for (const a of this.accounts) {
				if (a.email) accountEmails.add(a.email.toLowerCase());
			}
		}

		let transcriptsRendered = 0;

		for (const cached of cachedMeetings) {
			const cachedTranscript = await this.cacheStore.getTranscript(cached.id);
			if (!cachedTranscript) {
				continue;
			}

			let participants = cached.participants;
			if (accountEmails.size > 0) {
				participants = participants.filter(
					(p) => !p.email || !accountEmails.has(p.email.toLowerCase()),
				);
			}

			const folders = cached.folders && cached.folders.length > 0
				? cached.folders
				: (cached.folder ? [cached.folder] : []);
			const primaryFolder = folders[0] ?? cached.folder;

			const meetingData: MeetingData = {
				id: cached.id,
				title: cached.title,
				date: cached.date,
				startTime: cached.startTime,
				startMinutes: cached.startMinutes !== undefined ? cached.startMinutes : parseClockTime(cached.startTime),
				endMinutes: cached.endMinutes ?? null,
				durationMinutes: cached.durationMinutes ?? "",
				created: cached.created,
				url: cached.url,
				folder: primaryFolder,
				folders,
				participants,
				privateNotes: cached.privateNotes,
				enhancedNotes: cached.enhancedNotes,
				transcript: cachedTranscript,
			};

			const meetingPathInfo = resolveNotePath(
				folderPathPattern,
				filenamePattern,
				meetingData,
			);
			const transcriptPathInfo = resolveTranscriptPath(
				transcriptFolderSetting,
				transcriptFilenamePattern,
				meetingData,
				meetingPathInfo.folder,
				meetingPathInfo.filename,
			);

			const existingNoteFile = existingDocs.get(cached.id);
			const noteLinkName = existingNoteFile
				? existingNoteFile.basename
				: meetingPathInfo.filename;

			const transcriptContent = applyTemplate(
				transcriptTemplate,
				meetingData,
				emailToNoteTitle,
				{
					granola_meeting_note: noteLinkName,
				},
				this.settings.durationStyle,
			);

			const existingTranscriptFile = existingTranscripts.get(cached.id);
			if (existingTranscriptFile) {
				await this.app.vault.modify(existingTranscriptFile, transcriptContent);
			} else {
				await this.ensureFolderExists(transcriptPathInfo.folder);
				const newTranscriptFile = await this.app.vault.create(
					transcriptPathInfo.path,
					transcriptContent,
				);
				existingTranscripts.set(cached.id, newTranscriptFile);
			}
			transcriptsRendered++;
		}

		new Notice(
			`Granola: Re-rendered ${transcriptsRendered} transcript${transcriptsRendered !== 1 ? "s" : ""} from cache`,
		);
		this.refreshSettingsTab();
	}

	async reRouteAllTranscripts(): Promise<void> {
		const cachedMeetings = await this.cacheStore.listMeetings();
		if (cachedMeetings.length === 0) {
			new Notice("Granola: No cached meetings found. Run a sync first.");
			return;
		}

		new Notice("Granola: Re-routing transcripts...");

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;
		const transcriptFolderSetting =
			this.settings.transcriptFolder || DEFAULT_SETTINGS.transcriptFolder;
		const transcriptFilenamePattern =
			this.settings.transcriptFilenamePattern || DEFAULT_SETTINGS.transcriptFilenamePattern;

		const folderPathPattern = normalizePath(folderPathSetting);
		const folderBasePath = getFolderBasePath(folderPathPattern);

		const { existingTranscripts } = this.indexVaultFiles(folderBasePath);

		let movedCount = 0;
		let inPlaceCount = 0;
		let conflictCount = 0;

		for (const cached of cachedMeetings) {
			const existingFile = existingTranscripts.get(cached.id);
			if (!existingFile) continue;

			const folders = cached.folders && cached.folders.length > 0
				? cached.folders
				: (cached.folder ? [cached.folder] : []);
			const primaryFolder = folders[0] ?? cached.folder;

			const meetingData: MeetingData = {
				id: cached.id,
				title: cached.title,
				date: cached.date,
				startTime: cached.startTime,
				startMinutes: cached.startMinutes !== undefined ? cached.startMinutes : parseClockTime(cached.startTime),
				endMinutes: cached.endMinutes ?? null,
				durationMinutes: cached.durationMinutes ?? "",
				created: cached.created,
				url: cached.url,
				folder: primaryFolder,
				folders,
				participants: cached.participants,
				privateNotes: cached.privateNotes,
				enhancedNotes: cached.enhancedNotes,
				transcript: "",
			};

			const meetingPathInfo = resolveNotePath(
				folderPathPattern,
				filenamePattern,
				meetingData,
			);
			const transcriptPathInfo = resolveTranscriptPath(
				transcriptFolderSetting,
				transcriptFilenamePattern,
				meetingData,
				meetingPathInfo.folder,
				meetingPathInfo.filename,
			);

			if (existingFile.path === transcriptPathInfo.path) {
				inPlaceCount++;
				continue;
			}

			const moved = await this.moveFileSafely(existingFile, transcriptPathInfo.path);
			if (moved) {
				movedCount++;
			} else {
				conflictCount++;
			}
		}

		let message = `Granola: Re-routed ${movedCount} transcript${movedCount !== 1 ? "s" : ""} (${inPlaceCount} already in place)`;
		if (conflictCount > 0) {
			message += ` (${conflictCount} conflicts skipped)`;
		}
		new Notice(message);
	}

	async clearCache(): Promise<void> {
		await this.cacheStore.clear();
		new Notice("Granola: Local cache cleared");
		this.refreshSettingsTab();
	}

	private indexVaultFiles(folderBasePath: string): {
		existingDocs: Map<string, TFile>;
		existingTranscripts: Map<string, TFile>;
		emailToNoteTitle: Map<string, string>;
	} {
		const existingDocs = new Map<string, TFile>();
		const existingTranscripts = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		for (const file of syncFolderFirst(files, folderBasePath)) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			const type = fileCache?.frontmatter?.type as string | undefined;
			if (granolaId) {
				if (type === "transcript") {
					if (!existingTranscripts.has(granolaId)) {
						existingTranscripts.set(granolaId, file);
					}
				} else {
					if (!existingDocs.has(granolaId)) {
						existingDocs.set(granolaId, file);
					}
				}
			}
		}

		const emailToNoteTitle = new Map<string, string>();
		if (this.settings.matchAttendeesByEmail) {
			for (const file of files) {
				const fileCache = this.app.metadataCache.getFileCache(file);
				const emails: unknown = fileCache?.frontmatter?.emails;
				if (Array.isArray(emails)) {
					for (const email of emails) {
						if (typeof email === "string") {
							emailToNoteTitle.set(email.toLowerCase(), file.basename);
						}
					}
				} else if (typeof emails === "string") {
					emailToNoteTitle.set(emails.toLowerCase(), file.basename);
				}
			}
		}

		return { existingDocs, existingTranscripts, emailToNoteTitle };
	}

	private async moveFileSafely(file: TFile, targetPath: string): Promise<boolean> {
		const normalizedTarget = normalizePath(targetPath);
		if (file.path === normalizedTarget) {
			return false;
		}
		const existing = this.app.vault.getAbstractFileByPath(normalizedTarget);
		if (existing && existing.path !== file.path) {
			console.warn(
				`Granola: cannot move ${file.path} to ${normalizedTarget} - file already exists at target path`,
			);
			return false;
		}
		const folderIndex = normalizedTarget.lastIndexOf("/");
		if (folderIndex > 0) {
			const folder = normalizedTarget.substring(0, folderIndex);
			await this.ensureFolderExists(folder);
		}
		await this.app.fileManager.renameFile(file, normalizedTarget);
		return true;
	}

	/**
	 * Create `folderPath` and any missing parents.
	 *
	 * Walks the path a segment at a time rather than handing the whole thing to
	 * `vault.createFolder`, whose recursive behaviour is not part of its documented
	 * contract. Every confirmed segment is remembered for the rest of the run, so a
	 * sync filing 100 meetings into one dated folder checks the vault index once
	 * instead of once per note.
	 */
	private async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedPath = normalizePath(folderPath);
		if (this.ensuredFolders.has(normalizedPath)) return;

		let currentPath = "";
		for (const part of normalizedPath.split("/").filter(Boolean)) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(currentPath)) {
				await this.app.vault.createFolder(currentPath);
			}
			this.ensuredFolders.add(currentPath);
		}
		this.ensuredFolders.add(normalizedPath);
	}

	/** Sync a single account into the shared folder, mutating ctx.existingDocs. */
	private async syncAccount(account: GranolaAccount, ctx: SyncContext): Promise<SyncResult> {
		if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
		const { mcp } = this.getRuntime(account);

		if (!mcp.isConnected) {
			await mcp.connect();
		}

		// Connection succeeded, so the tokens are valid again.
		if (account.needsReauth) {
			account.needsReauth = false;
			await this.savePluginData();
			this.refreshSettingsTab();
		}

		// Backfill the account name if we never captured it (e.g. accounts
		// connected before labels existed, or where the initial fetch failed).
		if (!account.label || !account.email) {
			try {
				const { label, email } = parseAccountInfo(await mcp.getAccountInfo(ctx.signal));
				if (label || email) {
					if (label) account.label = label;
					if (email) account.email = email;
					await this.savePluginData();
					this.refreshSettingsTab();
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error("Granola: failed to backfill account name", error);
			}
		}

		// List meetings
		this.notifyProgress({
			phase: "listing",
			current: 0,
			total: 0,
			message: `Checking meetings for ${account.label ?? account.id}...`,
		});

		let listResponse: string;
		try {
			listResponse = await mcp.listMeetings(
				this.settings.syncTimeRange,
				this.settings.onlyMyMeetings,
				ctx.signal,
			);
		} catch (error) {
			if (this.isAbortError(error)) throw error;
			// Disconnect so we retry connection next time
			await mcp.disconnect();
			throw error;
		}

		const listedMeetings = parseMeetingsResponse(listResponse);
		if (listedMeetings.length === 0) {
			return { created: 0, updated: 0, skipped: 0, transcriptsCreated: 0 };
		}

		// Query Granola folders and map meetings to folder names
		const meetingFoldersMap = new Map<string, string[]>();
		try {
			const folders = await mcp.listMeetingFolders(ctx.signal);
			for (const f of folders) {
				if (!f.id) continue;
				if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
				try {
					const folderMeetingsXml = await mcp.listMeetings(
						this.settings.syncTimeRange,
						this.settings.onlyMyMeetings,
						ctx.signal,
						f.id,
					);
					const folderMeetings = parseMeetingsResponse(folderMeetingsXml);
					for (const fm of folderMeetings) {
						const list = meetingFoldersMap.get(fm.id) ?? [];
						if (f.title && !list.includes(f.title)) {
							list.push(f.title);
						}
						meetingFoldersMap.set(fm.id, list);
					}
				} catch (err) {
					if (this.isAbortError(err)) throw err;
					console.warn(`Granola: failed to list meetings for folder ${f.title} (${f.id})`, err);
				}
			}
		} catch (error) {
			if (this.isAbortError(error)) throw error;
			console.warn("Granola: listMeetingFolders unavailable or failed", error);
		}

		// Attach discovered folders to listedMeetings
		for (const m of listedMeetings) {
			const folders = meetingFoldersMap.get(m.id);
			if (folders && folders.length > 0) {
				m.folders = folders;
				m.folder = folders[0];
			}
		}

		// Determine which meetings need note creation/update
		const meetingsToSyncNotes = listedMeetings.filter((m) => {
			const hasInVault = ctx.existingDocs.has(m.id);
			if (!hasInVault) return true;
			return this.settings.updateNoteContent || this.settings.rerouteExistingNotes;
		});

		// Determine which meetings need transcripts (cache is the source of truth for downloads)
		const meetingsToSyncTranscripts: ParsedMeeting[] = [];
		if (this.settings.syncTranscripts) {
			for (const m of listedMeetings) {
				const hasInCache = await this.cacheStore.hasTranscript(m.id);
				const hasInVault = ctx.existingTranscripts.has(m.id);
				if (!hasInCache || !hasInVault) {
					meetingsToSyncTranscripts.push(m);
				} else if (
					this.settings.updateTranscriptContent ||
					this.settings.rerouteExistingTranscripts
				) {
					meetingsToSyncTranscripts.push(m);
				}
			}
		}

		const skipped = listedMeetings.length - meetingsToSyncNotes.length;

		// We need details for any meeting that either needs a note update OR needs a transcript
		const neededIdsSet = new Set<string>();
		for (const m of meetingsToSyncNotes) neededIdsSet.add(m.id);
		for (const m of meetingsToSyncTranscripts) neededIdsSet.add(m.id);

		// Determine whether to query Granola for meetings that are already cached.
		// If skipExistingNotes is false, or if forceRefreshSummaries is requested, re-query Granola for updates.
		const shouldRecheckGranola =
			!this.settings.skipExistingNotes || Boolean(ctx.forceRefreshSummaries);

		const allDetails: ParsedMeetingDetails[] = [];
		const detailsMap = new Map<string, ParsedMeetingDetails>();
		const idsToFetch: string[] = [];

		for (const id of neededIdsSet) {
			const cached = await this.cacheStore.getMeeting(id);
			if (cached && !shouldRecheckGranola) {
				const folders = meetingFoldersMap.get(id) ?? cached.folders ?? (cached.folder ? [cached.folder] : []);
				const primaryFolder = folders[0] ?? cached.folder;

				// Backfill folders in cache if newly discovered
				if (folders.length > 0 && (!cached.folders || cached.folders.length === 0)) {
					cached.folders = folders;
					cached.folder = primaryFolder;
					await this.cacheStore.saveMeeting(cached);
				}

				const parsed: ParsedMeetingDetails = {
					id: cached.id,
					title: cached.title,
					date: cached.date,
					url: cached.url || "",
					startTime: cached.startTime,
					created: cached.created,
					participants: cached.participants,
					folder: primaryFolder,
					folders,
					privateNotes: cached.privateNotes,
					summary: cached.enhancedNotes,
				};
				detailsMap.set(id, parsed);
				allDetails.push(parsed);
			} else {
				idsToFetch.push(id);
			}
		}

		for (let i = 0; i < idsToFetch.length; i += 10) {
			if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			const batch = idsToFetch.slice(i, i + 10);
			try {
				const detailsResponse = await mcp.getMeetings(batch, ctx.signal);
				const parsed = parseMeetingsResponse(detailsResponse);
				allDetails.push(...parsed);
				for (const item of parsed) {
					const folders = meetingFoldersMap.get(item.id) ?? item.folders ?? (item.folder ? [item.folder] : []);
					const primaryFolder = folders[0] ?? item.folder;
					item.folders = folders;
					item.folder = primaryFolder;
					detailsMap.set(item.id, item);
					const meetingData = buildMeetingData(item, "");
					const record: CachedMeetingRecord = {
						id: item.id,
						title: item.title,
						date: meetingData.date,
						startTime: meetingData.startTime || "",
						startMinutes: meetingData.startMinutes,
						endMinutes: meetingData.endMinutes,
						durationMinutes: meetingData.durationMinutes,
						created: meetingData.created,
						url: meetingData.url,
						folder: primaryFolder,
						folders,
						participants: item.participants,
						privateNotes: item.privateNotes,
						enhancedNotes: item.summary,
						lastSyncedAt: new Date().toISOString(),
					};
					await this.cacheStore.saveMeeting(record);
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error("Granola: getMeetings batch failed", error);
			}
		}

		// Fall back to cached record if getMeetings failed or omitted an ID
		for (const id of idsToFetch) {
			if (!detailsMap.has(id)) {
				const cached = await this.cacheStore.getMeeting(id);
				if (cached) {
					const folders = meetingFoldersMap.get(id) ?? cached.folders ?? (cached.folder ? [cached.folder] : []);
					const primaryFolder = folders[0] ?? cached.folder;
					const parsed: ParsedMeetingDetails = {
						id: cached.id,
						title: cached.title,
						date: cached.date,
						url: cached.url || "",
						startTime: cached.startTime,
						created: cached.created,
						participants: cached.participants,
						folder: primaryFolder,
						folders,
						privateNotes: cached.privateNotes,
						summary: cached.enhancedNotes,
					};
					detailsMap.set(id, parsed);
					allDetails.push(parsed);
				}
			}
		}

		let created = 0;
		let updated = 0;

		// ----------------------------------------------------
		// PHASE 1: Sync Meeting Notes
		// ----------------------------------------------------
		const noteTargetDetails = allDetails.filter((d) =>
			meetingsToSyncNotes.some((m) => m.id === d.id),
		);

		for (let i = 0; i < noteTargetDetails.length; i++) {
			if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
			const details = noteTargetDetails[i];
			try {
				// Skip meetings still in progress (no summary generated yet)
				if (!details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				this.notifyProgress({
					phase: "meetings",
					current: i + 1,
					total: noteTargetDetails.length,
					message: `Saving meeting ${i + 1} of ${noteTargetDetails.length}...`,
				});

				// With an API key the transcript comes from the REST API,
				// whose segments carry the timestamps a meeting's length is
				// measured from. Without an API key, meetings rely on listed time.
				const apiKey = this.settings.granolaApiKey.trim();
				let transcript = "";
				let spoken: SpokenRange | null = null;
				if (apiKey) {
					try {
						const segments = await fetchMeetingTranscript(
							apiKey,
							details.id,
							Date.parse(details.date),
						);
						if (segments) {
							transcript = formatSegments(segments);
							spoken = spokenRange(segments);
							if (transcript && !(await this.cacheStore.hasTranscript(details.id))) {
								await this.cacheStore.saveTranscript(details.id, transcript);
							}
						} else {
							console.warn(`Granola: no API note matches meeting ${details.id}`);
						}
					} catch (error) {
						console.error(`Granola: API transcript failed for ${details.id}`, error);
					}
				}

				const meetingData = buildMeetingData(details, transcript, spoken);
				if (this.settings.excludeSelfFromAttendees && account.email) {
					meetingData.participants = excludeSelf(meetingData.participants, account.email);
				}

				if (apiKey && spoken) {
					const cached = await this.cacheStore.getMeeting(details.id);
					if (cached) {
						cached.startMinutes = meetingData.startMinutes;
						cached.endMinutes = meetingData.endMinutes;
						cached.durationMinutes = meetingData.durationMinutes;
						await this.cacheStore.saveMeeting(cached);
					}
				}

				const existingFile = ctx.existingDocs.get(details.id);
				const meetingPathInfo = resolveNotePath(
					ctx.folderPathPattern,
					ctx.filenamePattern,
					meetingData,
				);
				const transcriptPathInfo = resolveTranscriptPath(
					ctx.transcriptFolderPattern,
					ctx.transcriptFilenamePattern,
					meetingData,
					meetingPathInfo.folder,
					meetingPathInfo.filename,
				);

				const existingTranscriptFile = ctx.existingTranscripts.get(details.id);
				const transcriptLinkName = existingTranscriptFile
					? existingTranscriptFile.basename
					: transcriptPathInfo.filename;

				const content = applyTemplate(
					ctx.template,
					meetingData,
					ctx.emailToNoteTitle,
					{
						granola_meeting_transcript: transcriptLinkName,
					},
					this.settings.durationStyle,
				);

				if (existingFile) {
					let wasModified = false;
					if (this.settings.rerouteExistingNotes) {
						const moved = await this.moveFileSafely(existingFile, meetingPathInfo.path);
						if (moved) wasModified = true;
					}
					if (this.settings.updateNoteContent) {
						const existingContent = await this.app.vault.read(existingFile);
						if (existingContent !== content) {
							await this.app.vault.modify(existingFile, content);
							wasModified = true;
						}
					}
					if (wasModified) {
						updated++;
					}
				} else {
					await this.ensureFolderExists(meetingPathInfo.folder);
					const newFile = await this.app.vault.create(meetingPathInfo.path, content);
					// Track so a meeting shared across accounts isn't created twice this run.
					ctx.existingDocs.set(details.id, newFile);
					created++;
				}
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.error(`Error syncing meeting ${details.id}:`, error);
			}
		}

		// ----------------------------------------------------
		// PHASE 2: Sync Transcripts (Separated & Paced)
		// ----------------------------------------------------
		let transcriptsCreated = 0;
		if (this.settings.syncTranscripts && meetingsToSyncTranscripts.length > 0) {
			for (let i = 0; i < meetingsToSyncTranscripts.length; i++) {
				if (ctx.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
				const m = meetingsToSyncTranscripts[i];
				const details = detailsMap.get(m.id);
				// If no details or no summary, meeting may still be in progress
				if (!details || !details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				let transcript = await this.cacheStore.getTranscript(m.id);
				if (!transcript) {
					this.notifyProgress({
						phase: "transcripts",
						current: i,
						total: meetingsToSyncTranscripts.length,
						countdownSeconds: undefined,
						message: `Downloading transcript ${i + 1} of ${meetingsToSyncTranscripts.length}...`,
					});

					let rawTranscript = "";
					try {
						rawTranscript = await mcp.getTranscript(
							m.id,
							ctx.signal,
							(remainingSeconds) => {
								if (remainingSeconds > 0) {
									this.notifyProgress({
										phase: "transcripts",
										current: i,
										total: meetingsToSyncTranscripts.length,
										countdownSeconds: remainingSeconds,
										message: "",
									});
								} else {
									this.notifyProgress({
										phase: "transcripts",
										current: i + 1,
										total: meetingsToSyncTranscripts.length,
										countdownSeconds: undefined,
										message: `Downloading transcript ${i + 1} of ${meetingsToSyncTranscripts.length}...`,
									});
								}
							},
						);
					} catch (error) {
						if (this.isAbortError(error)) throw error;
						console.error(`Granola: transcript fetch failed for ${m.id}`, error);
						continue;
					}

					const parsed = parseTranscriptResponse(rawTranscript);
					if (!parsed) {
						continue;
					}
					transcript = parsed;
					await this.cacheStore.saveTranscript(m.id, transcript);
				}

				try {
					const meetingData = buildMeetingData(details, transcript);
					const cachedMeeting = await this.cacheStore.getMeeting(m.id);
					if (cachedMeeting) {
						if (cachedMeeting.startMinutes !== undefined) meetingData.startMinutes = cachedMeeting.startMinutes;
						if (cachedMeeting.endMinutes !== undefined) meetingData.endMinutes = cachedMeeting.endMinutes;
						if (cachedMeeting.durationMinutes !== undefined) meetingData.durationMinutes = cachedMeeting.durationMinutes;
					}
					if (this.settings.excludeSelfFromAttendees && account.email) {
						meetingData.participants = excludeSelf(meetingData.participants, account.email);
					}

					const meetingPathInfo = resolveNotePath(
						ctx.folderPathPattern,
						ctx.filenamePattern,
						meetingData,
					);
					const transcriptPathInfo = resolveTranscriptPath(
						ctx.transcriptFolderPattern,
						ctx.transcriptFilenamePattern,
						meetingData,
						meetingPathInfo.folder,
						meetingPathInfo.filename,
					);

					const existingNoteFile = ctx.existingDocs.get(m.id);
					const noteLinkName = existingNoteFile
						? existingNoteFile.basename
						: meetingPathInfo.filename;

					const transcriptContent = applyTemplate(
						ctx.transcriptTemplate,
						meetingData,
						ctx.emailToNoteTitle,
						{
							granola_meeting_note: noteLinkName,
						},
						this.settings.durationStyle,
					);

					await this.ensureFolderExists(transcriptPathInfo.folder);
					const existingTranscriptFile = ctx.existingTranscripts.get(m.id);
					if (existingTranscriptFile) {
						let wasModified = false;
						if (this.settings.rerouteExistingTranscripts) {
							const moved = await this.moveFileSafely(
								existingTranscriptFile,
								transcriptPathInfo.path,
							);
							if (moved) wasModified = true;
						}
						if (this.settings.updateTranscriptContent) {
							const existingContent = await this.app.vault.read(existingTranscriptFile);
							if (existingContent !== transcriptContent) {
								await this.app.vault.modify(existingTranscriptFile, transcriptContent);
								wasModified = true;
							}
						}
						if (wasModified) {
							transcriptsCreated++;
						}
					} else {
						const newTranscriptFile = await this.app.vault.create(
							transcriptPathInfo.path,
							transcriptContent,
						);
						ctx.existingTranscripts.set(m.id, newTranscriptFile);
						transcriptsCreated++;
					}
				} catch (error) {
					if (this.isAbortError(error)) throw error;
					console.error(`Error saving transcript note ${m.id}:`, error);
				}
			}
		}

		return { created, updated, skipped, transcriptsCreated };
	}

	async updateFolderIndexNotes(
		manual = false,
		existingDocsMap?: Map<string, TFile>,
	): Promise<void> {
		const cachedMeetings = await this.cacheStore.listMeetings();
		if (cachedMeetings.length === 0) {
			if (manual) new Notice("Granola: No cached meetings found to index.");
			return;
		}

		if (!existingDocsMap) {
			const folderBasePath = getFolderBasePath(
				normalizePath(this.settings.folderPath || DEFAULT_SETTINGS.folderPath),
			);
			const { existingDocs } = this.indexVaultFiles(folderBasePath);
			existingDocsMap = existingDocs;
		}

		// Group meetings by folder title
		const folderMap = new Map<string, CachedMeetingRecord[]>();
		for (const meeting of cachedMeetings) {
			const folders = meeting.folders && meeting.folders.length > 0
				? meeting.folders
				: (meeting.folder ? [meeting.folder] : []);
			for (const f of folders) {
				const trimmed = f.trim();
				if (!trimmed) continue;
				const list = folderMap.get(trimmed) ?? [];
				list.push(meeting);
				folderMap.set(trimmed, list);
			}
		}

		if (folderMap.size === 0) {
			if (manual) new Notice("Granola: No folders found in cached meetings.");
			return;
		}

		const indexFolder = normalizePath(
			this.settings.folderIndexFolder || DEFAULT_SETTINGS.folderIndexFolder,
		);
		await this.ensureFolderExists(indexFolder);

		let updatedCount = 0;
		for (const [folderTitle, meetings] of folderMap.entries()) {
			// Sort newest first
			meetings.sort((a, b) => b.date.localeCompare(a.date));

			const meetingLinks = meetings.map((m) => {
				const file = existingDocsMap?.get(m.id);
				const basename = file ? file.basename : `${m.date} ${m.title}`;
				if (m.date && !basename.includes(m.date)) {
					return `- ${m.date} — [[${basename}]]`;
				}
				return `- [[${basename}]]`;
			});

			const sanitizedTitle = sanitizeFilename(folderTitle);
			const targetPath = normalizePath(`${indexFolder}/${sanitizedTitle}.md`);
			const existingAbstract = this.app.vault.getAbstractFileByPath(targetPath);

			let existingContent: string | undefined;
			if (existingAbstract instanceof TFile) {
				existingContent = await this.app.vault.read(existingAbstract);
			}

			const newContent = formatFolderIndexContent(folderTitle, meetingLinks, existingContent);

			if (existingAbstract instanceof TFile) {
				if (existingContent !== newContent) {
					await this.app.vault.modify(existingAbstract, newContent);
					updatedCount++;
				}
			} else {
				await this.app.vault.create(targetPath, newContent);
				updatedCount++;
			}
		}

		if (manual) {
			new Notice(
				`Granola: Checked ${folderMap.size} folder index note${folderMap.size !== 1 ? "s" : ""} (${updatedCount} modified)`,
			);
		}
	}
}

interface SyncContext {
	template: string;
	transcriptTemplate: string;
	folderPathPattern: string;
	filenamePattern: string;
	transcriptFolderPattern: string;
	transcriptFilenamePattern: string;
	existingDocs: Map<string, TFile>;
	existingTranscripts: Map<string, TFile>;
	emailToNoteTitle: Map<string, string>;
	signal: AbortSignal;
	forceRefreshSummaries?: boolean;
}

interface SyncResult {
	created: number;
	updated: number;
	skipped: number;
	transcriptsCreated: number;
}

function generateAccountId(): string {
	const cryptoObj = window.crypto as Crypto | undefined;
	if (cryptoObj?.randomUUID) {
		return cryptoObj.randomUUID();
	}
	return `acct-${Math.random().toString(36).slice(2)}`;
}
