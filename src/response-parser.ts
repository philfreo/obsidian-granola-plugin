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
 * Parse the XML-ish list_meetings / get_meetings response into meeting objects.
 * When called on get_meetings response, also extracts private_notes and summary.
 */
export function parseMeetingsResponse(xml: string): ParsedMeetingDetails[] {
	const meetings: ParsedMeetingDetails[] = [];
	const meetingRegex = /<meeting\s+id="([^"]+)"\s+title="([^"]*?)"\s+date="([^"]*?)">([\s\S]*?)<\/meeting>/g;

	let match;
	while ((match = meetingRegex.exec(xml)) !== null) {
		const [, id, title, date, body] = match;

		const participantsMatch = body.match(/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/);
		const participants = participantsMatch ? parseParticipants(participantsMatch[1].trim()) : [];

		const notesMatch = body.match(/<private_notes>\s*([\s\S]*?)\s*<\/private_notes>/);
		const privateNotes = notesMatch ? notesMatch[1].trim() : "";

		const summaryMatch = body.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/);
		const summary = summaryMatch ? summaryMatch[1].trim() : "";

		meetings.push({ id, title, date, participants, privateNotes, summary });
	}

	return meetings;
}

/**
 * Parse participant string like:
 * "Phil Freo (note creator) from Close <phil@close.com>, Barrett King from Close <barrett.king@close.com>"
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

/**
 * Parse transcript response (JSON with id, title, transcript fields)
 */
export function parseTranscriptResponse(text: string): string {
	try {
		const data = JSON.parse(text) as { transcript?: string };
		return data.transcript?.trim() || "";
	} catch {
		// If not JSON, return as-is
		return text.trim();
	}
}

/**
 * Format raw transcript text with speaker breaks for readability.
 * Raw format: " Them: text... Me: text..."
 */
export function formatTranscriptText(raw: string): string {
	if (!raw) return "";
	return raw
		.trim()
		.replace(/\s{2,}(Me:|Them:)/g, "\n\n**$1**")
		.replace(/^(Me:|Them:)/, "**$1**");
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
