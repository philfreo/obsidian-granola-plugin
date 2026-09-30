import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	spokenRange,
	formatSegments,
	fetchTranscriptSegments,
	resolveNoteId,
	fetchMeetingTranscript,
} from "./granola-api";
import type { TranscriptSegment } from "./granola-api";
import * as fetchModule from "./fetch";

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
	return {
		speaker: { source: "microphone", attribution: "me" },
		text: "hello",
		start_time: "2026-03-03T15:00:00.000Z",
		end_time: "2026-03-03T15:00:04.000Z",
		...overrides,
	};
}

describe("spokenRange", () => {
	it("spans the first word to the last", () => {
		const range = spokenRange([
			segment({ start_time: "2026-03-03T15:00:00.000Z", end_time: "2026-03-03T15:00:05.000Z" }),
			segment({ start_time: "2026-03-03T15:41:00.000Z", end_time: "2026-03-03T15:41:30.000Z" }),
		]);
		expect(range).toEqual({
			startMs: Date.parse("2026-03-03T15:00:00.000Z"),
			endMs: Date.parse("2026-03-03T15:41:30.000Z"),
		});
	});

	it("does not assume the segments arrive in order", () => {
		const ordered = spokenRange([
			segment({ start_time: "2026-03-03T15:00:00.000Z", end_time: "2026-03-03T15:00:05.000Z" }),
			segment({ start_time: "2026-03-03T15:41:00.000Z", end_time: "2026-03-03T15:41:30.000Z" }),
		]);
		const shuffled = spokenRange([
			segment({ start_time: "2026-03-03T15:41:00.000Z", end_time: "2026-03-03T15:41:30.000Z" }),
			segment({ start_time: "2026-03-03T15:00:00.000Z", end_time: "2026-03-03T15:00:05.000Z" }),
		]);
		expect(shuffled).toEqual(ordered);
	});

	it("keeps going when one timestamp is unreadable", () => {
		const range = spokenRange([
			segment({ start_time: "2026-03-03T15:00:00.000Z", end_time: "not a date" }),
			segment({ start_time: "2026-03-03T15:20:00.000Z", end_time: "2026-03-03T15:20:10.000Z" }),
		]);
		expect(range?.endMs).toBe(Date.parse("2026-03-03T15:20:10.000Z"));
	});

	it("reports nothing when there is nothing usable", () => {
		expect(spokenRange([])).toBeNull();
		expect(spokenRange([segment({ start_time: "x", end_time: "y" })])).toBeNull();
	});
});

describe("formatSegments", () => {
	it("labels each turn by the identified speaker", () => {
		const text = formatSegments([
			segment({ speaker: { source: "microphone", attribution: "me" }, text: "mine" }),
			segment({
				speaker: { source: "speaker", attribution: "them", name: "Jane Doe" },
				text: "hers",
			}),
		]);
		expect(text).toBe("**Me:** mine\n\n**Jane Doe:** hers");
	});

	it("falls back to the diarization label, then to attribution", () => {
		const text = formatSegments([
			segment({ speaker: { source: "speaker", diarization_label: "Speaker A" }, text: "one" }),
			segment({ speaker: { source: "speaker", attribution: "them" }, text: "two" }),
		]);
		expect(text).toBe("**Speaker A:** one\n\n**Them:** two");
	});

	it("runs consecutive turns by one person together", () => {
		const text = formatSegments([
			segment({ text: "first" }),
			segment({ text: "second" }),
			segment({ speaker: { source: "speaker", attribution: "them" }, text: "reply" }),
		]);
		expect(text).toBe("**Me:** first second\n\n**Them:** reply");
	});

	it("skips empty utterances", () => {
		expect(formatSegments([segment({ text: "   " })])).toBe("");
	});
});

describe("fetchTranscriptSegments", () => {
	let calls: string[];

	function respond(pages: unknown[]) {
		let i = 0;
		vi.spyOn(fetchModule, "nodeFetch").mockImplementation(((url: string) => {
			calls.push(url);
			const body = pages[Math.min(i++, pages.length - 1)];
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
		}) as typeof fetchModule.nodeFetch);
	}

	beforeEach(() => {
		calls = [];
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("follows the cursor until the pages run out", async () => {
		respond([
			{ transcript: [segment({ text: "one" })], hasMore: true, cursor: "c1" },
			{ transcript: [segment({ text: "two" })], hasMore: false, cursor: null },
		]);
		const segments = await fetchTranscriptSegments("grn_key", "note-1");
		expect(segments.map((s) => s.text)).toEqual(["one", "two"]);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("cursor=c1");
	});

	it("never asks for more segments than the API allows", async () => {
		respond([{ transcript: [], hasMore: false, cursor: null }]);
		await fetchTranscriptSegments("grn_key", "note-1");
		const size = Number(new URL(calls[0]).searchParams.get("page_size"));
		expect(size).toBeGreaterThanOrEqual(1);
		expect(size).toBeLessThanOrEqual(100);
	});

	it("stops when hasMore is true but no cursor comes back", async () => {
		respond([{ transcript: [segment()], hasMore: true, cursor: null }]);
		await fetchTranscriptSegments("grn_key", "note-1");
		expect(calls).toHaveLength(1);
	});

	it("sends the key as a bearer token and escapes the note id", async () => {
		const seen: RequestInit[] = [];
		vi.spyOn(fetchModule, "nodeFetch").mockImplementation(((url: string, init: RequestInit) => {
			calls.push(url);
			seen.push(init);
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ transcript: [], hasMore: false, cursor: null }),
			});
		}) as typeof fetchModule.nodeFetch);
		await fetchTranscriptSegments("grn_secret", "a b/c");
		expect((seen[0].headers as Record<string, string>).Authorization).toBe("Bearer grn_secret");
		expect(calls[0]).toContain("a%20b%2Fc");
	});

	it("throws on an HTTP error rather than returning half a transcript", async () => {
		vi.spyOn(fetchModule, "nodeFetch").mockResolvedValue({
			ok: false,
			status: 401,
		} as Response);
		await expect(fetchTranscriptSegments("grn_bad", "note-1")).rejects.toThrow("401");
	});

	it("ignores entries that are not usable segments", async () => {
		respond([
			{
				transcript: [segment({ text: "good" }), { text: "no timestamps" }, null],
				hasMore: false,
				cursor: null,
			},
		]);
		const segments = await fetchTranscriptSegments("grn_key", "note-1");
		expect(segments.map((s) => s.text)).toEqual(["good"]);
	});
});

describe("matching a meeting to its REST note", () => {
	const MEETING = "4acc0662-0df0-44f3-8d52-7551f287789c";
	const listedMs = Date.parse("2026-09-30T17:00:00.000Z");
	let calls: string[];

	/** Routes by path so a test can describe a whole little account. */
	function api(notes: Array<{ id: string; created_at: string; uuid: string }>) {
		vi.spyOn(fetchModule, "nodeFetch").mockImplementation(((url: string) => {
			calls.push(url);
			const path = new URL(url).pathname;
			const ok = (body: unknown) =>
				Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
			if (path === "/v1/notes") {
				return ok({ notes: notes.map(({ id, created_at }) => ({ id, created_at })) });
			}
			const detail = notes.find((n) => path === `/v1/notes/${n.id}`);
			if (detail) return ok({ web_url: `https://notes.granola.ai/d/${detail.uuid}` });
			const transcript = notes.find((n) => path === `/v1/notes/${n.id}/transcript`);
			if (transcript) {
				return ok({ transcript: [segment({ text: transcript.id })], hasMore: false, cursor: null });
			}
			return Promise.resolve({ ok: false, status: 404 });
		}) as typeof fetchModule.nodeFetch);
	}

	beforeEach(() => {
		calls = [];
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("matches on web_url rather than on the title or the clock", async () => {
		// Two notes made at the same moment, as happens when colleagues each
		// capture one meeting. Only the web_url tells them apart.
		api([
			{ id: "not_other", created_at: "2026-09-30T17:00:00.000Z", uuid: "11111111-1111-1111-1111-111111111111" },
			{ id: "not_mine", created_at: "2026-09-30T17:00:00.000Z", uuid: MEETING },
		]);
		expect(await resolveNoteId("grn_key", MEETING, listedMs)).toBe("not_mine");
	});

	it("tries the closest note in time first", async () => {
		api([
			{ id: "not_far", created_at: "2026-09-30T23:00:00.000Z", uuid: "22222222-2222-2222-2222-222222222222" },
			{ id: "not_near", created_at: "2026-09-30T17:01:00.000Z", uuid: MEETING },
		]);
		expect(await resolveNoteId("grn_key", MEETING, listedMs)).toBe("not_near");
		expect(calls.filter((c) => c.includes("/v1/notes/"))).toHaveLength(1);
	});

	it("bounds the search to a window around the meeting", async () => {
		api([{ id: "not_mine", created_at: "2026-09-30T17:00:00.000Z", uuid: MEETING }]);
		await resolveNoteId("grn_key", MEETING, listedMs);
		const list = new URL(calls[0]);
		expect(list.searchParams.get("created_after")).toBeTruthy();
		expect(list.searchParams.get("created_before")).toBeTruthy();
		expect(Number(list.searchParams.get("page_size"))).toBeLessThanOrEqual(30);
	});

	it("reports no match rather than guessing at the wrong note", async () => {
		api([
			{ id: "not_other", created_at: "2026-09-30T17:00:00.000Z", uuid: "33333333-3333-3333-3333-333333333333" },
		]);
		expect(await resolveNoteId("grn_key", MEETING, listedMs)).toBeNull();
		expect(await fetchMeetingTranscript("grn_key", MEETING, listedMs)).toBeNull();
	});

	it("fetches the transcript once the note is identified", async () => {
		api([{ id: "not_mine", created_at: "2026-09-30T17:00:00.000Z", uuid: MEETING }]);
		const segments = await fetchMeetingTranscript("grn_key", MEETING, listedMs);
		expect(segments?.map((s) => s.text)).toEqual(["not_mine"]);
	});

	it("gives up when the meeting has no readable date", async () => {
		api([{ id: "not_mine", created_at: "2026-09-30T17:00:00.000Z", uuid: MEETING }]);
		expect(await fetchMeetingTranscript("grn_key", MEETING, NaN)).toBeNull();
		expect(calls).toHaveLength(0);
	});
});
