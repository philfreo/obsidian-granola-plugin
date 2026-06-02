import { describe, it, expect } from "vitest";
import {
	parseMeetingsResponse,
	parseParticipants,
	parseTranscriptResponse,
	parseAccountInfo,
	formatTranscriptText,
	parseGranolaDate,
	buildMeetingData,
} from "./response-parser";

describe("parseParticipants", () => {
	it("returns empty array for blank input", () => {
		expect(parseParticipants("")).toEqual([]);
		expect(parseParticipants("   ")).toEqual([]);
	});

	it("parses name, org, email, and creator marker", () => {
		const result = parseParticipants(
			"Phil Freo (note creator) from Close <phil@close.com>, Barrett King from Close <barrett.king@close.com>",
		);
		expect(result).toEqual([
			{ name: "Phil Freo", email: "phil@close.com", organization: "Close", isCreator: true },
			{ name: "Barrett King", email: "barrett.king@close.com", organization: "Close", isCreator: false },
		]);
	});

	it("handles a participant with no organization", () => {
		const result = parseParticipants("Jane Doe <jane@example.com>");
		expect(result).toEqual([
			{ name: "Jane Doe", email: "jane@example.com", organization: "", isCreator: false },
		]);
	});

	it("handles a participant with only an email", () => {
		const result = parseParticipants("<solo@example.com>");
		expect(result).toEqual([
			{ name: "", email: "solo@example.com", organization: "", isCreator: false },
		]);
	});
});

describe("parseMeetingsResponse", () => {
	it("returns empty array when there are no meetings", () => {
		expect(parseMeetingsResponse("")).toEqual([]);
		expect(parseMeetingsResponse("<other>nope</other>")).toEqual([]);
	});

	it("parses a meeting with participants, private notes, and summary", () => {
		const xml = `
			<meeting id="abc123" title="Weekly Sync" date="Mar 3, 2026 3:00 PM">
				<known_participants>
					Phil Freo (note creator) from Close <phil@close.com>
				</known_participants>
				<private_notes>my private thoughts</private_notes>
				<summary>## Recap\nWe discussed things.</summary>
			</meeting>
		`;
		const result = parseMeetingsResponse(xml);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("abc123");
		expect(result[0].title).toBe("Weekly Sync");
		expect(result[0].date).toBe("Mar 3, 2026 3:00 PM");
		expect(result[0].privateNotes).toBe("my private thoughts");
		expect(result[0].summary).toBe("## Recap\nWe discussed things.");
		expect(result[0].participants).toHaveLength(1);
		expect(result[0].participants[0].email).toBe("phil@close.com");
	});

	it("parses multiple meetings and tolerates missing optional fields", () => {
		const xml = `
			<meeting id="m1" title="First" date="Mar 1, 2026 9:00 AM"></meeting>
			<meeting id="m2" title="Second" date="Mar 2, 2026 10:00 AM"><summary>Done</summary></meeting>
		`;
		const result = parseMeetingsResponse(xml);
		expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(result[0].summary).toBe("");
		expect(result[0].participants).toEqual([]);
		expect(result[1].summary).toBe("Done");
	});
});

describe("parseTranscriptResponse", () => {
	it("extracts transcript from JSON", () => {
		expect(parseTranscriptResponse('{"transcript":"  hello world  "}')).toBe("hello world");
	});

	it("returns empty string when JSON has no transcript", () => {
		expect(parseTranscriptResponse('{"id":"x"}')).toBe("");
	});

	it("falls back to raw text when not JSON", () => {
		expect(parseTranscriptResponse("  just text  ")).toBe("just text");
	});
});

describe("parseAccountInfo", () => {
	it("combines email and workspace from the real API shape", () => {
		const json = JSON.stringify({
			email: "phil@close.com",
			active_workspace: { id: "9941", display_name: "Close" },
		});
		expect(parseAccountInfo(json)).toBe("phil@close.com (Close)");
	});

	it("returns just the email when no workspace name is present", () => {
		expect(parseAccountInfo('{"email":"a@b.com"}')).toBe("a@b.com");
		expect(parseAccountInfo('{"email":"a@b.com","active_workspace":null}')).toBe("a@b.com");
	});

	it("returns the workspace name when there is no email", () => {
		expect(parseAccountInfo('{"active_workspace":{"display_name":"Solo"}}')).toBe("Solo");
	});

	it("scrapes an email out of non-JSON text", () => {
		expect(parseAccountInfo("Signed in as user@example.com today")).toBe("user@example.com");
	});

	it("returns empty string for blank input", () => {
		expect(parseAccountInfo("")).toBe("");
		expect(parseAccountInfo("   ")).toBe("");
	});
});

describe("formatTranscriptText", () => {
	it("returns empty string for empty input", () => {
		expect(formatTranscriptText("")).toBe("");
	});

	it("bolds speaker labels and inserts breaks", () => {
		const result = formatTranscriptText("Me: hello  Them: hi there  Me: bye");
		expect(result).toBe("**Me:** hello\n\n**Them:** hi there\n\n**Me:** bye");
	});
});

describe("parseGranolaDate", () => {
	it("splits a date string into ISO date and time", () => {
		const result = parseGranolaDate("Mar 3, 2026 3:00 PM");
		expect(result.isoDate).toBe("2026-03-03");
		expect(result.time).toBe("3:00 PM");
		expect(result.isoDateTime).not.toBe("");
	});

	it("returns blanks for an unparseable date", () => {
		expect(parseGranolaDate("not a date")).toEqual({ isoDate: "", time: "", isoDateTime: "" });
	});
});

describe("buildMeetingData", () => {
	it("assembles meeting data and a granola URL", () => {
		const data = buildMeetingData(
			{
				id: "xyz",
				title: "Planning",
				date: "Mar 3, 2026 3:00 PM",
				participants: [],
				privateNotes: "notes",
				summary: "summary md",
			},
			"Me: hi",
		);
		expect(data.id).toBe("xyz");
		expect(data.title).toBe("Planning");
		expect(data.date).toBe("2026-03-03");
		expect(data.startTime).toBe("3:00 PM");
		expect(data.url).toBe("https://notes.granola.ai/d/xyz");
		expect(data.enhancedNotes).toBe("summary md");
		expect(data.transcript).toBe("**Me:** hi");
	});

	it("falls back to a default title when none is given", () => {
		const data = buildMeetingData(
			{ id: "id", title: "", date: "Mar 3, 2026 3:00 PM", participants: [], privateNotes: "", summary: "" },
			"",
		);
		expect(data.title).toBe("Untitled Meeting");
	});
});
