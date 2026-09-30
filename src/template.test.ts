import { describe, it, expect } from "vitest";
import {
	applyTemplate,
	sanitizeFilename,
	generateFilename,
	getFolderBasePath,
	resolveDatePattern,
	resolveNotePath,
	formatDuration,
} from "./template";
import type { MeetingData } from "./response-parser";
import { moment } from "obsidian";
import DEFAULT_TEMPLATE from "./default-template.md";

function meeting(overrides: Partial<MeetingData> = {}): MeetingData {
	return {
		id: "abc12345def",
		title: "Weekly Sync",
		date: "2026-03-03",
		startMinutes: 15 * 60,
		endMinutes: null,
		durationMinutes: "",
		created: "2026-03-03T15:00:00.000Z",
		url: "https://notes.granola.ai/d/abc12345def",
		privateNotes: "",
		enhancedNotes: "",
		transcript: "",
		participants: [],
		...overrides,
	};
}

describe("applyTemplate", () => {
	it("substitutes simple variables", () => {
		const result = applyTemplate("# {{granola_title}} on {{granola_date}}", meeting());
		expect(result).toBe("# Weekly Sync on 2026-03-03");
	});

	it("leaves unknown variables untouched", () => {
		expect(applyTemplate("{{not_a_var}}", meeting())).toBe("{{not_a_var}}");
	});

	it("renders conditional block when the variable is non-empty", () => {
		const tpl = "{{#granola_private_notes}}Notes: {{granola_private_notes}}{{/granola_private_notes}}";
		const result = applyTemplate(tpl, meeting({ privateNotes: "secret" }));
		expect(result).toBe("Notes: secret");
	});

	it("drops conditional block when the variable is empty", () => {
		const tpl = "before{{#granola_private_notes}}Notes{{/granola_private_notes}}after";
		expect(applyTemplate(tpl, meeting({ privateNotes: "" }))).toBe("beforeafter");
	});

	it("resolves attendee names, preferring vault note matches by email", () => {
		const m = meeting({
			participants: [
				{ name: "Jane Doe", email: "jane@example.com", organization: "Example Co", isCreator: true },
				{ name: "Outside Person", email: "out@other.com", organization: "Other", isCreator: false },
			],
		});
		const emailToNote = new Map([["jane@example.com", "Jane Doe (Person)"]]);
		const result = applyTemplate("{{granola_attendees_linked}}", m, emailToNote);
		expect(result).toBe("[[Jane Doe (Person)]], [[Outside Person]]");
	});

	it("formats the attendee list variants", () => {
		const m = meeting({
			participants: [
				{ name: "Alice", email: "a@x.com", organization: "", isCreator: false },
				{ name: "Bob", email: "b@x.com", organization: "", isCreator: false },
			],
		});
		expect(applyTemplate("{{granola_attendees}}", m)).toBe("Alice, Bob");
		expect(applyTemplate("{{granola_attendees_list}}", m)).toBe("  - Alice\n  - Bob");
		expect(applyTemplate("{{granola_attendees_linked_list}}", m)).toBe('  - "[[Alice]]"\n  - "[[Bob]]"');
	});
});

describe("sanitizeFilename", () => {
	it("replaces filesystem-unsafe characters with hyphens", () => {
		expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	it("truncates to 100 characters", () => {
		expect(sanitizeFilename("x".repeat(150))).toHaveLength(100);
	});

	it("replaces characters that would break a wikilink to the note", () => {
		expect(sanitizeFilename("Q3 [draft] #planning ^v2")).toBe("Q3 -draft- -planning -v2");
	});

	it("folds control characters into spaces", () => {
		expect(sanitizeFilename("Weekly Sync\n")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\tSync")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\r\nSync")).toBe("Weekly Sync");
	});

	it("collapses runs of whitespace", () => {
		expect(sanitizeFilename("Weekly   Sync")).toBe("Weekly Sync");
	});

	it("strips leading and trailing spaces and dots", () => {
		expect(sanitizeFilename("  Weekly Sync  ")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly Sync...")).toBe("Weekly Sync");
		expect(sanitizeFilename(".hidden")).toBe("hidden");
	});

	it("does not split a surrogate pair at the truncation boundary", () => {
		const title = "x".repeat(99) + "\u{1F600}";
		expect(sanitizeFilename(title)).toBe(title);
	});

	it("falls back to a placeholder when nothing survives", () => {
		expect(sanitizeFilename("")).toBe("Untitled");
		expect(sanitizeFilename("   ")).toBe("Untitled");
		expect(sanitizeFilename("...")).toBe("Untitled");
	});

	it("falls back to a placeholder when a title is entirely unsafe characters", () => {
		expect(sanitizeFilename("???")).toBe("Untitled");
		expect(sanitizeFilename("###")).toBe("Untitled");
		expect(sanitizeFilename("[[]]")).toBe("Untitled");
		expect(sanitizeFilename("//")).toBe("Untitled");
	});

	it("trims hyphens at the edges without collapsing them inside", () => {
		expect(sanitizeFilename("-Weekly Sync-")).toBe("Weekly Sync");
		expect(sanitizeFilename("Q1/Q2")).toBe("Q1-Q2");
		expect(sanitizeFilename("Q1 // Q2")).toBe("Q1 -- Q2");
	});

	it("drops zero-width characters that would break a wikilink", () => {
		expect(sanitizeFilename("Weekly\u200BSync")).toBe("WeeklySync");
		expect(sanitizeFilename("Weekly Sync\u200B")).toBe("Weekly Sync");
		expect(sanitizeFilename("Weekly\u00ADSync")).toBe("WeeklySync");
		expect(sanitizeFilename("Weekly\u202ESync")).toBe("WeeklySync");
	});

	it("keeps a zero-width joiner so multi-part emoji survive intact", () => {
		const title = "Standup \u{1F469}\u200D\u{1F4BB}";
		expect(sanitizeFilename(title)).toBe(title);
	});
});

describe("resolveDatePattern", () => {
	it("expands date format tokens in folder paths", () => {
		expect(resolveDatePattern("Granola/{date:YYYY/MM/DD}", "2026-03-03")).toBe("Granola/2026/03/03");
		expect(resolveDatePattern("Granola/{date:YY/M/D}", "2026-03-03")).toBe("Granola/26/3/3");
		expect(resolveDatePattern("Granola/{date:MMMM}/{date:MMM}", "2026-03-03")).toBe("Granola/March/Mar");
	});

	it("expands {date} without a format as ISO date", () => {
		expect(resolveDatePattern("Granola/{date}", "2026-03-03")).toBe("Granola/2026-03-03");
	});

	it("leaves unknown folder path placeholders untouched", () => {
		expect(resolveDatePattern("Granola/{date:YYYY}/{unknown}", "2026-03-03")).toBe("Granola/2026/{unknown}");
	});

	it("expands a date it cannot parse to nothing rather than to \"Invalid date\"", () => {
		// parseGranolaDate hands back "" for a date string it could not read.
		expect(resolveDatePattern("Granola/{date:YYYY/MM}", "")).toBe("Granola/");
		expect(resolveDatePattern("Granola/{date:YYYY}", "whenever")).toBe("Granola/whenever");
	});
});

describe("getFolderBasePath", () => {
	it("returns the static prefix before the first date token", () => {
		expect(getFolderBasePath("Granola/{date:YYYY/MM/DD}")).toBe("Granola");
		expect(getFolderBasePath("Granola/Meetings/{date}")).toBe("Granola/Meetings");
	});

	it("returns the whole path when no date tokens are present", () => {
		expect(getFolderBasePath("Meetings")).toBe("Meetings");
	});

	it("returns nothing when the pattern is all date tokens", () => {
		expect(getFolderBasePath("{date:YYYY/MM}")).toBe("");
	});

	it("drops a trailing slash", () => {
		expect(getFolderBasePath("Meetings/")).toBe("Meetings");
		expect(getFolderBasePath("Meetings//{date}")).toBe("Meetings");
	});
});

describe("generateFilename", () => {
	it("expands the date, title, and id placeholders", () => {
		expect(generateFilename("{date} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{id}-{title}", meeting())).toBe("abc12345-Weekly Sync");
	});

	it("expands formatted date placeholders", () => {
		expect(generateFilename("{date:YYYY-MM}", meeting())).toBe("2026-03");
		expect(generateFilename("{date:YY-M-D}", meeting())).toBe("26-3-3");
		expect(generateFilename("{date:MMMM}-{date:MMM}", meeting())).toBe("March-Mar");
	});

	it("never lets a filename become a path", () => {
		// Subfolders are the folder setting's job; a separator here is just a name.
		expect(generateFilename("{date:YYYY/MM/DD} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{date}/{title}", meeting())).toBe("2026-03-03-Weekly Sync");
		expect(generateFilename("a:b|c", meeting())).toBe("a-b-c");
	});

	it("expands repeated placeholders", () => {
		expect(generateFilename("{date} {date} {title} {title} {id} {id}", meeting())).toBe(
			"2026-03-03 2026-03-03 Weekly Sync Weekly Sync abc12345 abc12345",
		);
	});

	it("leaves unknown filename placeholders untouched", () => {
		expect(generateFilename("{date} {unknown} {title}", meeting())).toBe("2026-03-03 {unknown} Weekly Sync");
	});

	it("expands a date it cannot parse to nothing rather than to \"Invalid date\"", () => {
		expect(generateFilename("{date:YYYY-MM} {title}", meeting({ date: "" }))).toBe(" Weekly Sync");
	});

	it("sanitizes the title within the filename", () => {
		expect(generateFilename("{title}", meeting({ title: "Q1/Q2 Review" }))).toBe("Q1-Q2 Review");
	});

	it("keeps $ replacement patterns in the title literal", () => {
		expect(generateFilename("{title}", meeting({ title: "Q3 $& Q4" }))).toBe("Q3 $& Q4");
		expect(generateFilename("{title}", meeting({ title: "Q3 $` Q4" }))).toBe("Q3 $` Q4");
		expect(generateFilename("{title}", meeting({ title: "Q3 $' Q4" }))).toBe("Q3 $' Q4");
	});

	it("does not re-expand a placeholder that came from the title", () => {
		expect(generateFilename("{title}", meeting({ title: "Ticket {id} review" }))).toBe(
			"Ticket {id} review",
		);
	});

	it("expands every occurrence of a placeholder", () => {
		expect(generateFilename("{date} {date}", meeting())).toBe("2026-03-03 2026-03-03");
	});
});

describe("resolveNotePath", () => {
	const build = (folderPattern: string) => resolveNotePath(folderPattern, "{date} {title}", meeting());

	it("files a note under the folder pattern", () => {
		expect(build("Meetings")).toEqual({
			folder: "Meetings",
			path: "Meetings/2026-03-03 Weekly Sync.md",
		});
	});

	it("ignores slashes around the folder setting", () => {
		for (const setting of ["Meetings/", "/Meetings", "/Meetings/", "Meetings//"]) {
			expect(build(setting)).toEqual(build("Meetings"));
		}
	});

	it("files at the vault root when the folder path is a bare slash", () => {
		expect(build("/").path).toBe("2026-03-03 Weekly Sync.md");
	});

	it("expands date tokens into the folder, not the filename", () => {
		expect(build("Meetings/{date:YYYY/MM}")).toEqual({
			folder: "Meetings/2026/03",
			path: "Meetings/2026/03/2026-03-03 Weekly Sync.md",
		});
	});

	it("keeps an undated meeting in the base folder", () => {
		expect(resolveNotePath("Meetings/{date:YYYY/MM}", "{title}", meeting({ date: "" }))).toEqual({
			folder: "Meetings",
			path: "Meetings/Weekly Sync.md",
		});
	});
});

describe("nested conditional blocks", () => {
	const tpl = "{{#granola_enhanced_notes}}A{{#granola_duration_min}}B{{/granola_duration_min}}C{{/granola_enhanced_notes}}";

	it("renders an inner block when both variables are set", () => {
		const result = applyTemplate(tpl, meeting({ enhancedNotes: "s", durationMinutes: "30" }));
		expect(result).toBe("ABC");
	});

	it("drops an inner block without leaving its markers behind", () => {
		const result = applyTemplate(tpl, meeting({ enhancedNotes: "s" }));
		expect(result).toBe("AC");
	});

	it("drops everything when the outer variable is empty", () => {
		expect(applyTemplate(tpl, meeting({ durationMinutes: "30" }))).toBe("");
	});

	it("never treats meeting content as template markup", () => {
		// Granola notes are substituted after conditionals are rendered, so a
		// meeting that happens to discuss "{{#foo}}" keeps it verbatim.
		const result = applyTemplate(
			"{{granola_private_notes}}",
			meeting({ privateNotes: "{{#foo}}hidden{{/foo}}" }),
		);
		expect(result).toBe("{{#foo}}hidden{{/foo}}");
	});
});

describe("default template timing line", () => {
	const synced = meeting({
		enhancedNotes: "- a point",
		startMinutes: 14 * 60,
		endMinutes: 14 * 60 + 41,
		durationMinutes: "41",
	});

	it("renders the timing line directly under the Summary heading", () => {
		const body = applyTemplate(DEFAULT_TEMPLATE, synced);
		expect(body).toContain("## Summary\n\n2:00 PM-2:41 PM (41m)\n\n- a point");
	});

	it("omits the line entirely when the length is unknown", () => {
		const body = applyTemplate(DEFAULT_TEMPLATE, meeting({ enhancedNotes: "- a point" }));
		expect(body).toContain("## Summary\n\n- a point");
		expect(body).not.toContain("minutes");
		expect(body).not.toContain("{{");
	});
});

describe("clock times", () => {
	it("formats start and end in the reader's locale", () => {
		const result = applyTemplate(
			"{{granola_start_time}}-{{granola_end_time}}",
			meeting({ startMinutes: 14 * 60, endMinutes: 14 * 60 + 41 }),
		);
		expect(result).toBe("2:00 PM-2:41 PM");
	});

	it("rolls a meeting running past midnight into the next morning", () => {
		const result = applyTemplate(
			"{{granola_end_time}}",
			meeting({ startMinutes: 23 * 60 + 50, endMinutes: 24 * 60 + 10 }),
		);
		expect(result).toBe("12:10 AM");
	});

	it("renders nothing when the time is unknown", () => {
		expect(applyTemplate("{{granola_start_time}}", meeting({ startMinutes: null }))).toBe("");
	});
});

describe("granola_updated", () => {
	it("is no longer a silently empty variable", () => {
		// Granola's API exposes no updated timestamp, so the placeholder now
		// survives into the note where it is visible, rather than rendering
		// as a blank that looks like the meeting simply had no value.
		expect(applyTemplate("{{granola_updated}}", meeting())).toBe("{{granola_updated}}");
	});
});

describe("formatDuration", () => {
	it("omits a component that would read as zero", () => {
		expect(formatDuration(74, "compact")).toBe("1h 14m");
		expect(formatDuration(60, "compact")).toBe("1h");
		expect(formatDuration(35, "compact")).toBe("35m");
		expect(formatDuration(1, "compact")).toBe("1m");
	});

	it("spells the units out in the long style", () => {
		expect(formatDuration(74, "long")).toBe("1 hour 14 minutes");
		expect(formatDuration(60, "long")).toBe("1 hour");
		expect(formatDuration(35, "long")).toBe("35 minutes");
	});

	it("reports the whole length in the minutes style", () => {
		expect(formatDuration(74, "minutes")).toBe("74 minutes");
		expect(formatDuration(60, "minutes")).toBe("60 minutes");
	});

	it("does not cap hours at a day", () => {
		expect(formatDuration(1454, "compact")).toBe("24h 14m");
	});

	it("renders nothing when the length is unknown", () => {
		expect(formatDuration(null, "compact")).toBe("");
	});

	it("names the units in the language Obsidian is set to", () => {
		// Derived from Intl rather than written out, because the exact words
		// come from whatever ICU data the runtime ships and differ between
		// machines. What matters here is that the locale reaches Intl at all.
		const unit = (value: number, name: "hour" | "minute", display: "narrow" | "long") =>
			new Intl.NumberFormat("de", { style: "unit", unit: name, unitDisplay: display }).format(
				value,
			);
		const previous = moment.locale();
		try {
			moment.locale("de");
			expect(formatDuration(74, "compact")).toBe(
				`${unit(1, "hour", "narrow")} ${unit(14, "minute", "narrow")}`,
			);
			expect(formatDuration(74, "long")).toBe(
				`${unit(1, "hour", "long")} ${unit(14, "minute", "long")}`,
			);
		} finally {
			moment.locale(previous);
		}
	});
});

describe("duration variables", () => {
	it("writes granola_duration_formatted in the style the caller supplies", () => {
		const m = meeting({ durationMinutes: "74" });
		expect(applyTemplate("{{granola_duration_formatted}}", m, new Map(), "minutes")).toBe(
			"74 minutes",
		);
		expect(applyTemplate("{{granola_duration_formatted}}", m)).toBe("1h 14m");
	});

	it("keeps granola_duration_min a plain number for arithmetic", () => {
		expect(applyTemplate("{{granola_duration_min}}", meeting({ durationMinutes: "74" }))).toBe(
			"74",
		);
	});

	it("leaves both empty, hiding their blocks, when the length is unknown", () => {
		const unknown = meeting({ durationMinutes: "" });
		expect(
			applyTemplate(
				"{{#granola_duration_formatted}}took {{granola_duration_formatted}}{{/granola_duration_formatted}}",
				unknown,
			),
		).toBe("");
		expect(applyTemplate("{{granola_duration_min}}", unknown)).toBe("");
	});
});

describe("the retired granola_duration name", () => {
	it("renders nothing instead of spilling a placeholder into a note", () => {
		const m = meeting({ durationMinutes: "74" });
		expect(applyTemplate("{{granola_duration}}", m)).toBe("");
		expect(applyTemplate("{{#granola_duration}}x{{/granola_duration}}", m)).toBe("");
	});
});
