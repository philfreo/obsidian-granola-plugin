import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	GranolaSyncSettings,
	DEFAULT_SETTINGS,
	GranolaSyncSettingTab,
	SYNC_FREQUENCY_MS,
} from "./settings";
import { GranolaAuthProvider, type AuthStorage } from "./auth";
import { GranolaMcpClient } from "./mcp-client";
import { syncFolderFirst } from "./note-scope";
import {
	parseMeetingsResponse,
	parseTranscriptResponse,
	isTranscriptErrorResponse,
	extractStoredTranscript,
	parseAccountInfo,
	buildMeetingData,
	excludeSelf,
} from "./response-parser";
import { loadTemplate, applyTemplate, getFolderBasePath, resolveNotePath } from "./template";

const MAX_TRANSCRIPT_FETCHES_PER_ACCOUNT_SYNC = 4;
const TRANSCRIPT_FETCH_SPACING_MS = 65_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
	private pluginData: PluginData = { ...DEFAULT_SETTINGS };
	private isSyncing = false;
	private syncIntervalId: number | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private settingTab: GranolaSyncSettingTab | null = null;
	private runtimes = new Map<string, AccountRuntime>();
	private pendingAuthAccountId: string | null = null;
	/** Folders created or confirmed during the current sync run. */
	private ensuredFolders = new Set<string>();

	override async onload(): Promise<void> {
		await this.loadSettings();

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
	 * template now rather than leaving it to the first sync: the template path
	 * setting is a file picker, so it can only offer a file that already exists.
	 * Sync still creates one on demand, which covers the file being deleted later.
	 */
	override onUserEnable(): void {
		void loadTemplate(this.app, this.settings.templatePath).catch((error: unknown) => {
			console.error("Granola: failed to create the default template", error);
		});
	}

	override onunload(): void {
		this.clearSyncInterval();
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
		const mcp = new GranolaMcpClient(auth);
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
		this.pluginData = { ...DEFAULT_SETTINGS, ...data };
		this.settings = { ...DEFAULT_SETTINGS, ...data };

		// Migrate old autoSyncOnStartup setting
		if (data?.autoSyncOnStartup !== undefined && !data.syncFrequency) {
			this.settings.syncFrequency = data.autoSyncOnStartup ? "startup" : "manual";
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

	async syncMeetings(manual = false): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;
		// Folders can be deleted between runs, so never trust the last run's memo.
		this.ensuredFolders.clear();

		try {
			await this.doSync(manual);
		} finally {
			this.isSyncing = false;
		}
	}

	private async doSync(manual: boolean): Promise<void> {
		const connectedAccounts = this.accounts.filter((a) => a.oauthTokens !== undefined);
		if (connectedAccounts.length === 0) {
			if (manual) {
				new Notice("Please connect your Granola account first in plugin settings");
			}
			return;
		}

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		// Load template
		let template: string;
		try {
			template = await loadTemplate(this.app, templatePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		// Create the fixed part of the folder pattern up front, so a folder problem
		// is reported once here rather than per meeting — the dated subfolders below
		// are created lazily as meetings land in them.
		const folderPathPattern = normalizePath(folderPathSetting);
		// "" when the pattern is all date tokens (`{date:YYYY/MM}`): notes are filed
		// from the vault root down, so there is no static folder to pre-create and no
		// folder narrower than the vault for the scan below to prefer.
		const folderBasePath = getFolderBasePath(folderPathPattern);
		try {
			await this.ensureFolderExists(folderBasePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error creating folder: ${message}`);
			return;
		}

		// Build map of existing granola_id -> file (shared across all accounts).
		// Searched vault-wide: granola_id is ours, so a note moved out of the sync
		// folder is still recognized and updated rather than duplicated. Sync folder
		// first, so its copy wins if the same meeting exists in two places.
		const existingDocs = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		for (const file of syncFolderFirst(files, folderBasePath)) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			if (granolaId && !existingDocs.has(granolaId)) {
				existingDocs.set(granolaId, file);
			}
		}

		// Build map of email -> note title for attendee matching (shared)
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

		const ctx: SyncContext = {
			template,
			folderPathPattern,
			filenamePattern,
			existingDocs,
			emailToNoteTitle,
		};

		let created = 0;
		let updated = 0;
		let skipped = 0;
		let failedAccounts = 0;

		for (const account of connectedAccounts) {
			try {
				const result = await this.syncAccount(account, ctx);
				created += result.created;
				updated += result.updated;
				skipped += result.skipped;
			} catch (error) {
				failedAccounts++;
				console.error(`Granola: sync failed for account ${account.label ?? account.id}`, error);
			}
		}

		if (manual) {
			const accountSuffix = connectedAccounts.length > 1 ? ` across ${connectedAccounts.length} accounts` : "";
			let message: string;
			if (this.settings.skipExistingNotes) {
				message = `Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)${accountSuffix}`;
			} else {
				message = `Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}${accountSuffix}`;
			}
			if (failedAccounts > 0) {
				message += `. ${failedAccounts} account${failedAccounts !== 1 ? "s" : ""} failed — check console.`;
			}
			new Notice(message);
		}
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
				const { label, email } = parseAccountInfo(await mcp.getAccountInfo());
				if (label || email) {
					if (label) account.label = label;
					if (email) account.email = email;
					await this.savePluginData();
					this.refreshSettingsTab();
				}
			} catch (error) {
				console.error("Granola: failed to backfill account name", error);
			}
		}

		// List meetings
		let listResponse: string;
		try {
			listResponse = await mcp.listMeetings(
				this.settings.syncTimeRange,
				this.settings.onlyMyMeetings,
			);
		} catch (error) {
			// Disconnect so we retry connection next time
			await mcp.disconnect();
			throw error;
		}

		const listedMeetings = parseMeetingsResponse(listResponse);
		if (listedMeetings.length === 0) {
			return { created: 0, updated: 0, skipped: 0 };
		}

		// Filter to meetings that need syncing
		const meetingsToSync = listedMeetings.filter((m) => {
			if (this.settings.skipExistingNotes && ctx.existingDocs.has(m.id)) {
				return false;
			}
			return true;
		});

		const skipped = listedMeetings.length - meetingsToSync.length;
		if (meetingsToSync.length === 0) {
			return { created: 0, updated: 0, skipped };
		}

		// Batch fetch meeting details (max 10 per API call)
		const idsToFetch = meetingsToSync.map((m) => m.id);
		const allDetails = [];
		for (let i = 0; i < idsToFetch.length; i += 10) {
			const batch = idsToFetch.slice(i, i + 10);
			try {
				const detailsResponse = await mcp.getMeetings(batch);
				allDetails.push(...parseMeetingsResponse(detailsResponse));
			} catch (error) {
				console.error("Granola: getMeetings batch failed", error);
			}
		}

		let created = 0;
		let updated = 0;
		let transcriptFetches = 0;
		let lastTranscriptFetchAt = 0;
		let transcriptRateLimited = false;

		for (const details of allDetails) {
			try {
				// Skip meetings still in progress (no summary generated yet)
				if (!details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				const existingFile = ctx.existingDocs.get(details.id);

				// Reuse a valid stored transcript. Transcript calls are the expensive,
				// rate-limited part of the API and existing notes do not need to fetch
				// the same immutable transcript every 15 minutes.
				let transcript = "";
				if (this.settings.syncTranscripts) {
					if (existingFile) {
						transcript = extractStoredTranscript(await this.app.vault.read(existingFile));
					}

					if (
						!transcript &&
						!transcriptRateLimited &&
						transcriptFetches < MAX_TRANSCRIPT_FETCHES_PER_ACCOUNT_SYNC
					) {
						try {
							const elapsed = Date.now() - lastTranscriptFetchAt;
							if (lastTranscriptFetchAt && elapsed < TRANSCRIPT_FETCH_SPACING_MS) {
								await sleep(TRANSCRIPT_FETCH_SPACING_MS - elapsed);
							}
							lastTranscriptFetchAt = Date.now();
							transcriptFetches++;
							const transcriptResponse = await mcp.getTranscript(details.id);
							if (isTranscriptErrorResponse(transcriptResponse)) {
								transcriptRateLimited = true;
								throw new Error(`Granola returned a transient transcript error: ${transcriptResponse.trim()}`);
							}
							transcript = parseTranscriptResponse(transcriptResponse);
						} catch (error) {
							console.error(`Granola: transcript fetch failed for ${details.id}`, error);
							// Never replace an existing note with an API error or an empty
							// transcript. A later paced sync will retry it.
							if (existingFile) continue;
						}
					}

					// A rate limit or the per-sync request budget can leave later
					// meetings without a transcript fetch. Never let those meetings
					// fall through to a rewrite that removes their stored content.
					if (!transcript && existingFile) continue;
				}

				const meetingData = buildMeetingData(details, transcript);
				if (this.settings.excludeSelfFromAttendees && account.email) {
					meetingData.participants = excludeSelf(meetingData.participants, account.email);
				}
				const content = applyTemplate(ctx.template, meetingData, ctx.emailToNoteTitle);
				if (existingFile) {
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					const { folder, path } = resolveNotePath(
						ctx.folderPathPattern,
						ctx.filenamePattern,
						meetingData,
					);
					await this.ensureFolderExists(folder);
					const newFile = await this.app.vault.create(path, content);
					// Track so a meeting shared across accounts isn't created twice this run.
					ctx.existingDocs.set(details.id, newFile);
					created++;
				}
			} catch (error) {
				console.error(`Error syncing meeting ${details.id}:`, error);
			}
		}

		return { created, updated, skipped };
	}
}

interface SyncContext {
	template: string;
	folderPathPattern: string;
	filenamePattern: string;
	existingDocs: Map<string, TFile>;
	emailToNoteTitle: Map<string, string>;
}

interface SyncResult {
	created: number;
	updated: number;
	skipped: number;
}

function generateAccountId(): string {
	const cryptoObj = window.crypto as Crypto | undefined;
	if (cryptoObj?.randomUUID) {
		return cryptoObj.randomUUID();
	}
	return `acct-${Math.random().toString(36).slice(2)}`;
}
