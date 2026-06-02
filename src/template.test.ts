import { describe, it, expect } from "vitest";
import { applyTemplate, sanitizeFilename, generateFilename } from "./template";
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

describe("generateFilename", () => {
	it("expands the date, title, and id placeholders", () => {
		expect(generateFilename("{date} {title}", meeting())).toBe("2026-03-03 Weekly Sync");
		expect(generateFilename("{id}-{title}", meeting())).toBe("abc12345-Weekly Sync");
	});

	it("sanitizes the title within the filename", () => {
		expect(generateFilename("{title}", meeting({ title: "Q1/Q2 Review" }))).toBe("Q1-Q2 Review");
	});
});
