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
	buildMeetingData,
} from "./response-parser";
import { loadTemplate, applyTemplate, generateFilename } from "./template";
import { resolveFolder } from "./routing";

interface PluginData extends GranolaSyncSettings {
	oauthTokens?: OAuthTokens;
	oauthClientInfo?: OAuthClientInformationMixed;
	autoSyncOnStartup?: boolean;
}

export default class GranolaSyncPlugin extends Plugin {
	settings: GranolaSyncSettings = DEFAULT_SETTINGS;
	private pluginData: PluginData = { ...DEFAULT_SETTINGS };
	private isSyncing = false;
	private syncIntervalId: number | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private authProvider!: GranolaAuthProvider;
	private mcpClient!: GranolaMcpClient;

	override async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize auth + MCP client
		const storage: AuthStorage = {
			getTokens: () => this.pluginData.oauthTokens,
			saveTokens: async (tokens) => {
				this.pluginData.oauthTokens = tokens;
				await this.savePluginData();
			},
			clearTokens: async () => {
				delete this.pluginData.oauthTokens;
				delete this.pluginData.oauthClientInfo;
				await this.savePluginData();
			},
			getClientInfo: () => this.pluginData.oauthClientInfo,
			saveClientInfo: async (info) => {
				this.pluginData.oauthClientInfo = info;
				await this.savePluginData();
			},
		};
		this.authProvider = new GranolaAuthProvider(storage);
		this.mcpClient = new GranolaMcpClient(this.authProvider);

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
		void this.mcpClient.disconnect();
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

	isAuthenticated(): boolean {
		return this.pluginData.oauthTokens !== undefined;
	}

	async connectAccount(): Promise<void> {
		try {
			await this.mcpClient.connect();
			new Notice("Connected to Granola!");
		} catch {
			// Auth redirect likely happened — user will complete in browser
			new Notice("Opening Granola login in your browser...");
		}
	}

	async disconnectAccount(): Promise<void> {
		await this.mcpClient.disconnect();
		delete this.pluginData.oauthTokens;
		delete this.pluginData.oauthClientInfo;
		await this.savePluginData();
		new Notice("Disconnected from Granola");
	}

	private async handleAuthCallback(code: string): Promise<void> {
		try {
			await this.mcpClient.finishAuth(code);
			new Notice("Successfully connected to Granola!");

			// Refresh settings tab if open
			const appWithSetting = this.app as typeof this.app & {
				setting: { activeTab?: { display?: () => void } };
			};
			appWithSetting.setting.activeTab?.display?.();
		} catch (error) {
			console.error("Granola auth callback failed:", error);
			new Notice("Failed to connect to Granola. Please try again.");
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PluginData> | null;
		this.pluginData = { ...DEFAULT_SETTINGS, ...data };
		this.settings = { ...DEFAULT_SETTINGS, ...data };

		// Migrate old autoSyncOnStartup setting
		if (data?.autoSyncOnStartup !== undefined && !data.syncFrequency) {
			this.settings.syncFrequency = data.autoSyncOnStartup ? "startup" : "manual";
		}
	}

	async saveSettings(): Promise<void> {
		Object.assign(this.pluginData, this.settings);
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		await this.saveData(this.pluginData);
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized || normalized === "/" || normalized === ".") return;
		if (this.app.vault.getAbstractFileByPath(normalized)) return;
		try {
			await this.app.vault.createFolder(normalized);
		} catch (error) {
			// Folder may have been created concurrently; only re-throw if it still doesn't exist.
			if (!this.app.vault.getAbstractFileByPath(normalized)) throw error;
		}
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
		if (!this.isAuthenticated()) {
			if (manual) {
				new Notice("Please connect your Granola account first in plugin settings");
			}
			return;
		}

		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		// Connect to MCP if needed
		if (!this.mcpClient.isConnected) {
			try {
				await this.mcpClient.connect();
			} catch (error) {
				if (manual) {
					new Notice("Failed to connect to Granola. Please re-authenticate in settings.");
				}
				console.error("Granola: connect failed", error);
				return;
			}
		}

		// List meetings
		let listResponse: string;
		try {
			listResponse = await this.mcpClient.listMeetings(this.settings.syncTimeRange);
		} catch (error) {
			if (manual) new Notice("Failed to fetch meetings from Granola");
			console.error("Granola: listMeetings failed", error);
			// Disconnect so we retry connection next time
			await this.mcpClient.disconnect();
			return;
		}

		const listedMeetings = parseMeetingsResponse(listResponse);
		if (listedMeetings.length === 0) {
			if (manual) new Notice("No meetings found in Granola");
			return;
		}

		// Load template
		let template: string;
		try {
			template = await loadTemplate(this.app, templatePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Error loading template: ${message}`);
			return;
		}

		const folderPath = normalizePath(folderPathSetting);

		// Build map of existing granola_id -> file (scan whole vault so we find
		// notes even if a routing rule has changed their destination folder).
		const existingDocs = new Map<string, TFile>();
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const fileCache = this.app.metadataCache.getFileCache(file);
			const granolaId = fileCache?.frontmatter?.granola_id as string | undefined;
			if (granolaId) {
				existingDocs.set(granolaId, file);
			}
		}

		// Filter to meetings that need syncing
		const meetingsToSync = listedMeetings.filter((m) => {
			if (this.settings.skipExistingNotes && existingDocs.has(m.id)) {
				return false;
			}
			return true;
		});

		if (meetingsToSync.length === 0) {
			if (manual) {
				new Notice(`All ${listedMeetings.length} meetings already synced`);
			}
			return;
		}

		// Build map of email -> note title for attendee matching
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

		// Batch fetch meeting details (max 10 per API call)
		const idsToFetch = meetingsToSync.map((m) => m.id);
		const allDetails = [];

		for (let i = 0; i < idsToFetch.length; i += 10) {
			const batch = idsToFetch.slice(i, i + 10);
			try {
				const detailsResponse = await this.mcpClient.getMeetings(batch);
				allDetails.push(...parseMeetingsResponse(detailsResponse));
			} catch (error) {
				console.error("Granola: getMeetings batch failed", error);
			}
		}

		let created = 0;
		let updated = 0;
		const skipped = listedMeetings.length - meetingsToSync.length;

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
						const transcriptResponse = await this.mcpClient.getTranscript(details.id);
						transcript = parseTranscriptResponse(transcriptResponse);
					} catch (error) {
						console.error(`Granola: transcript fetch failed for ${details.id}`, error);
					}
				}

				const meetingData = buildMeetingData(details, transcript);
				const content = applyTemplate(template, meetingData, emailToNoteTitle);
				const existingFile = existingDocs.get(details.id);

				if (existingFile) {
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					const destFolder = normalizePath(
						resolveFolder(meetingData, this.settings.routingRules, folderPath),
					);
					await this.ensureFolder(destFolder);
					const filename = generateFilename(filenamePattern, meetingData);
					const filePath = normalizePath(`${destFolder}/${filename}.md`);
					await this.app.vault.create(filePath, content);
					created++;
				}
			} catch (error) {
				console.error(`Error syncing meeting ${details.id}:`, error);
			}
		}

		if (manual) {
			if (this.settings.skipExistingNotes) {
				new Notice(`Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)`);
			} else {
				new Notice(`Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}`);
			}
		}
	}
}
