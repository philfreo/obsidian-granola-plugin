export type SyncPhase = "idle" | "listing" | "meetings" | "transcripts" | "stopping";

export interface SyncProgressState {
	phase: SyncPhase;
	current: number;
	total: number;
	message: string;
	countdownSeconds?: number;
}

export function createInitialSyncProgress(): SyncProgressState {
	return {
		phase: "idle",
		current: 0,
		total: 0,
		message: "",
	};
}

export function formatProgressMessage(state: SyncProgressState): string {
	switch (state.phase) {
		case "listing":
			return state.message || "Checking for meetings in Granola...";
		case "meetings":
			if (state.total > 0) {
				return `Syncing meetings (${state.current}/${state.total})...`;
			}
			return "Syncing meetings...";
		case "transcripts":
			if (state.countdownSeconds !== undefined && state.countdownSeconds > 0) {
				return `Syncing transcripts (${state.current}/${state.total}). Next fetch in ${state.countdownSeconds}s...`;
			}
			if (state.total > 0) {
				return `Syncing transcripts (${state.current}/${state.total})...`;
			}
			return "Syncing transcripts...";
		case "stopping":
			return "Stopping sync...";
		case "idle":
		default:
			return "";
	}
}

export function formatStatusBarText(state: SyncProgressState): string {
	switch (state.phase) {
		case "listing":
			return "Granola: Finding meetings...";
		case "meetings":
			return state.total > 0
				? `Granola: Meetings (${state.current}/${state.total})`
				: "Granola: Syncing meetings...";
		case "transcripts":
			if (state.countdownSeconds !== undefined && state.countdownSeconds > 0) {
				return `Granola: Transcripts (${state.current}/${state.total}) [${state.countdownSeconds}s]`;
			}
			return state.total > 0
				? `Granola: Transcripts (${state.current}/${state.total})`
				: "Granola: Syncing transcripts...";
		case "stopping":
			return "Granola: Stopping...";
		case "idle":
		default:
			return "";
	}
}

/**
 * Interruptible sleep that supports an AbortSignal and periodic countdown callback.
 */
export function sleep(
	ms: number,
	signal?: AbortSignal,
	onTick?: (remainingSeconds: number) => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("The operation was aborted", "AbortError"));
			return;
		}

		let timerId: number | null = null;
		let intervalId: number | null = null;

		const cleanup = () => {
			if (timerId !== null) {
				window.clearTimeout(timerId);
				timerId = null;
			}
			if (intervalId !== null) {
				window.clearInterval(intervalId);
				intervalId = null;
			}
			signal?.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			cleanup();
			reject(new DOMException("The operation was aborted", "AbortError"));
		};

		signal?.addEventListener("abort", onAbort);

		const startTime = Date.now();
		const totalSeconds = Math.ceil(ms / 1000);

		if (onTick) {
			onTick(totalSeconds);
			intervalId = window.setInterval(() => {
				const elapsed = Date.now() - startTime;
				const remaining = Math.max(0, Math.ceil((ms - elapsed) / 1000));
				onTick(remaining);
			}, 1000);
		}

		timerId = window.setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
	});
}

