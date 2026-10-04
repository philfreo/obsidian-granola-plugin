import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "./rate-limiter";

describe("RateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("executes the first request immediately", async () => {
		const limiter = new RateLimiter(500);

		const promise = limiter.execute(async () => "done");
		await vi.advanceTimersByTimeAsync(0);

		expect(await promise).toBe("done");
	});

	it("paces consecutive requests according to minIntervalMs", async () => {
		const limiter = new RateLimiter(200);
		const results: number[] = [];

		const p1 = limiter.execute(async () => {
			results.push(Date.now());
		});
		const p2 = limiter.execute(async () => {
			results.push(Date.now());
		});

		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(results.length).toBe(1);

		// Advance timer by 100ms (not yet 200ms)
		await vi.advanceTimersByTimeAsync(100);
		expect(results.length).toBe(1);

		// Advance timer past 200ms
		await vi.advanceTimersByTimeAsync(150);
		await p2;
		expect(results.length).toBe(2);
	});

	it("applies backoff delay to subsequent requests", async () => {
		const limiter = new RateLimiter(100);
		const timestamps: number[] = [];

		const p1 = limiter.execute(async () => {
			timestamps.push(Date.now());
		});
		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(timestamps.length).toBe(1);

		// Trigger backoff of 500ms
		limiter.backoff(500);

		const nextPromise = limiter.execute(async () => {
			timestamps.push(Date.now());
		});

		// Advance by 300ms — should still be waiting for backoff
		await vi.advanceTimersByTimeAsync(300);
		expect(timestamps.length).toBe(1);

		// Advance remaining 300ms
		await vi.advanceTimersByTimeAsync(300);
		await nextPromise;
		expect(timestamps.length).toBe(2);
	});

	it("does not deadlock if backoff is called inside an execute task", async () => {
		const limiter = new RateLimiter(50);
		let completed = false;

		const p = limiter.execute(async () => {
			limiter.backoff(100);
			completed = true;
			return "ok";
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(completed).toBe(true);
		expect(await p).toBe("ok");
	});

	it("continues processing subsequent tasks even if one throws", async () => {
		const limiter = new RateLimiter(50);

		const p1 = limiter.execute(async () => {
			throw new Error("task failed");
		});

		const p2 = limiter.execute(async () => {
			return "second ok";
		});

		const p1Assertion = expect(p1).rejects.toThrow("task failed");
		await vi.advanceTimersByTimeAsync(0);
		await p1Assertion;

		await vi.advanceTimersByTimeAsync(60);
		expect(await p2).toBe("second ok");
	});

	it("persists pacing across start/stop/start cycles so a second sync within base interval waits", async () => {
		const limiter = new RateLimiter({ baseIntervalMs: 65000 });

		// Sync 1 runs and fetches an item
		let firstRan = false;
		await limiter.execute(async () => {
			firstRan = true;
		});
		expect(firstRan).toBe(true);

		// Now simulate 15 seconds passing (e.g. sync stopped and user clicks Sync now 15s later)
		await vi.advanceTimersByTimeAsync(15000);

		// Sync 2 starts
		let secondRan = false;
		const p2 = limiter.execute(async () => {
			secondRan = true;
		});

		// At T=15s (only 15s elapsed out of 65s), p2 must NOT have run yet
		await vi.advanceTimersByTimeAsync(0);
		expect(secondRan).toBe(false);

		// Advance 40s (total 55s, still not 65s)
		await vi.advanceTimersByTimeAsync(40000);
		expect(secondRan).toBe(false);

		// Advance remaining 10s (total 65s)
		await vi.advanceTimersByTimeAsync(10000);
		await p2;
		expect(secondRan).toBe(true);
	});

	it("calculates exponential backoff as a multiple of baseIntervalMs", async () => {
		const limiter = new RateLimiter({ baseIntervalMs: 65000 });

		let ran = false;
		await limiter.execute(async () => {
			ran = true;
		});
		expect(ran).toBe(true);

		// Backoff attempt 0: should back off by 1x baseIntervalMs (65,000ms)
		limiter.backoff(0);

		let pAfterBackoffRan = false;
		const p = limiter.execute(async () => {
			pAfterBackoffRan = true;
		});

		// Advance 60s - should not run yet
		await vi.advanceTimersByTimeAsync(60000);
		expect(pAfterBackoffRan).toBe(false);

		// Advance remaining 5s (total 65s)
		await vi.advanceTimersByTimeAsync(5000);
		await p;
		expect(pAfterBackoffRan).toBe(true);
	});

	it("aborts waiting immediately when AbortSignal fires", async () => {
		const limiter = new RateLimiter({ baseIntervalMs: 65000 });
		await limiter.execute(async () => {});

		const controller = new AbortController();
		const p = limiter.execute(async () => "result", { signal: controller.signal });

		// Abort after 2 seconds
		await vi.advanceTimersByTimeAsync(2000);
		controller.abort();

		await expect(p).rejects.toThrow();
	});

	it("calls onTick with remaining seconds while waiting for pacing", async () => {
		const limiter = new RateLimiter({ baseIntervalMs: 3000 });
		await limiter.execute(async () => {});

		const ticks: number[] = [];
		const p = limiter.execute(async () => "done", {
			onTick: (sec) => ticks.push(sec),
		});

		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		await p;

		expect(ticks.length).toBeGreaterThan(0);
	});
});
