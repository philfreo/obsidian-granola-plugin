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
	participants: ParsedParticipant[];
}

export interface ParsedMeetingDetails extends ParsedMeeting {
	privateNotes: string;
	summary: string; // already markdown
}

export interface MeetingData {
	id: string;
	title: string;
	date: string; // ISO date "2026-03-03"
	startTime: string; // e.g. "3:00 PM"
	created: string; // ISO datetime
	url: string;
	privateNotes: string;
	enhancedNotes: string;
	transcript: string;
	participants: ParsedParticipant[];
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

		const participantsMatch = body.match(/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/);
		const participants = participantsMatch
			? parseParticipants(decodeXmlEntities(participantsMatch[1].trim()))
			: [];

		const notesMatch = body.match(/<private_notes>\s*([\s\S]*?)\s*<\/private_notes>/);
		const privateNotes = notesMatch ? normalizeTaskItems(decodeXmlEntities(notesMatch[1].trim())) : "";

		const summaryMatch = body.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
		const summary = summaryMatch ? normalizeTaskItems(decodeXmlEntities(summaryMatch[1].trim())) : "";

		meetings.push({ id, title, date, participants, privateNotes, summary });
	}

	return meetings;
}

/**
 * Parse participant string like:
 * "Jane Doe (note creator) from Example Co <jane@example.com>, John Roe from Example Co <john@example.com>"
 */
export function parseParticipants(text: string): ParsedParticipant[] {
	if (!text.trim()) return [];

	// Split by comma followed by a space and uppercase letter (start of next name)
	const parts = text.split(/,\s*(?=[A-Z])/);

	return parts.map((part) => {
		part = part.trim();

		const emailMatch = part.match(/<([^>]+)>/);
		const email = emailMatch ? emailMatch[1] : "";

		const isCreator = part.includes("(note creator)");

		// Remove email and (note creator) marker
		let nameStr = part
			.replace(/<[^>]+>/, "")
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
 * Parse transcript response (JSON with id, title, transcript fields).
 * The response may prefix the JSON with a plain-text preamble
 * ("The content below is meeting notes/transcripts..."), so if the full
 * text isn't valid JSON we retry on the outermost {...} block.
 */
export function parseTranscriptResponse(text: string): string {
	const candidates = [text];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		candidates.push(text.slice(start, end + 1));
	}
	for (const candidate of candidates) {
		try {
			const data = JSON.parse(candidate) as { transcript?: string };
			return data.transcript?.trim() || "";
		} catch {
			// try next candidate
		}
	}
	return text.trim();
}

/**
 * Granola's MCP endpoint can return a short plain-text error as successful tool
 * content. Without this guard the error body is indistinguishable from a
 * legacy plain-text transcript and gets written into the note.
 */
export function isTranscriptErrorResponse(text: string): boolean {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.length > 500) return false;
	return /^(?:rate limit exceeded|too many requests|request rate limited|temporarily unavailable|service unavailable)(?:\b|[.:])/i.test(
		normalized,
	);
}

/**
 * Recover the transcript rendered by the plugin's default template so an
 * existing note can be refreshed without downloading the same immutable
 * transcript again. Known API error bodies are treated as missing, allowing a
 * later paced sync to repair notes written by older plugin versions.
 */
export function extractStoredTranscript(content: string): string {
	const section = content.match(/(?:^|\n)## Transcript\s*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/);
	if (!section) return "";

	let body = section[1].trim();
	if (body.startsWith("```")) {
		body = body.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "").trim();
	}

	return isTranscriptErrorResponse(body) ? "" : body;
}

// Speaker labels are capitalized words followed by a colon: "Microphone:",
// "Speaker:", a participant's name, or "Me:"/"Them:" in older transcripts.
const SPEAKER_LABEL = "(\\p{Lu}[\\p{L}'’.-]*(?: \\p{Lu}[\\p{L}'’.-]*){0,3}):";

/**
 * "Microphone" is the note-taker's own audio and "Speaker" is everyone
 * else, which Granola's older transcripts labeled "Me" and "Them".
 */
function friendlySpeakerName(name: string): string {
	if (name === "Microphone") return "Me";
	if (name === "Speaker") return "Them";
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
 */
export function buildMeetingData(
	details: ParsedMeetingDetails,
	transcript: string,
): MeetingData {
	const { isoDate, time, isoDateTime } = parseGranolaDate(details.date);

	return {
		id: details.id,
		title: details.title || "Untitled Meeting",
		date: isoDate,
		startTime: time,
		created: isoDateTime,
		url: `https://notes.granola.ai/d/${details.id}`,
		privateNotes: details.privateNotes,
		enhancedNotes: details.summary,
		transcript: formatTranscriptText(transcript),
		participants: details.participants,
	};
}
