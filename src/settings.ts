import { App, PluginSettingTab, Setting } from "obsidian";
import type GranolaSyncPlugin from "./main";
import type { SyncTimeRange } from "./mcp-client";

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
};

export interface GranolaSyncSettings {
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	syncFrequency: SyncFrequency;
	showRibbonIcon: boolean;
	skipExistingNotes: boolean;
	matchAttendeesByEmail: boolean;
	syncTimeRange: SyncTimeRange;
	syncTranscripts: boolean;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	syncFrequency: "15m",
	showRibbonIcon: true,
	skipExistingNotes: true,
	matchAttendeesByEmail: true,
	syncTimeRange: "last_30_days",
	syncTranscripts: false,
};

export class GranolaSyncSettingTab extends PluginSettingTab {
	plugin: GranolaSyncPlugin;

	constructor(app: App, plugin: GranolaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Granola account section ---
		new Setting(containerEl).setName("Granola account").setHeading();

		if (this.plugin.isAuthenticated()) {
			new Setting(containerEl)
				.setName("Connected to Granola")
				.setDesc("Your account is connected and ready to sync.")
				.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.plugin.disconnectAccount();
							this.display();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Not connected")
				.setDesc("Connect your Granola account to sync meetings via the official API.")
				.addButton((button) =>
					button
						.setButtonText("Connect to Granola")
						.setCta()
						.onClick(() => {
							void this.plugin.connectAccount();
						})
				);
		}

		// --- Sync section ---
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Manually sync meetings from Granola")
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => {
						void this.plugin.syncMeetings(true);
					})
			);

		new Setting(containerEl)
			.setName("Time range")
			.setDesc("How far back to look for meetings when syncing")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(SYNC_TIME_RANGE_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.syncTimeRange)
					.onChange(async (value) => {
						this.plugin.settings.syncTimeRange = value as SyncTimeRange;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Sync frequency")
			.setDesc("How often to automatically sync meetings from Granola")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(SYNC_FREQUENCY_OPTIONS)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.plugin.settings.syncFrequency)
					.onChange(async (value) => {
						this.plugin.settings.syncFrequency = value as SyncFrequency;
						await this.plugin.saveSettings();
						this.plugin.setupSyncInterval();
					});
			});

		new Setting(containerEl)
			.setName("Sync transcripts")
			.setDesc(
				"Include full meeting transcripts. Each meeting requires an extra API call."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncTranscripts)
					.onChange(async (value) => {
						this.plugin.settings.syncTranscripts = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Notes section ---
		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Folder path")
			.setDesc(
				"Where to save meeting notes in your vault. " +
				"Use date tokens to organize by date: {yyyy}, {yy}, {MM}, {M}, {MMMM}, {MMM}, {dd}, {d}. " +
				"Example: Meetings/{yyyy}/{MM}"
			)
			.addText((text) =>
				text
					.setPlaceholder("Meetings")
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.folderPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Filename pattern")
			.setDesc("Pattern for note filenames. Available: {date}, {title}, {id}")
			.addText((text) =>
				text
					.setPlaceholder("{date} {title}")
					.setValue(this.plugin.settings.filenamePattern)
					.onChange(async (value) => {
						this.plugin.settings.filenamePattern = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Template path")
			.setDesc("Path to template file in your vault")
			.addText((text) =>
				text
					.setPlaceholder("Templates/granola-meeting.md")
					.setValue(this.plugin.settings.templatePath)
					.onChange(async (value) => {
						this.plugin.settings.templatePath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show ribbon icon")
			.setDesc("Show a sync button in the left ribbon")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						this.plugin.updateRibbonIcon();
					})
			);

		new Setting(containerEl)
			.setName("Skip existing notes")
			.setDesc(
				"When enabled, existing notes won't be overwritten. Disable to update notes when Granola data changes."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipExistingNotes)
					.onChange(async (value) => {
						this.plugin.settings.skipExistingNotes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Match attendees by email")
			.setDesc(
				"Link attendees to existing notes that have a matching email in their 'emails' frontmatter property."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.matchAttendeesByEmail)
					.onChange(async (value) => {
						this.plugin.settings.matchAttendeesByEmail = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
