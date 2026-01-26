import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
	GranolaSyncSettings,
	DEFAULT_SETTINGS,
	GranolaSyncSettingTab,
} from "./settings";
import {
	readGranolaCache,
	getCurrentUserId,
	GranolaCache,
} from "./granola";
import { loadTemplate, applyTemplate, generateFilename } from "./template";

export default class GranolaSyncPlugin extends Plugin {
	settings: GranolaSyncSettings = DEFAULT_SETTINGS;
	private isSyncing = false;

	override async onload(): Promise<void> {
		await this.loadSettings();

		// Add ribbon icon
		this.addRibbonIcon("refresh-cw", "Sync Granola meetings", () => {
			void this.syncMeetings();
		});

		// Add commands
		this.addCommand({
			id: "sync-meetings",
			name: "Sync meetings",
			callback: () => void this.syncMeetings(),
		});

		this.addCommand({
			id: "open-settings",
			name: "Open settings",
			callback: () => {
				// Access the settings modal through the app
				const appWithSetting = this.app as typeof this.app & {
					setting: { open: () => void; openTabById: (id: string) => void };
				};
				appWithSetting.setting.open();
				appWithSetting.setting.openTabById(this.manifest.id);
			},
		});

		// Add settings tab
		this.addSettingTab(new GranolaSyncSettingTab(this.app, this));

		// Auto sync on startup if enabled
		if (this.settings.autoSyncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.syncMeetings();
			});
		}
	}

	override onunload(): void {
		// Nothing to clean up
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<GranolaSyncSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async syncMeetings(): Promise<void> {
		if (this.isSyncing) return;
		this.isSyncing = true;

		try {
			await this.doSync();
		} finally {
			this.isSyncing = false;
		}
	}

	private async doSync(): Promise<void> {
		new Notice("Syncing Granola meetings...");

		// Use defaults for empty settings
		const folderPathSetting = this.settings.folderPath || DEFAULT_SETTINGS.folderPath;
		const templatePath = this.settings.templatePath || DEFAULT_SETTINGS.templatePath;
		const filenamePattern = this.settings.filenamePattern || DEFAULT_SETTINGS.filenamePattern;

		// Read Granola cache
		const cache = readGranolaCache();
		if (!cache) {
			new Notice("Granola not installed or no meetings found");
			return;
		}

		const currentUserId = getCurrentUserId();

		// Filter documents for current user, excluding deleted
		const documents = Object.values(cache.documents).filter(
			(doc) =>
				(!currentUserId || doc.user_id === currentUserId) &&
				!doc.deleted_at
		);

		if (documents.length === 0) {
			new Notice("No meetings found in Granola");
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

		// Build map of existing granola_id -> file
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

		// Build map of email -> note title for attendee matching
		const emailToNoteTitle = new Map<string, string>();
		if (this.settings.matchAttendeesByEmail) {
			for (const file of files) {
				const fileCache = this.app.metadataCache.getFileCache(file);
				// Frontmatter values have unknown type
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const emails = fileCache?.frontmatter?.emails;
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

		let created = 0;
		let updated = 0;
		let skipped = 0;

		for (const doc of documents) {
			try {
				const existingFile = existingDocs.get(doc.id);

				if (existingFile) {
					if (this.settings.skipExistingNotes) {
						skipped++;
						continue;
					}

					// Check if Granola data is newer
					const fileCache = this.app.metadataCache.getFileCache(existingFile);
					const existingUpdated = fileCache?.frontmatter?.updated as string | undefined;
					if (existingUpdated && existingUpdated >= doc.updated_at) {
						skipped++;
						continue;
					}

					// Update existing file
					const content = this.renderDocument(doc.id, cache, template, emailToNoteTitle);
					await this.app.vault.modify(existingFile, content);
					updated++;
				} else {
					// Create new file
					const filename = generateFilename(filenamePattern, doc);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					const content = this.renderDocument(doc.id, cache, template, emailToNoteTitle);
					await this.app.vault.create(filePath, content);
					created++;
				}
			} catch (error) {
				console.error(`Error syncing document ${doc.id}:`, error);
			}
		}

		// Show result notice
		if (this.settings.skipExistingNotes) {
			new Notice(`Synced ${created} new meeting${created !== 1 ? "s" : ""} (${skipped} skipped)`);
		} else {
			new Notice(`Synced ${created} new, ${updated} updated meeting${created + updated !== 1 ? "s" : ""}`);
		}
	}

	private renderDocument(
		docId: string,
		cache: GranolaCache,
		template: string,
		emailToNoteTitle: Map<string, string>,
	): string {
		const doc = cache.documents[docId];
		const panels = cache.documentPanels[docId];
		const transcript = cache.transcripts[docId];
		return applyTemplate(template, doc, panels, transcript, emailToNoteTitle);
	}
}
