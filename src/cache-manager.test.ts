import { describe, it, expect, beforeEach } from "vitest";
import {
	GranolaCacheStore,
	type CacheAdapter,
	type CachedMeetingRecord,
} from "./cache-manager";

class MemoryCacheAdapter implements CacheAdapter {
	private files = new Map<string, string>();
	private directories = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.directories.has(path);
	}

	async read(path: string): Promise<string> {
		const content = this.files.get(path);
		if (content === undefined) {
			throw new Error(`File not found: ${path}`);
		}
		return content;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async mkdir(path: string): Promise<void> {
		this.directories.add(path);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const files: string[] = [];
		const folders: string[] = [];
		for (const key of this.files.keys()) {
			if (key.startsWith(path)) {
				files.push(key);
			}
		}
		for (const key of this.directories.keys()) {
			if (key !== path && key.startsWith(path)) {
				folders.push(key);
			}
		}
		return { files, folders };
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.directories.delete(path);
	}
}

describe("GranolaCacheStore", () => {
	let adapter: MemoryCacheAdapter;
	let store: GranolaCacheStore;

	const sampleMeeting: CachedMeetingRecord = {
		id: "meeting-123",
		title: "Engineering Sync",
		date: "2026-03-03",
		startTime: "10:00 AM",
		created: "2026-03-03T10:00:00.000Z",
		url: "https://granola.ai/meetings/123",
		folder: "Engineering",
		participants: [
			{
				name: "Alice",
				email: "alice@example.com",
				organization: "Acme",
				isCreator: true,
			},
		],
		privateNotes: "Discussed roadmap",
		enhancedNotes: "### Summary\nRoadmap finalized.",
		lastSyncedAt: "2026-03-03T11:00:00.000Z",
	};

	beforeEach(() => {
		adapter = new MemoryCacheAdapter();
		store = new GranolaCacheStore(adapter, "test-config/plugins/granola/cache");
	});

	it("initializes directories and checks non-existent entries", async () => {
		expect(await store.hasMeeting("meeting-123")).toBe(false);
		expect(await store.hasTranscript("meeting-123")).toBe(false);
		expect(await store.getMeeting("meeting-123")).toBeNull();
		expect(await store.getTranscript("meeting-123")).toBeNull();
	});

	it("saves and retrieves a meeting record", async () => {
		await store.saveMeeting(sampleMeeting);

		expect(await store.hasMeeting("meeting-123")).toBe(true);
		const retrieved = await store.getMeeting("meeting-123");
		expect(retrieved).toEqual(sampleMeeting);
	});

	it("saves and retrieves transcripts in a separate file", async () => {
		await store.saveMeeting(sampleMeeting);
		await store.saveTranscript("meeting-123", "Alice: Hello everyone\nBob: Hi Alice");

		expect(await store.hasTranscript("meeting-123")).toBe(true);
		const transcript = await store.getTranscript("meeting-123");
		expect(transcript).toBe("Alice: Hello everyone\nBob: Hi Alice");

		// Meeting file itself should not have the transcript embedded
		const retrievedMeeting = await store.getMeeting("meeting-123");
		expect(retrievedMeeting).not.toBeNull();
		expect(Object.prototype.hasOwnProperty.call(retrievedMeeting, "transcript")).toBe(false);
	});

	it("lists all cached meetings and transcript IDs", async () => {
		await store.saveMeeting(sampleMeeting);
		await store.saveMeeting({
			...sampleMeeting,
			id: "meeting-456",
			title: "Design Review",
		});
		await store.saveTranscript("meeting-456", "Design review transcript");

		const meetings = await store.listMeetings();
		expect(meetings.length).toBe(2);
		expect(meetings.map((m) => m.id).sort()).toEqual(["meeting-123", "meeting-456"]);

		const transcriptIds = await store.listTranscriptIds();
		expect(transcriptIds.size).toBe(1);
		expect(transcriptIds.has("meeting-456")).toBe(true);
	});

	it("reports accurate stats and clears cache", async () => {
		await store.saveMeeting(sampleMeeting);
		await store.saveTranscript("meeting-123", "Transcript text");

		let stats = await store.getStats();
		expect(stats.meetingCount).toBe(1);
		expect(stats.transcriptCount).toBe(1);

		await store.clear();

		stats = await store.getStats();
		expect(stats.meetingCount).toBe(0);
		expect(stats.transcriptCount).toBe(0);
		expect(await store.hasMeeting("meeting-123")).toBe(false);
		expect(await store.hasTranscript("meeting-123")).toBe(false);
	});
});
