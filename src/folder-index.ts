export const FOLDER_INDEX_START_MARKER = "<!-- granola-meetings:start -->";
export const FOLDER_INDEX_END_MARKER = "<!-- granola-meetings:end -->";

/**
 * Format the content of a Granola folder index note.
 * If the file already exists:
 *   - If the start/end markers exist, replaces only the block between the markers,
 *     preserving user edits, notes, and custom sections outside the markers.
 *   - If the markers are absent, appends the marker block to the end.
 * If the file is new:
 *   - Creates a document with YAML tags, title heading, and marker block.
 */
export function formatFolderIndexContent(
	folderTitle: string,
	meetingLinks: string[],
	existingContent?: string,
): string {
	const listBody = meetingLinks.length > 0
		? meetingLinks.join("\n")
		: "*(No meetings found)*";
	const markerSection = `${FOLDER_INDEX_START_MARKER}\n${listBody}\n${FOLDER_INDEX_END_MARKER}`;

	if (!existingContent) {
		return `---\ntags:\n  - granola/folder\n---\n# ${folderTitle}\n\n${markerSection}\n`;
	}

	const startIdx = existingContent.indexOf(FOLDER_INDEX_START_MARKER);
	const endIdx = existingContent.indexOf(FOLDER_INDEX_END_MARKER);

	if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
		const before = existingContent.substring(0, startIdx);
		const after = existingContent.substring(endIdx + FOLDER_INDEX_END_MARKER.length);
		return `${before}${markerSection}${after}`;
	}

	// Markers not found in existing content; append to the bottom
	const trimmed = existingContent.trimEnd();
	return `${trimmed}\n\n${markerSection}\n`;
}
