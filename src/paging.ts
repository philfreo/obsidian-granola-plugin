import { decodeXmlEntities, parseTranscriptPage } from "./response-parser";

/** The largest `max_chars` Granola accepts for one transcript page. */
export const TRANSCRIPT_PAGE_CHARS = 80_000;

/**
 * Stop after this many pages. At 80,000 characters a page this is 8 million
 * characters, far beyond any meeting seen. It only guards against a server
 * that keeps promising more.
 */
const MAX_PAGES = 100;

/**
 * Read a whole transcript. `fetchPage(offset)` returns one
 * `get_meeting_transcript` reply. Pages are joined untrimmed, and the result is
 * trimmed once at the end.
 *
 * Throws rather than returning a prefix. A short transcript written as if it
 * were whole is what this change is meant to stop.
 */
export async function readTranscript(
	fetchPage: (offset: number) => Promise<string>,
): Promise<string> {
	const parts: string[] = [];
	let offset = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const parsed = parseTranscriptPage(await fetchPage(offset));
		if (!parsed.paged) {
			if (page > 0) throw new Error(`Granola transcript page ${page + 1} is not paged`);
			return parsed.text.trim();
		}
		if (parsed.offset !== offset) {
			throw new Error(`Granola transcript page starts at ${parsed.offset}, expected ${offset}`);
		}
		parts.push(parsed.text);
		if (!parsed.truncated) return parts.join("").trim();
		if (parsed.nextOffset === undefined || parsed.nextOffset <= offset) {
			throw new Error(`Granola transcript page at ${offset} gives no next offset`);
		}
		offset = parsed.nextOffset;
	}
	throw new Error(`Granola transcript runs past ${MAX_PAGES} pages`);
}

/**
 * Read a whole meeting list. `fetchPage(cursor)` returns one `list_meetings`
 * reply, and `cursor` is undefined for the first. Pages are joined so that
 * `parseMeetingsResponse` reads them as one list.
 */
export async function readMeetingList(
	fetchPage: (cursor?: string) => Promise<string>,
): Promise<string> {
	const parts: string[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const text = await fetchPage(cursor);
		parts.push(text);
		const next = parseListPagination(text);
		if (!next.hasMore) return parts.join("\n");
		if (!next.nextCursor || seen.has(next.nextCursor)) {
			throw new Error("Granola meeting list has more pages but no new cursor");
		}
		seen.add(next.nextCursor);
		cursor = next.nextCursor;
	}
	throw new Error(`Granola meeting list runs past ${MAX_PAGES} pages`);
}

/**
 * A list reply ends with `<pagination has_more="…" next_cursor="…" />`. A reply
 * without the tag is one complete page.
 */
export function parseListPagination(text: string): { hasMore: boolean; nextCursor?: string } {
	const tags = [...text.matchAll(/<pagination\b([^>]*)>/g)];
	const attrs = tags.length ? tags[tags.length - 1][1] : "";
	const cursor = attrs.match(/\bnext_cursor="([^"]*)"/)?.[1];
	return {
		hasMore: /\bhas_more="true"/.test(attrs),
		nextCursor: cursor ? decodeXmlEntities(cursor) : undefined,
	};
}
