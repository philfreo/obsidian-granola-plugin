import { describe, expect, it } from "vitest";
import {
	FOLDER_INDEX_END_MARKER,
	FOLDER_INDEX_START_MARKER,
	formatFolderIndexContent,
} from "./folder-index";

describe("formatFolderIndexContent", () => {
	it("creates a new index note document when existingContent is undefined", () => {
		const content = formatFolderIndexContent("Acme Corp", [
			"- [[2026-09-06 Acme Sync]]",
			"- [[2026-09-01 Kickoff]]",
		]);

		expect(content).toContain("---\ntags:\n  - granola/folder\n---");
		expect(content).toContain("# Acme Corp");
		expect(content).toContain(FOLDER_INDEX_START_MARKER);
		expect(content).toContain("- [[2026-09-06 Acme Sync]]");
		expect(content).toContain("- [[2026-09-01 Kickoff]]");
		expect(content).toContain(FOLDER_INDEX_END_MARKER);
	});

	it("shows placeholder when meetingLinks is empty for a new file", () => {
		const content = formatFolderIndexContent("Empty Folder", []);

		expect(content).toContain("*(No meetings found)*");
	});

	it("updates existing content by replacing only the marker section", () => {
		const existing = `# Acme Corp\n\nCustom user notes here.\n\n${FOLDER_INDEX_START_MARKER}\n- [[Old Meeting]]\n${FOLDER_INDEX_END_MARKER}\n\n## Action Items\n- [ ] User task`;

		const updated = formatFolderIndexContent("Acme Corp", [
			"- [[2026-09-06 Acme Sync]]",
			"- [[2026-09-01 Kickoff]]",
		], existing);

		expect(updated).toContain("Custom user notes here.");
		expect(updated).toContain("## Action Items\n- [ ] User task");
		expect(updated).not.toContain("- [[Old Meeting]]");
		expect(updated).toContain("- [[2026-09-06 Acme Sync]]");
		expect(updated).toContain("- [[2026-09-01 Kickoff]]");
	});

	it("appends marker block to existing content if markers are absent", () => {
		const existing = `# My Pre-existing Notes\n\nSome hand-written notes.`;

		const updated = formatFolderIndexContent("Acme Corp", [
			"- [[2026-09-06 Acme Sync]]",
		], existing);

		expect(updated.startsWith("# My Pre-existing Notes\n\nSome hand-written notes.\n\n<!-- granola-meetings:start -->")).toBe(true);
		expect(updated).toContain("- [[2026-09-06 Acme Sync]]");
		expect(updated).toContain("<!-- granola-meetings:end -->");
	});
});
