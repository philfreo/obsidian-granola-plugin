import { App, PluginSettingTab, Setting } from "obsidian";
import type GranolaSyncPlugin from "./main";

export interface GranolaSyncSettings {
	folderPath: string;
	filenamePattern: string;
	templatePath: string;
	autoSyncOnStartup: boolean;
	skipExistingNotes: boolean;
	matchAttendeesByEmail: boolean;
}

export const DEFAULT_SETTINGS: GranolaSyncSettings = {
	folderPath: "Meetings",
	filenamePattern: "{date} {title}",
	templatePath: "Templates/Granola.md",
	autoSyncOnStartup: false,
	skipExistingNotes: true,
	matchAttendeesByEmail: true,
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

		new Setting(containerEl)
			.setName("Folder path")
			.setDesc("Where to save meeting notes in your vault")
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
			.setName("Auto sync on startup")
			.setDesc("Automatically sync meetings when Obsidian opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Skip existing notes")
			.setDesc(
				"When enabled, existing notes won't be overwritten. This allows you to make local edits without them being replaced on sync. Disable to update notes when Granola data changes."
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
