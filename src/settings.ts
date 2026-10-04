import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type GranolaSyncPlugin from "./main";
import type { GranolaAccount } from "./main";
import type { SyncTimeRange } from "./mcp-client";
import { formatProgressMessage, type SyncProgressState } from "./sync-progress";

export type SyncFrequency = "manual" | "startup" | "1m" | "15m" | "30m" | "60m" | "12h";

export const SYNC_FREQUENCY_OPTIONS: Record<SyncFrequency, string> = {
	manual: "Manual only (command palette)",
	startup: "Sync on startup only",
	"1m": "Every 1 minute",
	"15m": "Every 15 minutes",
	"30m": "Every 30 minutes",
	"60m": "Every 60 minutes",
	"12h": "Every 12 hours",
};

export const SYNC_FREQUENCY_MS: Record<SyncFrequency, number | null> = {
	manual: null,
	startup: null,
	"1m": 60 * 1000,
	"15m": 15 * 60 * 1000,
	"30m": 30 * 60 * 1000,
	"60m": 60 * 60 * 1000,
	"12h": 12 * 60 * 60 * 1000,
};

const SYNC_TIME_RANGE_OPTIONS: Record<SyncTimeRange, string> = {
	this_week: "This week",
	last_week: "Last week",
	last_30_days: "Last 30 days",
	last_90_days: "Last 90 days",
	last_180_days: "Last 180 days",
	last_1_year: "Last 1 year",
	all_time: "All time",
};

export interface GranolaSyncSettings {
	// Sync
	syncTimeRange: SyncTimeRange;
	onlyMyMeetings: boolean;
	syncFrequency: SyncFrequency;
	showRibbonIcon: boolean;

	// Attendees (Shared)
	excludeSelfFromAttendees: boolean;
	matchAttendeesByEmail: boolean;

	// Notes
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	updateNoteContent: boolean;
	rerouteExistingNotes: boolean;

	// Transcripts
	syncTranscripts: boolean;
	transcriptFolder: string;
	transcriptFilenamePattern: string;
	transcriptTemplatePath: string;
	updateTranscriptContent: boolean;
	rerouteExistingTranscripts: boolean;

	// Folders & Indexing
	generateFolderIndexNotes: boolean;
	folderIndexFolder: string;

	// Legacy backwards-compatibility
	skipExistingNotes?: boolean;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	syncTimeRange: "last_30_days",
	onlyMyMeetings: true,
	syncFrequency: "15m",
	showRibbonIcon: true,

	excludeSelfFromAttendees: true,
	matchAttendeesByEmail: true,

	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	skipExistingNotes: false,
	updateNoteContent: true,
	rerouteExistingNotes: false,

	syncTranscripts: false,
	transcriptFolder: "{meeting_folder}/Transcripts",
	transcriptFilenamePattern: "{filename} (Transcript)",
	transcriptTemplatePath: "Templates/Granola Transcript.md",
	updateTranscriptContent: true,
	rerouteExistingTranscripts: false,

	generateFolderIndexNotes: false,
	folderIndexFolder: "Meetings/Folders",
};

/**
 * Migrate legacy settings to current format while preserving user configuration.
 */
export function migrateSettings(raw: Partial<GranolaSyncSettings>): GranolaSyncSettings {
	const settings: GranolaSyncSettings = { ...DEFAULT_SETTINGS, ...raw };

	if (raw.updateNoteContent === undefined && raw.skipExistingNotes !== undefined) {
		settings.updateNoteContent = !raw.skipExistingNotes;
		settings.rerouteExistingNotes = false;
	}
	if (raw.updateTranscriptContent === undefined && raw.skipExistingNotes !== undefined) {
		settings.updateTranscriptContent = !raw.skipExistingNotes;
		settings.rerouteExistingTranscripts = false;
	}

	return settings;
}

type SettingKey = keyof GranolaSyncSettings;

export class GranolaSyncSettingTab extends PluginSettingTab {
	plugin: GranolaSyncPlugin;
	private unbindProgress: (() => void) | null = null;
	private unbindCacheProgress: (() => void) | null = null;

	constructor(app: App, plugin: GranolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override hide(): void {
		super.hide();
		if (this.unbindProgress) {
			this.unbindProgress();
			this.unbindProgress = null;
		}
		if (this.unbindCacheProgress) {
			this.unbindCacheProgress();
			this.unbindCacheProgress = null;
		}
	}

	override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			this.accountsList(),
			this.syncGroup(),
			this.cacheGroup(),
			this.attendeesGroup(),
			this.notesGroup(),
			this.transcriptsGroup(),
			this.foldersGroup(),
		];
	}

	/**
	 * Persist through the plugin rather than the inherited default, which writes
	 * `plugin.settings` straight to data.json — that file also carries the stored
	 * OAuth accounts, so a direct write would drop them and force a re-login.
	 * Settings whose value drives live state apply it here too.
	 */
	override async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, { [key]: value });
		await this.plugin.saveSettings();

		if (key === "syncFrequency") this.plugin.setupSyncInterval();
		if (key === "showRibbonIcon") this.plugin.updateRibbonIcon();
	}

	private accountsList(): SettingDefinitionItem<SettingKey> {
		const connected = this.plugin.accounts.filter((a) => a.oauthTokens !== undefined);

		return {
			type: "list",
			heading: "Granola accounts",
			addItem: {
				name: "Add Granola account",
				action: () => void this.plugin.addAccount(),
			},
			items:
				connected.length === 0
					? [this.connectPrompt()]
					: connected.map((account) => this.accountRow(account)),
		};
	}

	private connectPrompt(): SettingGroupItem<SettingKey> {
		return {
			name: "Not connected",
			desc: "Connect a Granola account to sync meetings via the official API.",
			aliases: ["sign in", "log in", "oauth"],
			render: (setting) => {
				setting.addButton((button) =>
					button
						.setButtonText("Connect to Granola")
						.setCta()
						.onClick(() => void this.plugin.addAccount()),
				);
			},
		};
	}

	private accountRow(account: GranolaAccount): SettingGroupItem<SettingKey> {
		return {
			name: account.label || "Connected account",
			desc: account.needsReauth
				? "Reconnection required — your login expired. Sign in again to resume syncing."
				: account.label
					? "Connected and ready to sync."
					: "Connected. (Account name unavailable.)",
			aliases: ["granola account", "disconnect", "reconnect", "sign out"],
			render: (setting) => {
				if (account.needsReauth) {
					setting.addButton((button) =>
						button
							.setButtonText("Reconnect")
							.setCta()
							.onClick(() => void this.plugin.reconnectAccount(account.id)),
					);
				}

				setting.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setDestructive()
						.onClick(async () => {
							await this.plugin.disconnectAccount(account.id);
							this.update();
						}),
				);
			},
		};
	}

	private syncGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Sync",
			items: [
				{
					name: "Sync now",
					desc: "Manually sync meetings from Granola",
					render: (setting) => {
						const progressContainer = setting.controlEl.createDiv({
							cls: "granola-sync-progress-container",
						});

						const buttonRow = progressContainer.createDiv();
						const statusRow = progressContainer.createDiv({
							cls: "granola-sync-status-text",
						});
						statusRow.hide();

						const progressBar = progressContainer.createEl("progress", {
							cls: "granola-sync-progress-bar",
						});
						progressBar.hide();

						let actionButton: ButtonComponent | null = null;

						const updateUI = (state: SyncProgressState) => {
							if (!actionButton) return;
							const isSyncing = this.plugin.isSyncActive || state.phase !== "idle";

							if (isSyncing) {
								actionButton.setButtonText(
									state.phase === "stopping" ? "Stopping..." : "Stop sync",
								);
								actionButton.buttonEl.classList.remove("mod-cta");
								actionButton.setDestructive();
								actionButton.setDisabled(state.phase === "stopping");

								statusRow.setText(formatProgressMessage(state));
								statusRow.show();

								if (
									state.total > 0 &&
									(state.phase === "meetings" || state.phase === "transcripts")
								) {
									progressBar.max = state.total;
									progressBar.value = state.current;
									progressBar.show();
								} else {
									progressBar.hide();
								}
							} else {
								actionButton.setButtonText("Sync now");
								actionButton.buttonEl.classList.remove("mod-warning", "mod-destructive");
								actionButton.setCta();
								actionButton.setDisabled(false);

								statusRow.setText("");
								statusRow.hide();
								progressBar.hide();
							}
						};

						setting.addButton((button) => {
							actionButton = button;
							buttonRow.appendChild(button.buttonEl);
							button.onClick(() => {
								if (this.plugin.isSyncActive) {
									this.plugin.cancelSync();
								} else {
									void this.plugin.syncMeetings(true);
								}
							});
							updateUI(this.plugin.currentSyncProgress);
						});

						if (this.unbindProgress) {
							this.unbindProgress();
						}
						this.unbindProgress = this.plugin.onProgress((state) => {
							updateUI(state);
						});
					},
				},
				{
					name: "Time range",
					desc: "How far back to look for meetings when syncing. Note: Granola Free plans only allow querying notes from the last 30 days.",
					control: {
						type: "dropdown",
						key: "syncTimeRange",
						options: SYNC_TIME_RANGE_OPTIONS,
						defaultValue: DEFAULT_SETTINGS.syncTimeRange,
					},
				},
				{
					name: "Only my meetings",
					desc: "Sync only meetings you recorded or were listed as a participant in, including notes shared with you. Disable to also sync every workspace-visible meeting.",
					control: {
						type: "toggle",
						key: "onlyMyMeetings",
						defaultValue: DEFAULT_SETTINGS.onlyMyMeetings,
					},
				},
				{
					name: "Advanced sync options",
					desc: "Schedule and UI display settings",
					render: (setting) => {
						setting.infoEl.remove();
						const details = setting.settingEl.createEl("details", {
							cls: "granola-collapsible-details",
						});
						details.createEl("summary", {
							text: "Advanced sync options",
							cls: "granola-collapsible-summary",
						});

						new Setting(details)
							.setName("Sync frequency")
							.setDesc("How often to automatically sync meetings from Granola")
							.addDropdown((dropdown) => {
								for (const [key, label] of Object.entries(SYNC_FREQUENCY_OPTIONS)) {
									dropdown.addOption(key, label);
								}
								dropdown.setValue(this.plugin.settings.syncFrequency);
								dropdown.onChange(async (val) => {
									await this.setControlValue("syncFrequency", val);
								});
							});

						new Setting(details)
							.setName("Show ribbon icon")
							.setDesc("Show a sync button in the left ribbon")
							.addToggle((toggle) => {
								toggle.setValue(this.plugin.settings.showRibbonIcon);
								toggle.onChange(async (val) => {
									await this.setControlValue("showRibbonIcon", val);
								});
							});
					},
				},
			],
		};
	}

	private cacheGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Cache",
			items: [
				{
					name: "Local cache status",
					desc: "Raw meetings and transcripts cached on disk.",
					render: (setting) => {
						const statusEl = setting.controlEl.createSpan({
							cls: "granola-cache-status-text",
						});
						const refreshStatus = () => {
							void this.plugin.cacheStore.getStats().then((stats) => {
								statusEl.setText(
									`${stats.meetingCount} meeting${stats.meetingCount !== 1 ? "s" : ""}, ${stats.transcriptCount} transcript${stats.transcriptCount !== 1 ? "s" : ""}`,
								);
							});
						};
						refreshStatus();

						if (this.unbindCacheProgress) {
							this.unbindCacheProgress();
						}
						this.unbindCacheProgress = this.plugin.onProgress((state) => {
							if (
								state.phase === "idle" ||
								state.phase === "meetings" ||
								(state.phase === "transcripts" && state.countdownSeconds === undefined)
							) {
								refreshStatus();
							}
						});
					},
				},
				{
					name: "Clear local cache",
					desc: "Delete all locally cached meetings and transcripts. Future syncs will re-download them from Granola.",
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText("Clear cache")
								.setDestructive()
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Clearing...");
									try {
										await this.plugin.clearCache();
										this.update();
									} finally {
										button.setDisabled(false);
										button.setButtonText("Clear cache");
									}
								}),
						);
					},
				},
			],
		};
	}

	private attendeesGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Attendees",
			items: [
				{
					name: "Exclude yourself from attendees",
					desc: "Leave your own Granola account out of the attendee list, since you are listed on every meeting you take part in.",
					control: {
						type: "toggle",
						key: "excludeSelfFromAttendees",
						defaultValue: DEFAULT_SETTINGS.excludeSelfFromAttendees,
					},
				},
				{
					name: "Match attendees by email",
					desc: "Link attendees to existing notes that have a matching email in their 'emails' frontmatter property.",
					control: {
						type: "toggle",
						key: "matchAttendeesByEmail",
						defaultValue: DEFAULT_SETTINGS.matchAttendeesByEmail,
					},
				},
			],
		};
	}

	private notesGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Notes",
			items: [
				{
					name: "Folder path",
					desc: "Where to save meeting notes. Supports {granolaFolder}, {date}, {date:YYYY/MM}, {title}, {id}.",
					control: {
						type: "text",
						key: "folderPath",
						placeholder: "Meetings",
						defaultValue: DEFAULT_SETTINGS.folderPath,
					},
				},
				{
					name: "Filename pattern",
					desc: "Pattern for note filenames. Available: {date}, {meeting_date}, {date:YYYY-MM-DD}, {title}, {meeting_name}, {id}, {granolaFolder}",
					control: {
						type: "text",
						key: "filenamePattern",
						placeholder: "{date} {title}",
						defaultValue: DEFAULT_SETTINGS.filenamePattern,
						validate: (value) =>
							value.trim() ? undefined : "Enter a pattern — notes need a filename.",
					},
				},
				{
					name: "Template path",
					desc: "Path to template file in your vault. A default one is created when the plugin is first enabled.",
					control: {
						type: "file",
						key: "templatePath",
						placeholder: DEFAULT_SETTINGS.templatePath,
						defaultValue: DEFAULT_SETTINGS.templatePath,
						filter: (file) => file.extension === "md",
					},
				},
				{
					name: "Update note content on sync",
					desc: "When enabled, re-renders and updates existing notes in your vault with fresh summary and private notes from Granola. Disable to preserve manual note edits.",
					control: {
						type: "toggle",
						key: "updateNoteContent",
						defaultValue: DEFAULT_SETTINGS.updateNoteContent,
					},
				},
				{
					name: "Re-route notes on sync",
					desc: "When enabled, moves and renames existing notes if their folder or filename differs from the current pattern. Disable if you manually move notes into custom folders.",
					control: {
						type: "toggle",
						key: "rerouteExistingNotes",
						defaultValue: DEFAULT_SETTINGS.rerouteExistingNotes,
					},
				},
				{
					name: "Manual note actions",
					desc: "Refresh summaries from Granola, re-render content, or re-route existing meeting notes in your vault.",
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText("Refresh summaries")
								.setCta()
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Refreshing...");
									try {
										await this.plugin.refreshMeetingSummaries(true);
									} finally {
										button.setDisabled(false);
										button.setButtonText("Refresh summaries");
									}
								}),
						);
						setting.addButton((button) =>
							button
								.setButtonText("Re-render notes")
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Re-rendering...");
									try {
										await this.plugin.reRenderAllNotesFromCache();
									} finally {
										button.setDisabled(false);
										button.setButtonText("Re-render notes");
									}
								}),
						);
						setting.addButton((button) =>
							button
								.setButtonText("Re-route notes")
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Re-routing...");
									try {
										await this.plugin.reRouteAllNotes();
									} finally {
										button.setDisabled(false);
										button.setButtonText("Re-route notes");
									}
								}),
						);
					},
				},
			],
		};
	}

	private transcriptsGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Transcripts",
			items: [
				{
					name: "Sync transcripts",
					desc: "Include full meeting transcripts saved as separate linked documents. Each transcript requires a paced API call (~65s spacing).",
					control: {
						type: "toggle",
						key: "syncTranscripts",
						defaultValue: DEFAULT_SETTINGS.syncTranscripts,
					},
				},
				{
					name: "Transcript folder",
					desc: "Where to save transcript notes. Supports {meeting_folder}, {date}, {granolaFolder}. Default saves in a Transcripts/ subfolder alongside the meeting note.",
					control: {
						type: "text",
						key: "transcriptFolder",
						placeholder: DEFAULT_SETTINGS.transcriptFolder,
						defaultValue: DEFAULT_SETTINGS.transcriptFolder,
					},
				},
				{
					name: "Transcript filename pattern",
					desc: "Pattern for transcript note filenames. Supports {filename}, {meeting_filename}, {title}, {date}, {id}.",
					control: {
						type: "text",
						key: "transcriptFilenamePattern",
						placeholder: DEFAULT_SETTINGS.transcriptFilenamePattern,
						defaultValue: DEFAULT_SETTINGS.transcriptFilenamePattern,
						validate: (value) =>
							value.trim() ? undefined : "Enter a pattern — transcripts need a filename.",
					},
				},
				{
					name: "Transcript template path",
					desc: "Path to transcript template file in your vault.",
					control: {
						type: "file",
						key: "transcriptTemplatePath",
						placeholder: DEFAULT_SETTINGS.transcriptTemplatePath,
						defaultValue: DEFAULT_SETTINGS.transcriptTemplatePath,
						filter: (file) => file.extension === "md",
					},
				},
				{
					name: "Update transcript content on sync",
					desc: "When enabled, re-renders existing transcript files in your vault using current templates and cached data.",
					control: {
						type: "toggle",
						key: "updateTranscriptContent",
						defaultValue: DEFAULT_SETTINGS.updateTranscriptContent,
					},
				},
				{
					name: "Re-route transcripts on sync",
					desc: "When enabled, moves and renames existing transcript files if their folder or filename differs from the current pattern.",
					control: {
						type: "toggle",
						key: "rerouteExistingTranscripts",
						defaultValue: DEFAULT_SETTINGS.rerouteExistingTranscripts,
					},
				},
				{
					name: "Manual transcript actions",
					desc: "Re-render content or re-route existing transcript notes in your vault from cached data.",
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText("Re-render transcripts")
								.setCta()
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Re-rendering...");
									try {
										await this.plugin.reRenderAllTranscriptsFromCache();
									} finally {
										button.setDisabled(false);
										button.setButtonText("Re-render transcripts");
									}
								}),
						);
						setting.addButton((button) =>
							button
								.setButtonText("Re-route transcripts")
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Re-routing...");
									try {
										await this.plugin.reRouteAllTranscripts();
									} finally {
										button.setDisabled(false);
										button.setButtonText("Re-route transcripts");
									}
								}),
						);
					},
				},
			],
		};
	}

	private foldersGroup(): SettingDefinitionItem<SettingKey> {
		return {
			type: "group",
			heading: "Folders & Indexing",
			items: [
				{
					name: "Generate folder index notes",
					desc: "Create and update an index note (Map of Content) for each Granola folder. Manual user notes outside the generated list section are preserved.",
					control: {
						type: "toggle",
						key: "generateFolderIndexNotes",
						defaultValue: DEFAULT_SETTINGS.generateFolderIndexNotes,
					},
				},
				{
					name: "Folder index location",
					desc: "Where to save Granola folder index notes in your vault.",
					control: {
						type: "text",
						key: "folderIndexFolder",
						placeholder: DEFAULT_SETTINGS.folderIndexFolder,
						defaultValue: DEFAULT_SETTINGS.folderIndexFolder,
					},
				},
				{
					name: "Update folder index notes now",
					desc: "Generate or update all folder index notes in your vault from cached meetings.",
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText("Update folder indices")
								.onClick(async () => {
									button.setDisabled(true);
									button.setButtonText("Updating...");
									try {
										await this.plugin.updateFolderIndexNotes(true);
									} finally {
										button.setDisabled(false);
										button.setButtonText("Update folder indices");
									}
								}),
						);
					},
				},
			],
		};
	}
}
