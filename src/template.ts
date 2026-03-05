import { App, normalizePath, TFile } from "obsidian";
import type { MeetingData, ParsedParticipant } from "./response-parser";
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

function resolveParticipantName(
	participant: ParsedParticipant,
	emailToNoteTitle: Map<string, string>,
): string | null {
	// First, try to match by email to an existing note
	if (participant.email) {
		const noteTitle = emailToNoteTitle.get(participant.email.toLowerCase());
		if (noteTitle) return noteTitle;
	}

	return participant.name || participant.email || null;
}

export function applyTemplate(
	template: string,
	meeting: MeetingData,
	emailToNoteTitle: Map<string, string> = new Map(),
): string {
	// Resolve attendee names, preferring matches from vault notes
	const attendeeNames = meeting.participants
		.map((p) => resolveParticipantName(p, emailToNoteTitle))
		.filter((name): name is string => name !== null);

	const variables: Record<string, string> = {
		granola_id: meeting.id,
		granola_title: meeting.title,
		granola_date: meeting.date,
		granola_created: meeting.created,
		granola_updated: "",
		granola_private_notes: meeting.privateNotes,
		granola_enhanced_notes: meeting.enhancedNotes,
		granola_transcript: meeting.transcript,
		granola_attendees: attendeeNames.join(", "),
		granola_attendees_linked: attendeeNames.map((name) => `[[${name}]]`).join(", "),
		granola_attendees_list: attendeeNames.map((name) => `  - ${name}`).join("\n"),
		granola_attendees_linked_list: attendeeNames
			.map((name) => `  - "[[${name}]]"`)
			.join("\n"),
		granola_url: meeting.url,
		granola_duration: "",
		granola_start_time: meeting.startTime,
		granola_end_time: "",
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

export function generateFilename(pattern: string, meeting: MeetingData): string {
	const title = sanitizeFilename(meeting.title);
	const id = meeting.id.slice(0, 8);

	return pattern
		.replace("{date}", meeting.date)
		.replace("{title}", title)
		.replace("{id}", id);
}
