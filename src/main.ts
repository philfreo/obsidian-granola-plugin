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
import {
	parseMeetingsResponse,
	parseTranscriptResponse,
	parseAccountInfo,
	buildMeetingData,
} from "./response-parser";
import { loadTemplate, applyTemplate, generateFilename } from "./template";

export interface GranolaAccount {
	id: string;
	label?: string;
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
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
	private runtimes = new Map<string, AccountRuntime>();
	private pendingAuthAccountId: string | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();

		// Register OAuth callback handler
		this.registerObsidianProtocolHandler("granola-auth", (params) => {
			const code = params.code;
			if (code) {
				void this.handleAuthCallback(code);
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
		this.addSettingTab(new GranolaSyncSettingTab(this.app, this));

		// Handle startup sync and intervals
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.syncFrequency !== "manual") {
				void this.syncMeetings();
			}
			this.setupSyncInterval();
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
		const auth = new GranolaAuthProvider(storage);
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

	private async handleAuthCallback(code: string): Promise<void> {
		const accountId = this.pendingAuthAccountId;
		const account = accountId ? this.findAccount(accountId) : undefined;
		if (!account) {
			console.error("Granola: auth callback with no pending account");
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
		try {
			if (!mcp.isConnected) await mcp.connect();
			const label = parseAccountInfo(await mcp.getAccountInfo());
			if (label) account.label = label;
		} catch (error) {
			console.error("Granola: failed to fetch account info", error);
		}
		await this.savePluginData();
	}

	private refreshSettingsTab(): void {
		const appWithSetting = this.app as typeof this.app & {
			setting: { activeTab?: { display?: () => void } };
		};
		appWithSetting.setting.activeTab?.display?.();
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

		// Ensure folder exists
		const folderPath = normalizePath(folderPathSetting);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			try {
				await this.app.vault.createFolder(folderPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				new Notice(`Error creating folder: ${message}`);
				return;
			}
		}

		// Build map of existing granola_id -> file (shared across all accounts)
		const existingDocs = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		const folderPrefix = folderPath + "/";
		for (const file of files) {
			if (!file.path.startsWith(folderPrefix)) continue;
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			if (granolaId) {
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
			folderPath,
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

	/** Sync a single account into the shared folder, mutating ctx.existingDocs. */
	private async syncAccount(account: GranolaAccount, ctx: SyncContext): Promise<SyncResult> {
		const { mcp } = this.getRuntime(account);

		if (!mcp.isConnected) {
			await mcp.connect();
		}

		// List meetings
		let listResponse: string;
		try {
			listResponse = await mcp.listMeetings(this.settings.syncTimeRange);
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

		for (const details of allDetails) {
			try {
				// Skip meetings still in progress (no summary generated yet)
				if (!details.summary.trim() || details.summary.trim() === "No summary") {
					continue;
				}

				// Optionally fetch transcript
				let transcript = "";
				if (this.settings.syncTranscripts) {
					try {
						const transcriptResponse = await mcp.getTranscript(details.id);
						transcript = parseTranscriptResponse(transcriptResponse);
					} catch (error) {
						console.error(`Granola: transcript fetch failed for ${details.id}`, error);
					}
				}

				const meetingData = buildMeetingData(details, transcript);
				const content = applyTemplate(ctx.template, meetingData, ctx.emailToNoteTitle);
				const existingFile = ctx.existingDocs.get(details.id);

				if (existingFile) {
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					const filename = generateFilename(ctx.filenamePattern, meetingData);
					const filePath = normalizePath(`${ctx.folderPath}/${filename}.md`);
					const newFile = await this.app.vault.create(filePath, content);
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
	folderPath: string;
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
