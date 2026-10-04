import { describe, it, expect } from "vitest";
import { App } from "obsidian";
import { DEFAULT_SETTINGS, migrateSettings, GranolaSyncSettingTab } from "./settings";
import type { GranolaSyncSettings } from "./settings";
import type GranolaSyncPlugin from "./main";

describe("DEFAULT_SETTINGS", () => {
	it("has default values for note and transcript refresh and re-route settings", () => {
		expect(DEFAULT_SETTINGS.skipExistingNotes).toBe(false);
		expect(DEFAULT_SETTINGS.updateNoteContent).toBe(true);
		expect(DEFAULT_SETTINGS.rerouteExistingNotes).toBe(false);
		expect(DEFAULT_SETTINGS.updateTranscriptContent).toBe(true);
		expect(DEFAULT_SETTINGS.rerouteExistingTranscripts).toBe(false);
		expect(DEFAULT_SETTINGS.generateFolderIndexNotes).toBe(false);
		expect(DEFAULT_SETTINGS.folderIndexFolder).toBe("Meetings/Folders");
	});
});

describe("migrateSettings", () => {
	it("migrates legacy skipExistingNotes: true to disable content updating and re-routing (Case 3)", () => {
		const raw: Partial<GranolaSyncSettings> = {
			skipExistingNotes: true,
		};
		const migrated = migrateSettings(raw);
		expect(migrated.skipExistingNotes).toBe(true);
		expect(migrated.updateNoteContent).toBe(false);
		expect(migrated.rerouteExistingNotes).toBe(false);
		expect(migrated.updateTranscriptContent).toBe(false);
		expect(migrated.rerouteExistingTranscripts).toBe(false);
	});

	it("migrates legacy skipExistingNotes: false to enable content updating without re-routing (Case 2)", () => {
		const raw: Partial<GranolaSyncSettings> = {
			skipExistingNotes: false,
		};
		const migrated = migrateSettings(raw);
		expect(migrated.skipExistingNotes).toBe(false);
		expect(migrated.updateNoteContent).toBe(true);
		expect(migrated.rerouteExistingNotes).toBe(false);
		expect(migrated.updateTranscriptContent).toBe(true);
		expect(migrated.rerouteExistingTranscripts).toBe(false);
	});

	it("preserves explicit modern refresh and re-route settings (Case 1)", () => {
		const raw: Partial<GranolaSyncSettings> = {
			skipExistingNotes: true, // should be ignored in favor of explicit values
			updateNoteContent: true,
			rerouteExistingNotes: true,
			updateTranscriptContent: true,
			rerouteExistingTranscripts: true,
		};
		const migrated = migrateSettings(raw);
		expect(migrated.updateNoteContent).toBe(true);
		expect(migrated.rerouteExistingNotes).toBe(true);
		expect(migrated.updateTranscriptContent).toBe(true);
		expect(migrated.rerouteExistingTranscripts).toBe(true);
	});

	it("allows skipExistingNotes and updateNoteContent to be configured independently", () => {
		const config1 = migrateSettings({ skipExistingNotes: true, updateNoteContent: true });
		expect(config1.skipExistingNotes).toBe(true);
		expect(config1.updateNoteContent).toBe(true);

		const config2 = migrateSettings({ skipExistingNotes: false, updateNoteContent: false });
		expect(config2.skipExistingNotes).toBe(false);
		expect(config2.updateNoteContent).toBe(false);
	});

	it("falls back to default settings when no legacy or modern keys are provided", () => {
		const migrated = migrateSettings({});
		expect(migrated.skipExistingNotes).toBe(false);
		expect(migrated.updateNoteContent).toBe(true);
		expect(migrated.rerouteExistingNotes).toBe(false);
		expect(migrated.updateTranscriptContent).toBe(true);
		expect(migrated.rerouteExistingTranscripts).toBe(false);
	});
});

describe("GranolaSyncSettingTab group structure", () => {
	it("orders setting groups as Accounts -> Sync -> Cache -> Attendees -> Notes -> Transcripts", () => {
		const mockPlugin = {
			accounts: [],
			settings: { ...DEFAULT_SETTINGS },
			isSyncActive: false,
			currentSyncProgress: { phase: "idle" as const, current: 0, total: 0, message: "" },
			onProgress: () => () => {},
		} as unknown as GranolaSyncPlugin;

		const tab = new GranolaSyncSettingTab(new App(), mockPlugin);
		const defs = tab.getSettingDefinitions();

		expect(defs.length).toBe(7);
		expect((defs[0] as { heading?: string }).heading).toBe("Granola accounts");
		expect((defs[1] as { heading?: string }).heading).toBe("Sync");
		expect((defs[2] as { heading?: string }).heading).toBe("Cache");
		expect((defs[3] as { heading?: string }).heading).toBe("Attendees");
		expect((defs[4] as { heading?: string }).heading).toBe("Notes");
		expect((defs[5] as { heading?: string }).heading).toBe("Transcripts");
		expect((defs[6] as { heading?: string }).heading).toBe("Folders & Indexing");

		const notesGroup = defs[4] as { items: Array<{ control?: { key: string } }> };
		const noteKeys = notesGroup.items.map((i) => i.control?.key).filter(Boolean);
		expect(noteKeys).toContain("folderPath");
		expect(noteKeys).toContain("filenamePattern");
		expect(noteKeys).toContain("templatePath");
		expect(noteKeys).toContain("updateNoteContent");
		expect(noteKeys).toContain("rerouteExistingNotes");

		const transcriptsGroup = defs[5] as { items: Array<{ control?: { key: string } }> };
		const transcriptKeys = transcriptsGroup.items.map((i) => i.control?.key).filter(Boolean);
		expect(transcriptKeys).toContain("syncTranscripts");
		expect(transcriptKeys).toContain("transcriptFolder");
		expect(transcriptKeys).toContain("transcriptFilenamePattern");
		expect(transcriptKeys).toContain("transcriptTemplatePath");
		expect(transcriptKeys).toContain("updateTranscriptContent");
		expect(transcriptKeys).toContain("rerouteExistingTranscripts");

		const foldersGroup = defs[6] as { items: Array<{ control?: { key: string } }> };
		const folderKeys = foldersGroup.items.map((i) => i.control?.key).filter(Boolean);
		expect(folderKeys).toContain("generateFolderIndexNotes");
		expect(folderKeys).toContain("folderIndexFolder");
	});
});

