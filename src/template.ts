import { App, moment, normalizePath, TFile } from "obsidian";
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
	durationStyle: DurationStyle = DEFAULT_DURATION_STYLE,
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
		granola_duration_min: meeting.durationMinutes,
		// Retired in favour of the two names above, and deliberately still
		// here: a template that reaches for it renders nothing rather than
		// spilling a raw placeholder into someone's note. Not advertised.
		granola_duration: "",
		granola_duration_formatted: formatDuration(
			meeting.durationMinutes === "" ? null : Number(meeting.durationMinutes),
			durationStyle,
		),
		granola_start_time: formatClockTime(meeting.startMinutes),
		granola_end_time: formatClockTime(meeting.endMinutes),
	};

	const result = renderConditionals(template, variables);

	// Replace simple variables: {{var}}
	return result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

/** How `{{granola_duration_formatted}}` is written. */
export type DurationStyle = "compact" | "long" | "minutes";

export const DEFAULT_DURATION_STYLE: DurationStyle = "compact";

/**
 * Write a duration in minutes as human-readable text.
 *
 * `Intl` formats one number against one unit and knows the unit's name in
 * every locale, so "1h 14m" comes back as "1 Std. 14 Min." for a reader whose
 * Obsidian is in German without the plugin holding any translations. The
 * locale comes from moment, which Obsidian sets from the app's language, so
 * durations follow the same setting the clock times do rather than the
 * operating system's.
 *
 * Choosing which units to pass is ours rather than `Intl`'s, and it is what
 * keeps a zero component out of the text: an hour exactly is "1h" and not
 * "1h 0m", while anything under an hour is "35m" and not "0h 35m". Hours are
 * never capped at 24, so an overnight recording reads "24h 14m".
 */
export function formatDuration(totalMinutes: number | null, style: DurationStyle): string {
	if (totalMinutes === null || !Number.isFinite(totalMinutes)) return "";
	const locale = moment.locale();
	const unit = (value: number, name: "hour" | "minute") => {
		try {
			return new Intl.NumberFormat(locale, {
				style: "unit",
				unit: name,
				unitDisplay: style === "compact" ? "narrow" : "long",
			}).format(value);
		} catch {
			// Very old runtimes lack the unit style; fall back to English.
			const suffix = style === "compact" ? name.charAt(0) : ` ${name}${value === 1 ? "" : "s"}`;
			return `${value}${suffix}`;
		}
	};

	if (style === "minutes") return unit(totalMinutes, "minute");

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (hours) parts.push(unit(hours, "hour"));
	if (minutes || !hours) parts.push(unit(minutes, "minute"));
	return parts.join(" ");
}

/**
 * Render minutes since midnight as a clock time in the reader's own locale,
 * so a 24-hour locale gets "14:06" where an English one gets "2:06 PM".
 *
 * Obsidian bundles moment and localizes it to the app's language, which makes
 * `LT` — its locale-aware short time format — follow the language the user
 * actually reads Obsidian in rather than whatever the operating system is set
 * to. Building the time by adding to the start of a day also means a meeting
 * running past midnight formats as the following morning instead of
 * overflowing past 24.
 */
function formatClockTime(totalMinutes: number | null): string {
	if (totalMinutes === null) return "";
	// `utc` keeps this synthetic time free of any local timezone or DST shift;
	// only the clock face matters, and the locale still governs formatting.
	return moment.utc().startOf("day").add(totalMinutes, "minutes").format("LT");
}

/**
 * Render `{{#var}}content{{/var}}` blocks, keeping the content only when the
 * variable is non-empty.
 *
 * Recurses into the content it keeps, so a block nested inside another one is
 * rendered too — a flat pass replaces the outer block with text it never
 * rescans, which used to leave the inner `{{#var}}` and `{{/var}}` markers
 * sitting in the finished note as literal characters.
 *
 * Recursion walks the template only, and runs before any variable is
 * substituted. That ordering is the safety property: a meeting whose notes
 * happen to contain `{{#something}}` gets it written out verbatim, instead of
 * having Granola's own text interpreted as template markup.
 */
function renderConditionals(template: string, variables: Record<string, string>): string {
	return template.replace(
		/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
		(_, key: string, content: string) =>
			variables[key]?.trim() ? renderConditionals(content, variables) : "",
	);
}

/** Characters no filename may contain on Windows or macOS. */
const UNSAFE_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

/**
 * C0 and C1 control characters. Titles copied out of a multi-line calendar
 * invite arrive with the newline still attached, and a newline is not a
 * filesystem-unsafe character, so it used to survive into the filename.
 */
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * Zero-width format characters: the zero-width space, the soft hyphen, the bidi
 * marks and the BOM. They render as nothing, so a title carrying one looks
 * identical to one that doesn't and no [[wikilink]] a reader types by hand can
 * resolve — the same failure as a trailing space, just invisible in the file
 * explorer too. Dropped rather than folded into a space so the visible title is
 * unchanged. The zero-width joiner (U+200D) is excluded: it is what holds a
 * multi-part emoji together, and dropping it would split one glyph into several.
 */
const FORMAT_CHARS = /(?!\u200d)\p{Cf}/gu;

/**
 * Legal in a filename, but each one breaks an Obsidian [[wikilink]] pointing at
 * the note: `#` opens a heading reference, `^` a block reference, and `]]` closes
 * the link early. Meeting notes are linked from daily notes and MOCs, so a title
 * like "Q3 [draft] #planning" would otherwise produce a note nothing can link to.
 * (`|`, the alias separator, is already covered as a filesystem-unsafe character.)
 */
const WIKILINK_UNSAFE_CHARS = /[#^[\]]/g;

const MAX_FILENAME_LENGTH = 100;

/**
 * Turn a meeting title into a filename component.
 *
 * Granola titles come straight from calendar events, so they carry whatever the
 * organizer typed: a trailing newline, a stray tab, an emoji, or nothing but
 * punctuation. Control characters are folded into spaces and runs of whitespace
 * collapsed, because a filename containing a raw newline is legal on macOS but
 * unusable everywhere else; zero-width characters are dropped outright, since a
 * space in their place would show up in a name that looked fine before.
 *
 * Truncation counts code points rather than UTF-16 units: `String.slice` cuts an
 * emoji in half at the boundary and leaves a lone surrogate in the name. Trailing
 * spaces, dots and hyphens are stripped after the cut rather than before, so
 * truncation cannot reintroduce one — Windows rejects a trailing space or dot, and
 * a leading dot would hide the note. Hyphens are trimmed only at the edges, never
 * collapsed inside, so "Q1/Q2" stays "Q1-Q2". A title made entirely of unsafe
 * characters reduces to a row of hyphens and therefore to nothing, so it falls
 * back to "Untitled".
 */
export function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(CONTROL_CHARS, " ")
		.replace(FORMAT_CHARS, "")
		.replace(UNSAFE_FILENAME_CHARS, "-")
		.replace(WIKILINK_UNSAFE_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim();

	const truncated = Array.from(cleaned).slice(0, MAX_FILENAME_LENGTH).join("");

	return truncated
		.replace(/^[.-]+/, "")
		.replace(/[ .-]+$/, "")
		.trim() || "Untitled";
}

/** A `{date}` placeholder, optionally carrying a moment format: `{date:YYYY/MM}`. */
const DATE_TOKEN = /\{date(?::([^}]+))?\}/g;

/**
 * Meeting dates arrive as ISO `YYYY-MM-DD` strings. Parse with an explicit input
 * format so moment never falls back to its ambiguous heuristics, then re-render
 * in whatever the user asked for. Obsidian bundles moment and re-exports it, so
 * the format tokens match the ones users already know from Obsidian's own date
 * settings.
 *
 * `utc` because a meeting date is a bare calendar date with no time or zone —
 * parsing it as local midnight would let a format like `{date:YYYY/MM}` land in
 * the previous month for anyone west of UTC.
 *
 * Parsing is strict, which is safe because `parseGranolaDate` always emits a
 * zero-padded `YYYY-MM-DD` — and it also gives us a usable invalid signal. That
 * matters: a meeting whose date Granola sends in a form `Date` cannot read comes
 * through as "", and `moment.format` renders any invalid date as the literal
 * "Invalid date". Falling back to the raw value instead means a formatted token
 * degrades exactly like a bare `{date}` does, so an undated meeting lands in the
 * base folder rather than in one named "Invalid date".
 */
function formatMeetingDate(date: string, format: string): string {
	const parsed = moment.utc(date, "YYYY-MM-DD", true);
	return parsed.isValid() ? parsed.format(format) : date;
}

/**
 * Expand `{date}` / `{date:FORMAT}` in a folder path, so meetings can be filed
 * into dated subfolders like `Meetings/{date:YYYY/MM}`. Slashes in the result are
 * meaningful here — they are what creates the nesting.
 */
export function resolveDatePattern(pattern: string, date: string): string {
	return pattern.replace(DATE_TOKEN, (_, format: string | undefined) =>
		format ? formatMeetingDate(date, format) : date,
	);
}

/**
 * The fixed leading part of a folder pattern, before any date token — the folder
 * every dated subfolder lives under. Created up front so a sync still has a home
 * folder to report against before any meeting has been placed.
 */
export function getFolderBasePath(folderPattern: string): string {
	// split returns the whole string as one element when there is no date token.
	return folderPattern.split(DATE_TOKEN)[0].replace(/\/+$/, "");
}

/**
 * Expand `{date}`, `{date:FORMAT}`, `{title}` and `{id}` in the user's filename
 * pattern.
 *
 * Both passes use a replacer function rather than `String.replace(string, string)`,
 * which interprets `$&`, `` $` `` and `$'` inside the *replacement* — a meeting
 * titled "Q3 $& Q4" used to expand to the text the pattern had just matched. Title
 * and id share one pass so an expanded value is never rescanned: a title containing
 * the literal "{id}" used to have it replaced by the meeting id.
 *
 * The result is a file *name*, never a path: a separator surviving from a format
 * like `{date:YYYY/MM}`, or typed into the pattern directly, is folded to a hyphen
 * rather than quietly nesting the note. Subfolders are the folder setting's job,
 * which takes the same date tokens.
 */
export function generateFilename(pattern: string, meeting: MeetingData): string {
	const values: Record<string, string> = {
		title: sanitizeFilename(meeting.title),
		id: meeting.id.slice(0, 8),
	};

	return resolveDatePattern(pattern, meeting.date)
		.replace(/\{(title|id)\}/g, (_, token: string) => values[token])
		.replace(UNSAFE_FILENAME_CHARS, "-");
}

/**
 * Where a meeting's note belongs: the folder to create, and the note's full path.
 *
 * Both come back from one place because they have to agree — the path is built by
 * joining the folder to the filename, and `normalizePath` is what reconciles the
 * separators, dropping a trailing slash the user typed and collapsing the one this
 * join adds. A folder setting of "Meetings/" therefore behaves exactly like
 * "Meetings", and a setting of "/" files notes at the vault root.
 */
export function resolveNotePath(
	folderPattern: string,
	filenamePattern: string,
	meeting: MeetingData,
): { folder: string; path: string } {
	const folder = normalizePath(resolveDatePattern(folderPattern, meeting.date));
	const filename = generateFilename(filenamePattern, meeting);
	return { folder, path: normalizePath(`${folder}/${filename}.md`) };
}
