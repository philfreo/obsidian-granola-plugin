import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import StarterKit from "@tiptap/starter-kit";
import { renderToMarkdown } from "@tiptap/static-renderer";

export interface GranolaDocument {
	id: string;
	user_id: string;
	title: string | null;
	created_at: string;
	updated_at: string;
	deleted_at?: string | null;
	notes_markdown?: string;
	notes?: ProseMirrorDoc;
	people?: {
		attendees?: Array<{
			name?: string;
			email?: string;
			details?: {
				person?: {
					name?: {
						fullName?: string;
					};
				};
			};
		}>;
	};
}

export interface GranolaPanel {
	title: string;
	content: ProseMirrorDoc;
}

export interface TranscriptEntry {
	start_timestamp: string;
	end_timestamp: string;
	text: string;
	source: string;
}

interface ProseMirrorDoc {
	type: string;
	content?: unknown[];
}

export interface GranolaCache {
	documents: Record<string, GranolaDocument>;
	documentPanels: Record<string, Record<string, GranolaPanel>>;
	transcripts: Record<string, TranscriptEntry[]>;
}

function getGranolaDir(): string {
	if (process.platform === "win32") {
		return join(homedir(), "AppData/Roaming/Granola");
	} else if (process.platform === "linux") {
		return join(homedir(), ".config/Granola");
	} else {
		return join(homedir(), "Library/Application Support/Granola");
	}
}

export function getCurrentUserId(): string | null {
	try {
		const authFile = join(getGranolaDir(), "supabase.json");
		// Parsing external JSON file with unknown structure
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const auth = JSON.parse(readFileSync(authFile, "utf-8"));
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
		const userInfo = JSON.parse(auth.user_info || "{}");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
		return userInfo.id || null;
	} catch (e) {
		console.debug("Granola: could not read user auth", e);
		return null;
	}
}

export function readGranolaCache(): GranolaCache | null {
	try {
		const cacheFile = join(getGranolaDir(), "cache-v3.json");
		const raw = readFileSync(cacheFile, "utf-8");
		// Parsing external JSON cache file with unknown structure
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const data = JSON.parse(raw);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
		const cache = JSON.parse(data.cache);
		return {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
			documents: cache.state.documents || {},
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
			documentPanels: cache.state.documentPanels || {},
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
			transcripts: cache.state.transcripts || {},
		};
	} catch (e) {
		console.debug("Granola: could not read cache", e);
		return null;
	}
}

const extensions = [StarterKit];

export function prosemirrorToMarkdown(
	doc: ProseMirrorDoc | null | undefined,
): string {
	if (!doc?.content?.length) return "";
	try {
		// Cast to any since the ProseMirror structure from Granola is compatible
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
		return renderToMarkdown({ content: doc as any, extensions });
	} catch (e) {
		console.debug("Granola: could not convert ProseMirror to markdown", e);
		return "";
	}
}

export function formatPanels(
	panels: Record<string, GranolaPanel> | undefined,
): string {
	if (!panels) return "";
	return Object.values(panels)
		.map((panel) => {
			const content = prosemirrorToMarkdown(panel.content).trim();
			if (!content) return "";
			return `## ${panel.title}\n\n${content}`;
		})
		.filter((s) => s)
		.join("\n\n");
}

export function formatTranscript(
	entries: TranscriptEntry[] | undefined,
): string {
	if (!entries?.length) return "";

	const groups: { speaker: string; timestamp: Date; texts: string[] }[] = [];
	let currentGroup: {
		speaker: string;
		timestamp: Date;
		texts: string[];
	} | null = null;

	for (const entry of entries) {
		const speaker = entry.source === "microphone" ? "You" : "Them";
		const timestamp = new Date(entry.start_timestamp);

		if (!currentGroup || currentGroup.speaker !== speaker) {
			currentGroup = { speaker, timestamp, texts: [] };
			groups.push(currentGroup);
		}
		currentGroup.texts.push(entry.text);
	}

	return groups
		.map((group) => {
			const timeStr = group.timestamp.toLocaleTimeString([], {
				hour: "numeric",
				minute: "2-digit",
				second: "2-digit",
			});
			return `**${group.speaker}** (${timeStr})\n${group.texts.join(" ")}`;
		})
		.join("\n\n");
}

export function getAttendeeNames(doc: GranolaDocument): string[] {
	return (
		doc.people?.attendees
			?.map(
				(a) =>
					a.name ||
					a.details?.person?.name?.fullName ||
					a.email ||
					"Unknown",
			)
			.filter((name) => name !== "Unknown") || []
	);
}

export function getMeetingTimes(
	transcript: TranscriptEntry[] | undefined,
): { startTime: string; endTime: string; duration: string } | null {
	if (!transcript?.length) return null;

	const firstEntry = transcript[0];
	const lastEntry = transcript[transcript.length - 1];

	const startTime = new Date(firstEntry.start_timestamp);
	const endTime = new Date(lastEntry.end_timestamp);

	const startTimeStr = startTime.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
	const endTimeStr = endTime.toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});

	const durationMs = endTime.getTime() - startTime.getTime();
	const durationMins = Math.round(durationMs / 60000);
	const durationStr =
		durationMins < 60
			? `${durationMins} min`
			: `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`;

	return {
		startTime: startTimeStr,
		endTime: endTimeStr,
		duration: durationStr,
	};
}
