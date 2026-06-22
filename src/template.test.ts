import { describe, it, expect } from "vitest";
import { applyTemplate, sanitizeFilename, generateFilename, getFolderBasePath, resolveDatePattern } from "./template";
import type { MeetingData } from "./response-parser";

function meeting(overrides: Partial<MeetingData> = {}): MeetingData {
	return {
		id: "abc12345def",
		title: "Weekly Sync",
		date: "2026-03-03",
		startTime: "3:00 PM",
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
				{ name: "Phil Freo", email: "phil@close.com", organization: "Close", isCreator: true },
				{ name: "Outside Person", email: "out@other.com", organization: "Other", isCreator: false },
			],
		});
		const emailToNote = new Map([["phil@close.com", "Phil Freo (Person)"]]);
		const result = applyTemplate("{{granola_attendees_linked}}", m, emailToNote);
		expect(result).toBe("[[Phil Freo (Person)]], [[Outside Person]]");
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
});

describe("getFolderBasePath", () => {
	it("returns the static prefix before the first date token", () => {
		expect(getFolderBasePath("Granola/{date:YYYY/MM/DD}")).toBe("Granola");
		expect(getFolderBasePath("Granola/Meetings/{date}")).toBe("Granola/Meetings");
	});

	it("returns the whole path when no date tokens are present", () => {
		expect(getFolderBasePath("Meetings")).toBe("Meetings");
	});
});

describe("generateFilename", () => {
	it("expands the date, title, and id placeholders", () => {
		expect(generateFilename("{date} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{id}-{title}", meeting())).toBe("abc12345-Weekly Sync");
	});

	it("expands formatted date placeholders", () => {
		expect(generateFilename("{date:YYYY/MM/DD} {title}", meeting())).toBe("2026/03/03 Weekly Sync");
		expect(generateFilename("{date:YYYY-MM}", meeting())).toBe("2026-03");
		expect(generateFilename("{date:YY-M-D}", meeting())).toBe("26-3-3");
		expect(generateFilename("{date:MMMM}-{date:MMM}", meeting())).toBe("March-Mar");
	});

	it("expands repeated placeholders", () => {
		expect(generateFilename("{date} {date} {title} {title} {id} {id}", meeting())).toBe(
			"2026-03-03 2026-03-03 Weekly Sync Weekly Sync abc12345 abc12345",
		);
	});

	it("leaves unknown filename placeholders untouched", () => {
		expect(generateFilename("{date} {unknown} {title}", meeting())).toBe("2026-03-03 {unknown} Weekly Sync");
	});

	it("sanitizes the title within the filename", () => {
		expect(generateFilename("{title}", meeting({ title: "Q1/Q2 Review" }))).toBe("Q1-Q2 Review");
	});
});
