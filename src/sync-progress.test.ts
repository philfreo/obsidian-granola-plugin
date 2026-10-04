import { describe, it, expect } from "vitest";
import {
	createInitialSyncProgress,
	formatProgressMessage,
	formatStatusBarText,
	sleep,
	type SyncProgressState,
} from "./sync-progress";

describe("sync-progress", () => {
	it("initializes to idle state", () => {
		const state = createInitialSyncProgress();
		expect(state.phase).toBe("idle");
		expect(state.current).toBe(0);
		expect(state.total).toBe(0);
		expect(formatProgressMessage(state)).toBe("");
		expect(formatStatusBarText(state)).toBe("");
	});

	it("formats listing phase", () => {
		const state: SyncProgressState = {
			phase: "listing",
			current: 0,
			total: 0,
			message: "Fetching meetings from Granola...",
		};
		expect(formatProgressMessage(state)).toBe("Fetching meetings from Granola...");
		expect(formatStatusBarText(state)).toBe("Granola: Finding meetings...");
	});

	it("formats meetings phase with counts", () => {
		const state: SyncProgressState = {
			phase: "meetings",
			current: 5,
			total: 20,
			message: "",
		};
		expect(formatProgressMessage(state)).toBe("Syncing meetings (5/20)...");
		expect(formatStatusBarText(state)).toBe("Granola: Meetings (5/20)");
	});

	it("formats transcripts phase with countdown", () => {
		const state: SyncProgressState = {
			phase: "transcripts",
			current: 2,
			total: 10,
			message: "",
			countdownSeconds: 45,
		};
		expect(formatProgressMessage(state)).toBe(
			"Syncing transcripts (2/10). Next fetch in 45s...",
		);
		expect(formatStatusBarText(state)).toBe(
			"Granola: Transcripts (2/10) [45s]",
		);
	});

	it("formats transcripts phase without countdown", () => {
		const state: SyncProgressState = {
			phase: "transcripts",
			current: 2,
			total: 10,
			message: "",
		};
		expect(formatProgressMessage(state)).toBe("Syncing transcripts (2/10)...");
		expect(formatStatusBarText(state)).toBe("Granola: Transcripts (2/10)");
	});

	it("formats stopping phase", () => {
		const state: SyncProgressState = {
			phase: "stopping",
			current: 0,
			total: 0,
			message: "",
		};
		expect(formatProgressMessage(state)).toBe("Stopping sync...");
		expect(formatStatusBarText(state)).toBe("Granola: Stopping...");
	});

	describe("sleep", () => {
		it("resolves after delay", async () => {
			const start = Date.now();
			await sleep(20);
			expect(Date.now() - start).toBeGreaterThanOrEqual(15);
		});

		it("rejects immediately if signal already aborted", async () => {
			const controller = new AbortController();
			controller.abort();
			await expect(sleep(1000, controller.signal)).rejects.toThrow("aborted");
		});

		it("rejects when signal aborts during sleep", async () => {
			const controller = new AbortController();
			const p = sleep(1000, controller.signal);
			controller.abort();
			await expect(p).rejects.toThrow("aborted");
		});
	});
});
