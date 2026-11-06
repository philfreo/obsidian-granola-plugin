import type { SpokenRange } from "./granola-api";

export interface ParsedParticipant {
	name: string;
	email: string;
	organization: string;
	isCreator: boolean;
}

export interface ParsedMeeting {
	id: string;
	title: string;
	date: string; // raw from API, e.g. "Mar 3, 2026 3:00 PM"
	/** Granola's own link to the note; "" when the response omits it. */
	url: string;
	participants: ParsedParticipant[];
	/** Images Granola holds for the meeting, from list_meetings; 0 when absent. */
	attachmentCount: number;
}

export interface ParsedMeetingDetails extends ParsedMeeting {
	privateNotes: string;
	summary: string; // already markdown
	/** Screenshots of a shared screen, then photos attached by hand; from get_meetings. */
	attachmentIds: string[];
}

export interface MeetingData {
	id: string;
	title: string;
	date: string; // ISO date "2026-03-03"
	/** Minutes since midnight, in the meeting's own timezone; null when unknown. */
	startMinutes: number | null;
	/** Minutes since midnight; may exceed 1440 when a meeting runs past midnight. */
	endMinutes: number | null;
	durationMinutes: string; // whole minutes, e.g. "41"; "" without an API key
	created: string; // ISO datetime
	url: string;
	privateNotes: string;
	enhancedNotes: string;
	transcript: string;
	participants: ParsedParticipant[];
	/** Vault filenames of the meeting's downloaded images, in Granola's order. */
	images: string[];
}

/**
 * Granola serializes its checkbox/task nodes to Markdown without the leading
 * list dash, producing lines like "[ ] Task" or "  [x] Done". Obsidian only
 * renders interactive checkboxes when the dash is present ("- [ ] Task"), so
 * we re-add it while preserving indentation. Lines that already have a list
 * marker (-, *, +) before the checkbox are left untouched.
 */
export function normalizeTaskItems(markdown: string): string {
	if (!markdown) return markdown;
	return markdown.replace(/^([ \t]*)(\[[ xX]\]\s)/gm, "$1- $2");
}

/** The level a summary's top headings are written at: one below `## Summary`. */
const SUMMARY_TOP_HEADING = 3;

/**
 * Granola used to start a summary's sections at `###`, nested under the
 * template's `## Summary`. It now starts them at `#`, which outranks that
 * heading and flattens the note's outline. Every heading is pushed down by the
 * same amount, so the top ones are `###` again and the rest keep their places
 * beneath them, capped at `######`, the deepest heading markdown has. A
 * summary already at `###` or deeper is left as it is, as are lines inside
 * fenced code blocks.
 */
export function nestSummaryHeadings(markdown: string): string {
	const lines = markdown.split("\n");
	let inFence = false;
	const levels = lines.map((line) => {
		if (/^ {0,3}(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			return 0;
		}
		return inFence ? 0 : (line.match(/^(#{1,6})(?:[ \t]|$)/)?.[1].length ?? 0);
	});

	const shift = SUMMARY_TOP_HEADING - Math.min(...levels.filter((level) => level > 0));
	if (!(shift > 0)) return markdown;

	return lines
		.map((line, i) =>
			levels[i] ? "#".repeat(Math.min(levels[i] + shift, 6)) + line.slice(levels[i]) : line,
		)
		.join("\n");
}

/**
 * Decode XML character entities in text pulled out of the meetings response.
 * Granola's MCP server escapes attribute values and text content
 * (title="Q3 Planning &amp; Review", participants like
 * "Jane Doe &lt;jane@example.com&gt;"), so everything extracted from
 * the XML must be decoded before it reaches filenames, wikilinks, or note
 * bodies. Handles the five predefined entities plus numeric character
 * references. `&amp;` is decoded last so double-escaped input ("&amp;lt;")
 * yields the literal "&lt;" rather than "<".
 */
export function decodeXmlEntities(text: string): string {
	if (!text.includes("&")) return text;
	const fromCodePoint = (n: number) =>
		Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * Pull a double-quoted attribute value out of a `<meeting …>` open tag.
 * Returns "" when the attribute is absent, so a server-side attribute
 * change can never drop the whole meeting. The name must start the tag or
 * follow whitespace, so `id` does not also match a future `meeting-id`.
 */
function attr(openTag: string, name: string): string {
	const match = openTag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
	return match ? decodeXmlEntities(match[1]) : "";
}

/**
 * What Granola puts in `<summary>` for a meeting that has no AI summary,
 * instead of leaving the element out: a bare "No summary", or one line of its
 * own wording such as "No summary. This note is empty: it has no notes and no
 * AI summary has been generated for it." or "No AI summary has been generated
 * for this meeting, but it has a transcript. …". The wording varies, so only
 * the shared phrase is matched, and only when it is the whole summary on a
 * single line. Parsed as an empty summary, so sync skips the meeting until
 * Granola has summarized it.
 */
const NO_SUMMARY = /^(?:No summary\.?|[^\n]*\bno AI summary has been generated\b[^\n]*)$/i;

/**
 * Parse the XML-ish list_meetings / get_meetings response into meeting objects.
 * When called on get_meetings response, also extracts private_notes and summary.
 *
 * Attributes are read by name rather than by position: Granola adds and
 * reorders them over time (list_meetings now also emits `captured_by_me`,
 * `listed_as_participant` and `is_workspace_visible`), and a positional
 * pattern silently matches nothing when that happens.
 *
 * The open-tag pattern consumes quoted values whole (`"[^"]*"`) before
 * falling back to any character that is neither `>` nor `"`, so a `>`
 * inside an attribute value — a title like `Q3 > Q4 Planning` — does not
 * truncate the tag. The two alternatives are deliberately disjoint: if the
 * fallback also accepted `"`, every quote would double the number of paths
 * the engine explores, and a truncated response with no closing `>` would
 * backtrack exponentially.
 */
export function parseMeetingsResponse(xml: string): ParsedMeetingDetails[] {
	const meetings: ParsedMeetingDetails[] = [];
	const meetingRegex = /<meeting\s+((?:"[^"]*"|[^>"])*?)>([\s\S]*?)<\/meeting>/g;

	let match;
	while ((match = meetingRegex.exec(xml)) !== null) {
		const [, openTag, body] = match;
		const id = attr(openTag, "id");
		if (!id) continue;
		const title = attr(openTag, "title");
		const date = attr(openTag, "date");
		const url = attr(openTag, "url");

		const participantsMatch = body.match(/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/);
		const participants = participantsMatch
			? parseParticipants(decodeXmlEntities(participantsMatch[1].trim()))
			: [];

		const notesMatch = body.match(/<private_notes>\s*([\s\S]*?)\s*<\/private_notes>/);
		const privateNotes = notesMatch ? normalizeTaskItems(decodeXmlEntities(notesMatch[1].trim())) : "";

		const summaryMatch = body.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
		const summaryText = summaryMatch ? decodeXmlEntities(summaryMatch[1].trim()) : "";
		const summary = NO_SUMMARY.test(summaryText) ? "" : nestSummaryHeadings(normalizeTaskItems(summaryText));

		const attachmentCount = parseInt(attr(openTag, "attachment_count"), 10) || 0;
		const attachmentIds = parseAttachmentIds(body);

		meetings.push({
			id,
			title,
			date,
			url,
			participants,
			privateNotes,
			summary,
			attachmentCount,
			attachmentIds,
		});
	}

	return meetings;
}

/**
 * The ids in a meeting's `<attachments>` element, in the order Granola lists
 * them. Screenshots carry a description as their text and photos arrive with
 * none, so both the paired and the self-closing tag are accepted. Only that
 * element is read, so a summary quoting an `<attachment>` tag cannot add one.
 */
function parseAttachmentIds(meetingBody: string): string[] {
	const block = meetingBody.match(/<attachments(?:\s[^>]*)?>([\s\S]*?)<\/attachments>/);
	if (!block) return [];

	const ids: string[] = [];
	for (const [, openTag] of block[1].matchAll(/<attachment\s+((?:"[^"]*"|[^>"])*?)\/?>/g)) {
		const id = attr(openTag, "id");
		if (id) ids.push(id);
	}
	return ids;
}

/**
 * A participant's address, in angle brackets ("<jane@example.com>") or in
 * parentheses ("(jane@example.com)"). Granola has used both. The
 * parenthesized form must contain an "@", so markers like "(note creator)"
 * are never mistaken for an address.
 */
const PARTICIPANT_EMAIL = /<([^>]+)>|\(([^()\s]+@[^()\s]+)\)/;

/** A comma directly after a participant's address, where the next participant begins. */
const AFTER_PARTICIPANT_EMAIL = /(?<=<[^>]+>|\([^()\s]+@[^()\s]+\)),\s*/;

/**
 * Parse participant string like:
 * "Jane Doe (note creator) from Example Co (jane@example.com), John Roe from Example Co (john@example.com)"
 *
 * Display names can contain commas themselves ("Doe, Jane"), so the list is
 * split after each address rather than at every comma. Only a stretch with no
 * address at all falls back to splitting at a comma before a capital letter.
 */
export function parseParticipants(text: string): ParsedParticipant[] {
	if (!text.trim()) return [];

	const parts = text
		.split(AFTER_PARTICIPANT_EMAIL)
		.flatMap((chunk) => (PARTICIPANT_EMAIL.test(chunk) ? [chunk] : chunk.split(/,\s*(?=[A-Z])/)));

	return parts.map((part) => {
		part = part.trim();

		const emailMatch = part.match(PARTICIPANT_EMAIL);
		const email = emailMatch ? (emailMatch[1] ?? emailMatch[2] ?? "") : "";

		const isCreator = part.includes("(note creator)");

		// Remove email and (note creator) marker
		let nameStr = part
			.replace(PARTICIPANT_EMAIL, "")
			.replace(/\(note creator\)/g, "")
			.trim();

		let organization = "";
		const fromMatch = nameStr.match(/^(.+?)\s+from\s+(.+)$/);
		if (fromMatch) {
			nameStr = fromMatch[1].trim();
			organization = fromMatch[2].trim();
		}

		return { name: nameStr, email, organization, isCreator };
	}).filter((p) => p.name || p.email);
}

export interface AccountIdentity {
	/** Human-readable label for the settings UI, e.g. "jane@example.com (Example Co)". */
	label: string;
	/** The signed-in address, kept separately so participants can be matched against it. */
	email: string;
}

/**
 * Parse the get_account_info response into the account's label and email.
 *
 * The API returns JSON like:
 *   { "email": "jane@example.com",
 *     "active_workspace": { "id": "...", "display_name": "Example Co" } }
 *
 * We label the account by email, appending the workspace name when present
 * (e.g. "jane@example.com (Example Co)") so multiple accounts are easy to tell apart.
 * Falls back to scraping an email if the response isn't the expected JSON.
 */
export function parseAccountInfo(text: string): AccountIdentity {
	if (!text?.trim()) return { label: "", email: "" };

	try {
		const data = JSON.parse(text) as {
			email?: unknown;
			active_workspace?: { display_name?: unknown } | null;
		};
		const email = typeof data.email === "string" ? data.email.trim() : "";
		const workspace =
			typeof data.active_workspace?.display_name === "string"
				? data.active_workspace.display_name.trim()
				: "";
		if (email && workspace) return { label: `${email} (${workspace})`, email };
		if (email) return { label: email, email };
		if (workspace) return { label: workspace, email: "" };
	} catch {
		// not JSON — fall through to text scraping
	}

	// Fall back to scraping an email address out of the text.
	const emailMatch = text.match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/);
	if (emailMatch) return { label: emailMatch[0], email: emailMatch[0] };

	return { label: text.trim().split("\n")[0].trim(), email: "" };
}

/**
 * Drop the signed-in user from a participant list.
 *
 * Granola lists the account owner in every meeting's known_participants —
 * as "(note creator)" on meetings they recorded, and as a plain participant
 * on meetings a colleague recorded — so notes would otherwise always name
 * their own author as an attendee. Matching is by email rather than the
 * isCreator flag, which marks whoever captured the note and would remove
 * the wrong person on a colleague's meeting.
 */
export function excludeSelf(
	participants: ParsedParticipant[],
	selfEmail: string,
): ParsedParticipant[] {
	const self = selfEmail.trim().toLowerCase();
	if (!self) return participants;
	return participants.filter((p) => p.email.trim().toLowerCase() !== self);
}

/**
 * One reply from `get_meeting_transcript`. Since 2026-10-20 Granola returns at
 * most `max_chars` characters per call, cut at an utterance boundary, and says
 * so with `truncated` and `next_offset`.
 *
 * `text` is not trimmed. Pages only join back into the original transcript if
 * their edge whitespace is kept, and speaker breaks depend on the double space
 * before each label, so trimming a page could merge two speakers.
 */
export interface TranscriptPage {
	text: string;
	/** False for a plain-text reply, which cannot be continued. */
	paged: boolean;
	offset: number;
	truncated: boolean;
	nextOffset?: number;
}

export function parseTranscriptPage(text: string): TranscriptPage {
	const candidates = [text];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		candidates.push(text.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			const data = JSON.parse(candidate) as {
				transcript?: unknown;
				offset?: unknown;
				truncated?: unknown;
				next_offset?: unknown;
			};
			const transcript = data.transcript ?? "";
			if (typeof transcript !== "string") throw new TypeError("transcript is not text");
			// Any JSON reply counts as a page, and a missing `truncated` means
			// it is the last one: requiring the flag would discard a whole
			// transcript if Granola left it off the final page.
			return {
				text: transcript,
				paged: true,
				offset: typeof data.offset === "number" ? data.offset : 0,
				truncated: data.truncated === true,
				nextOffset: typeof data.next_offset === "number" ? data.next_offset : undefined,
			};
		} catch {
			// try next candidate
		}
	}
	return { text, paged: false, offset: 0, truncated: false };
}

export function parseTranscriptResponse(text: string): string {
	return parseTranscriptPage(text).text.trim();
}

// Speaker labels are capitalized words followed by a colon: a participant's
// name, "Speaker A:", or "Me:"/"Them:" in older transcripts.
//
// "System audio" is spelled out rather than left to the capitalized-words
// pattern because its second word is lowercase. Granola labels utterances by
// audio source, and a label the pattern misses is left sitting in the note
// as literal text instead of becoming a speaker break.
const SPEAKER_NAME = "(?:System audio|Microphone|\\p{Lu}[\\p{L}'’.-]*(?: \\p{Lu}[\\p{L}'’.-]*){0,3})";
// An audio source can name who was speaking through it: "System audio (Jane Doe):".
const SPEAKER_LABEL = `(${SPEAKER_NAME}(?: \\([^)]{1,80}\\))?):`;

/**
 * "Microphone" is the note-taker's own audio and "Speaker" is everyone else,
 * which Granola's older transcripts labeled "Me" and "Them". Where an audio
 * source names who was speaking through it, that person is the useful label,
 * so "System audio (Jane Doe)" reads as "Jane Doe".
 */
function friendlySpeakerName(name: string): string {
	const named = name.match(/^(?:System audio|Microphone) \((.+)\)$/);
	if (named) return named[1];
	if (name === "Microphone") return "Me";
	if (name === "Speaker" || name === "System audio") return "Them";
	return name;
}

/**
 * Format raw transcript text with speaker breaks for readability.
 * Raw format: " Speaker: text...  Microphone: text..." — utterances are
 * separated by 2+ spaces before the next speaker label.
 */
export function formatTranscriptText(raw: string): string {
	if (!raw) return "";
	return raw
		.trim()
		.replace(
			new RegExp(`\\s{2,}${SPEAKER_LABEL}`, "gu"),
			(_, name: string) => `\n\n**${friendlySpeakerName(name)}:**`,
		)
		.replace(
			new RegExp(`^${SPEAKER_LABEL}`, "u"),
			(_, name: string) => `**${friendlySpeakerName(name)}:**`,
		);
}

/** Parse "3:00 PM" into minutes since midnight; null when unparseable. */
export function parseClockTime(time12: string): number | null {
	const match = time12.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
	if (!match) return null;
	const hour12 = parseInt(match[1], 10);
	const minute = parseInt(match[2], 10);
	if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
	const hour = (hour12 % 12) + (match[3].toUpperCase() === "P" ? 12 : 0);
	return hour * 60 + minute;
}

/**
 * Parse a Granola date string like "Mar 3, 2026 3:00 PM" into components.
 */
export function parseGranolaDate(dateStr: string): { isoDate: string; time: string; isoDateTime: string } {
	const d = new Date(dateStr);
	if (isNaN(d.getTime())) {
		return { isoDate: "", time: "", isoDateTime: "" };
	}

	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const isoDate = `${year}-${month}-${day}`;

	// Extract time from original string
	const timeMatch = dateStr.match(/\d{1,2}:\d{2}\s*[AP]M/i);
	const time = timeMatch ? timeMatch[0] : "";

	return { isoDate, time, isoDateTime: d.toISOString() };
}

/**
 * Build a MeetingData object from parsed API responses.
 *
 * `spoken` is the span the transcript actually covers, and it only arrives
 * when an API key is configured, because the MCP exposes no end time at all.
 * Without it a meeting has a start and nothing else: end and duration stay
 * empty, which is what keeps the timing line out of the note rather than
 * filling it with a guess.
 *
 * A meeting is measured from the time Granola lists for it rather than from
 * when talking began, so the length covers waiting as well as conversation.
 * That listed time is the calendar slot for invite-linked notes and the
 * capture moment for ad-hoc ones, which have no waiting to account for.
 */
export function buildMeetingData(
	details: ParsedMeetingDetails,
	transcript: string,
	spoken: SpokenRange | null = null,
): MeetingData {
	const { isoDate, time, isoDateTime } = parseGranolaDate(details.date);
	const listedMinutes = parseClockTime(time);
	const listedInstant = Date.parse(details.date);
	const canTime = listedMinutes !== null && spoken !== null && !isNaN(listedInstant);

	// The segment times are instants, while `date` is wall-clock time in the
	// meeting's own timezone. Shifting the listed clock by the gap between
	// them lands both ends in that same zone, so a meeting reads at the hour
	// it happened rather than the hour the syncing device is in.
	//
	// The start truncates because `date` carries no seconds, so an ad-hoc
	// recording whose first word lands part-way into its own listed minute
	// would otherwise gain a minute of waiting that never happened. The end
	// rounds, since there is no such artifact and nearest-minute is the
	// honest rendering of an exact instant.
	const spokenStart = canTime
		? listedMinutes + Math.trunc((spoken.startMs - listedInstant) / 60000)
		: null;
	const spokenEnd = canTime
		? listedMinutes + Math.round((spoken.endMs - listedInstant) / 60000)
		: null;

	// Recording sometimes begins before the listed time. Taking the earlier of
	// the two keeps the reported length from ever undercutting the
	// conversation it is built from.
	const startMinutes =
		spokenStart === null ? listedMinutes : Math.min(listedMinutes!, spokenStart);
	const endMinutes = spokenEnd;

	return {
		id: details.id,
		title: details.title || "Untitled Meeting",
		date: isoDate,
		startMinutes,
		endMinutes,
		durationMinutes:
			endMinutes === null || startMinutes === null ? "" : String(endMinutes - startMinutes),
		created: isoDateTime,
		// Granola now returns the note's link itself. Falling back to building
		// one keeps older responses, and any meeting whose tag omits the
		// attribute, from landing in a note with an empty link.
		url: details.url || `https://notes.granola.ai/d/${details.id}`,
		privateNotes: details.privateNotes,
		enhancedNotes: details.summary,
		transcript: formatTranscriptText(transcript),
		participants: details.participants,
		images: [],
	};
}
