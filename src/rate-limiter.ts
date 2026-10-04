/**
 * Proactive request scheduler / rate limiter.
 *
 * Granola's MCP API enforces an average limit of ~100 requests per minute for meetings
 * and a significantly stricter rate limit for transcripts (~1 per minute).
 * To avoid hitting rate limits during batch operations, this scheduler ensures
 * a minimum delay between consecutive requests, with exponential base-multiple backoff,
 * countdown progress ticks, and immediate abort signal handling.
 */

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(signal.reason ? String(signal.reason) : "Aborted"));
			return;
		}
		let timeoutId: number | undefined;
		let onAbort: (() => void) | undefined;

		const cleanup = () => {
			if (timeoutId !== undefined) {
				window.clearTimeout(timeoutId);
			}
			if (signal && onAbort) {
				signal.removeEventListener("abort", onAbort);
			}
		};

		timeoutId = window.setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		if (signal) {
			onAbort = () => {
				cleanup();
				reject(new Error(signal.reason ? String(signal.reason) : "Aborted"));
			};
			signal.addEventListener("abort", onAbort);
		}
	});
}

export interface RateLimiterOptions {
	baseIntervalMs?: number;
	maxBackoffMs?: number;
}

export interface ExecuteOptions {
	signal?: AbortSignal;
	onTick?: (secondsRemaining: number) => void;
}

export class RateLimiter {
	public readonly baseIntervalMs: number;
	public readonly maxBackoffMs?: number;
	private nextAllowedTime = 0;
	private queue: Promise<void> = Promise.resolve();

	/**
	 * @param options Base interval in ms (number) or options object. Default is 650ms.
	 */
	constructor(options: number | RateLimiterOptions = 650) {
		if (typeof options === "number") {
			this.baseIntervalMs = options;
		} else {
			this.baseIntervalMs = options.baseIntervalMs ?? 650;
			this.maxBackoffMs = options.maxBackoffMs;
		}
	}

	/**
	 * Queue an async operation to execute after the minimum interval has passed.
	 */
	execute<T>(fn: () => Promise<T>, options?: ExecuteOptions): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue = this.queue.then(async () => {
				let executed = false;
				try {
					let waited = false;
					let now = Date.now();
					while (now < this.nextAllowedTime) {
						waited = true;
						if (options?.signal?.aborted) {
							throw new Error(options?.signal?.reason ? String(options.signal.reason) : "Aborted");
						}
						const remainingMs = this.nextAllowedTime - now;
						if (options?.onTick) {
							options.onTick(Math.ceil(remainingMs / 1000));
						}
						const sleepMs = Math.min(remainingMs, 1000);
						await waitWithAbort(sleepMs, options?.signal);
						now = Date.now();
					}

					if (waited && options?.onTick) {
						options.onTick(0);
					}

					if (options?.signal?.aborted) {
						throw new Error(options?.signal?.reason ? String(options.signal.reason) : "Aborted");
					}

					executed = true;
					const res = await fn();
					resolve(res);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				} finally {
					if (executed) {
						this.nextAllowedTime = Math.max(this.nextAllowedTime, Date.now() + this.baseIntervalMs);
					}
				}
			}).catch(() => {
				// Ensure queue chain continues even on error
			});
		});
	}

	/**
	 * Temporarily pause the queue for a backoff duration.
	 * If attempt is an integer <= 20, backoff is calculated as:
	 *   baseIntervalMs * 2^attempt
	 * Otherwise durationMs is used directly.
	 * Non-blocking and synchronous to prevent cyclic promise deadlocks.
	 */
	backoff(attemptOrDuration = 0): void {
		let durationMs: number;
		if (attemptOrDuration <= 20 && Number.isInteger(attemptOrDuration)) {
			durationMs = this.baseIntervalMs * Math.pow(2, attemptOrDuration);
		} else {
			durationMs = attemptOrDuration;
		}

		if (this.maxBackoffMs) {
			durationMs = Math.min(durationMs, this.maxBackoffMs);
		}

		const target = Date.now() + durationMs;
		if (target > this.nextAllowedTime) {
			this.nextAllowedTime = target;
		}
	}

	/**
	 * Reset the scheduler state.
	 */
	reset(): void {
		this.nextAllowedTime = 0;
		this.queue = Promise.resolve();
	}
}
