import { App, normalizePath, TFile } from "obsidian";
import {
	GranolaDocument,
	TranscriptEntry,
	GranolaPanel,
	prosemirrorToMarkdown,
	formatPanels,
	formatTranscript,
	getMeetingTimes,
} from "./granola";
import DEFAULT_TEMPLATE from "./default-template.md";

export async function loadTemplate(app: App, templatePath: string): Promise<string> {
	const normalizedPath = normalizePath(templatePath);
	const file = app.vault.getAbstractFileByPath(normalizedPath);

	if (file instanceof TFile) {
		return await app.vault.read(file);
	}

	// Create default template if it doesn't exist
	const lastSlash = normalizedPath.lastIndexOf("/");
	if (lastSlash > 0) {
		const folderPath = normalizedPath.substring(0, lastSlash);
		const folder = app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await app.vault.createFolder(folderPath);
		}
	}
	await app.vault.create(normalizedPath, DEFAULT_TEMPLATE);
	return DEFAULT_TEMPLATE;
}

function resolveAttendeeName(
	attendee: { name?: string; email?: string; details?: { person?: { name?: { fullName?: string } } } },
	emailToNoteTitle: Map<string, string>,
): string | null {
	// First, try to match by email to an existing note
	if (attendee.email) {
		const noteTitle = emailToNoteTitle.get(attendee.email.toLowerCase());
		if (noteTitle) return noteTitle;
	}

	// Fall back to Granola's data
	return (
		attendee.name ||
		attendee.details?.person?.name?.fullName ||
		attendee.email ||
		null
	);
}

export function applyTemplate(
	template: string,
	doc: GranolaDocument,
	panels: Record<string, GranolaPanel> | undefined,
	transcript: TranscriptEntry[] | undefined,
	emailToNoteTitle: Map<string, string> = new Map(),
): string {
	const date = doc.created_at.split("T")[0];
	const times = getMeetingTimes(transcript);

	// Resolve attendee names, preferring matches from vault notes
	const attendeeNames = (doc.people?.attendees ?? [])
		.map((a) => resolveAttendeeName(a, emailToNoteTitle))
		.filter((name): name is string => name !== null && name !== "Unknown");

	const notes = (doc.notes_markdown || prosemirrorToMarkdown(doc.notes)).trim();
	const enhancedNotes = formatPanels(panels);
	const formattedTranscript = formatTranscript(transcript);

	const variables: Record<string, string> = {
		granola_id: doc.id,
		granola_title: doc.title || "Untitled Meeting",
		granola_date: date,
		granola_created: doc.created_at,
		granola_updated: doc.updated_at,
		granola_private_notes: notes,
		granola_enhanced_notes: enhancedNotes,
		granola_transcript: formattedTranscript,
		granola_attendees: attendeeNames.join(", "),
		granola_attendees_linked: attendeeNames.map((name) => `[[${name}]]`).join(", "),
		granola_attendees_list: attendeeNames.map((name) => `  - ${name}`).join("\n"),
		granola_attendees_linked_list: attendeeNames
			.map((name) => `  - "[[${name}]]"`)
			.join("\n"),
		granola_url: `https://notes.granola.ai/d/${doc.id}`,
		granola_duration: times?.duration || "",
		granola_start_time: times?.startTime || "",
		granola_end_time: times?.endTime || "",
	};

	// Process conditional blocks: {{#var}}content{{/var}} - only renders if var is non-empty
	let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, content: string) => {
		const value = variables[key];
		return value?.trim() ? content : "";
	});

	// Replace simple variables: {{var}}
	result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);

	return result;
}

export function sanitizeFilename(name: string): string {
	return name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.slice(0, 100);
}

export function generateFilename(pattern: string, doc: GranolaDocument): string {
	const date = doc.created_at.split("T")[0];
	const title = sanitizeFilename(doc.title || "Untitled");
	const id = doc.id.slice(0, 8);

	return pattern
		.replace("{date}", date)
		.replace("{title}", title)
		.replace("{id}", id);
}
