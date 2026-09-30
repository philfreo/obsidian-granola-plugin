import { nodeFetch } from "./fetch";

const API_BASE = "https://public-api.granola.ai";

/** Segments per request. The API caps this at 100 and rejects anything above. */
const PAGE_SIZE = 100;

/** Notes per request. A different endpoint with a different, much lower cap. */
const NOTE_PAGE_SIZE = 30;

/**
 * How far either side of a meeting's listed time to look for its note. A note
 * is created when recording starts, so it lands near the meeting; the window
 * only has to be wide enough to absorb a timezone or clock discrepancy.
 */
const LOOKUP_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Notes to open while hunting for a match before giving up. */
const MAX_CANDIDATES = 8;

/**
 * Stop paging a single transcript here, so a runaway cursor cannot loop
 * forever. At 100 a page this allows 10,000 utterances, several times the
 * longest meeting seen.
 */
const MAX_PAGES = 100;

/**
 * One utterance, as Granola's REST API returns it.
 *
 * This is the shape the MCP throws away: it concatenates the segments into a
 * single string and drops the timestamps, which is why a meeting synced over
 * MCP alone has no length.
 */
export interface TranscriptSegment {
	speaker: {
		/** "microphone" or "speaker"; which audio channel carried the utterance. */
		source: string;
		/** "me" for the note's owner, "them" for anyone else. */
		attribution?: string;
		/** "Speaker A" and similar, when diarization could not name the voice. */
		diarization_label?: string;
		/** The resolved name, present only once the speaker is identified. */
		name?: string;
	};
	text: string;
	/** ISO-8601 with millisecond precision. */
	start_time: string;
	end_time: string;
}

interface TranscriptPage {
	transcript?: unknown;
	hasMore?: unknown;
	cursor?: unknown;
}

/** A segment is only useful with both of its timestamps and some text. */
function isSegment(value: unknown): value is TranscriptSegment {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	const speaker = v.speaker as Record<string, unknown> | undefined;
	return (
		typeof v.text === "string" &&
		typeof v.start_time === "string" &&
		typeof v.end_time === "string" &&
		typeof speaker === "object" &&
		speaker !== null
	);
}

/**
 * Pull one note's transcript, following the cursor until the pages run out.
 *
 * Throws on any HTTP error so the caller can fall back rather than writing a
 * note with half a transcript in it. A 401 means the key is wrong or the
 * workspace is not on a plan that issues them; a 404 means this note id is
 * not one the key can see.
 */
export async function fetchTranscriptSegments(
	apiKey: string,
	noteId: string,
): Promise<TranscriptSegment[]> {
	const segments: TranscriptSegment[] = [];
	let cursor: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(`${API_BASE}/v1/notes/${encodeURIComponent(noteId)}/transcript`);
		url.searchParams.set("page_size", String(PAGE_SIZE));
		if (cursor) url.searchParams.set("cursor", cursor);

		const response = await nodeFetch(url.toString(), {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error(`Granola API ${response.status} for note ${noteId}`);
		}

		const body = (await response.json()) as TranscriptPage;
		if (Array.isArray(body.transcript)) {
			segments.push(...body.transcript.filter(isSegment));
		}

		cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : undefined;
		if (body.hasMore !== true || !cursor) break;
	}

	return segments;
}

/** The instant a meeting's first and last recorded words fall on. */
export interface SpokenRange {
	startMs: number;
	endMs: number;
}

/**
 * The span the transcript actually covers.
 *
 * Reads the extremes rather than assuming the segments arrive in order, and
 * skips any timestamp that will not parse, so one malformed entry costs a
 * little accuracy instead of the whole duration. Returns null when nothing
 * usable is left.
 */
export function spokenRange(segments: TranscriptSegment[]): SpokenRange | null {
	let startMs = Infinity;
	let endMs = -Infinity;

	for (const segment of segments) {
		const start = Date.parse(segment.start_time);
		const end = Date.parse(segment.end_time);
		if (!isNaN(start)) startMs = Math.min(startMs, start);
		if (!isNaN(end)) endMs = Math.max(endMs, end);
	}

	if (startMs === Infinity || endMs === -Infinity || endMs < startMs) return null;
	return { startMs, endMs };
}

/**
 * Render segments the way the note shows them, labelling each turn by whoever
 * Granola identified.
 *
 * Unlike the MCP's flattened string, the speaker is a field here, so this
 * needs no pattern matching and cannot be thrown off when Granola changes how
 * it writes the labels. Falls back through the diarization label to the plain
 * "Me" and "Them" that attribution gives.
 */
export function formatSegments(segments: TranscriptSegment[]): string {
	const lines: string[] = [];
	let lastSpeaker: string | null = null;

	for (const segment of segments) {
		const text = segment.text.trim();
		if (!text) continue;
		const speaker =
			segment.speaker.name ||
			segment.speaker.diarization_label ||
			(segment.speaker.attribution === "me" ? "Me" : "Them");
		// Consecutive turns by one person read as a paragraph, not a new label.
		if (speaker === lastSpeaker) {
			lines[lines.length - 1] += ` ${text}`;
		} else {
			lines.push(`**${speaker}:** ${text}`);
			lastSpeaker = speaker;
		}
	}

	return lines.join("\n\n");
}


interface NoteSummary {
	id: string;
	created_at: string;
}

async function getJson(apiKey: string, url: string): Promise<unknown> {
	const response = await nodeFetch(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
	});
	if (!response.ok) throw new Error(`Granola API ${response.status} for ${new URL(url).pathname}`);
	return response.json();
}

/** Notes created within the lookup window, newest-first as the API returns them. */
async function listNotesAround(apiKey: string, listedMs: number): Promise<NoteSummary[]> {
	const url = new URL(`${API_BASE}/v1/notes`);
	url.searchParams.set("created_after", new Date(listedMs - LOOKUP_WINDOW_MS).toISOString());
	url.searchParams.set("created_before", new Date(listedMs + LOOKUP_WINDOW_MS).toISOString());
	url.searchParams.set("page_size", String(NOTE_PAGE_SIZE));

	const body = (await getJson(apiKey, url.toString())) as { notes?: unknown };
	if (!Array.isArray(body.notes)) return [];
	return body.notes.filter(
		(n): n is NoteSummary =>
			typeof n === "object" &&
			n !== null &&
			typeof (n as NoteSummary).id === "string" &&
			typeof (n as NoteSummary).created_at === "string",
	);
}

/**
 * Find the REST id for a meeting the MCP identified.
 *
 * The two APIs name the same document differently: the MCP uses a UUID, while
 * REST issues its own prefixed id like `not_FlG2fDH18Hy7rn` and rejects the
 * UUID outright. The only field carrying both is `web_url`, which REST returns
 * on a note's detail and which ends with the UUID the MCP uses.
 *
 * Titles cannot stand in for this. Two different notes can share a title and a
 * timestamp when colleagues each capture the same meeting, so candidates are
 * ordered by how close their creation time is to the meeting and confirmed
 * against `web_url` rather than trusted on a name.
 */
export async function resolveNoteId(
	apiKey: string,
	meetingId: string,
	listedMs: number,
): Promise<string | null> {
	const notes = await listNotesAround(apiKey, listedMs);
	const nearest = notes
		.map((note) => ({ note, gap: Math.abs(Date.parse(note.created_at) - listedMs) }))
		.filter(({ gap }) => !isNaN(gap))
		.sort((a, b) => a.gap - b.gap)
		.slice(0, MAX_CANDIDATES);

	for (const { note } of nearest) {
		const detail = (await getJson(
			apiKey,
			`${API_BASE}/v1/notes/${encodeURIComponent(note.id)}`,
		)) as { web_url?: unknown };
		if (typeof detail.web_url === "string" && detail.web_url.endsWith(meetingId)) {
			return note.id;
		}
	}
	return null;
}

/**
 * The transcript for a meeting the MCP listed, or null when no REST note
 * matches it. Null rather than throwing, so the caller falls back to the MCP
 * transcript and the meeting keeps its notes even without a length.
 */
export async function fetchMeetingTranscript(
	apiKey: string,
	meetingId: string,
	listedMs: number,
): Promise<TranscriptSegment[] | null> {
	if (isNaN(listedMs)) return null;
	const noteId = await resolveNoteId(apiKey, meetingId, listedMs);
	if (!noteId) return null;
	return fetchTranscriptSegments(apiKey, noteId);
}
