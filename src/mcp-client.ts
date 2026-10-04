import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GranolaAuthProvider } from "./auth";
import { nodeFetch } from "./fetch";
import { RateLimiter } from "./rate-limiter";
import {
	isTranscriptErrorResponse,
	parseMeetingFoldersResponse,
	type ParsedFolder,
} from "./response-parser";
import { sleep } from "./sync-progress";

const MCP_SERVER_URL = "https://mcp.granola.ai/mcp";

export type SyncTimeRange =
	| "this_week"
	| "last_week"
	| "last_30_days"
	| "last_90_days"
	| "last_180_days"
	| "last_1_year"
	| "all_time";

function formatDateIso(d: Date): string {
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Build the list_meetings arguments.
 *
 * With no involvement filter the API returns every meeting the account can
 * see, which includes workspace-visible meetings the user neither recorded
 * nor attended. Setting both involvement conditions to true asks for
 * "captured by me OR listed as a participant" — the two ways the user is
 * actually part of a meeting — which keeps notes shared with them by a
 * colleague while dropping the rest of the workspace.
 *
 * `workspace_only` is deliberately never sent: it is an AND filter that
 * would restrict the results to workspace-visible meetings only.
 *
 * For ranges beyond 30 days, Granola's "custom" time_range is used with
 * custom_start and custom_end in ISO format.
 */
export function buildListMeetingsArgs(
	timeRange: SyncTimeRange,
	onlyMyMeetings: boolean,
	now: Date = new Date(),
	folderId?: string,
): Record<string, unknown> {
	const args: Record<string, unknown> = {};

	if (timeRange === "this_week" || timeRange === "last_week" || timeRange === "last_30_days") {
		args.time_range = timeRange;
	} else {
		args.time_range = "custom";
		const end = formatDateIso(now);
		let start: string;

		if (timeRange === "last_90_days") {
			const d = new Date(now.getTime());
			d.setDate(d.getDate() - 90);
			start = formatDateIso(d);
		} else if (timeRange === "last_180_days") {
			const d = new Date(now.getTime());
			d.setDate(d.getDate() - 180);
			start = formatDateIso(d);
		} else if (timeRange === "last_1_year") {
			const d = new Date(now.getTime());
			d.setDate(d.getDate() - 365);
			start = formatDateIso(d);
		} else {
			// all_time: Granola launched in 2023, 2020-01-01 safely covers all possible meetings
			start = "2020-01-01";
		}

		args.custom_start = start;
		args.custom_end = end;
	}

	if (onlyMyMeetings) {
		args.involvement = { captured_by_me: true, listed_as_participant: true };
	}
	if (folderId) {
		args.folder_id = folderId;
	}
	return args;
}

export class GranolaMcpClient {
	private client: Client | null = null;
	private authProvider: GranolaAuthProvider;
	private rateLimiter: RateLimiter;
	private transcriptRateLimiter: RateLimiter;

	constructor(
		authProvider: GranolaAuthProvider,
		rateLimiter = new RateLimiter(),
		transcriptRateLimiter?: RateLimiter,
	) {
		this.authProvider = authProvider;
		this.rateLimiter = rateLimiter;
		this.transcriptRateLimiter =
			transcriptRateLimiter ?? new RateLimiter({ baseIntervalMs: 65000 });
	}

	get isConnected(): boolean {
		return this.client !== null;
	}

	async connect(): Promise<void> {
		await this.disconnect();
		this.client = new Client({
			name: "obsidian-granola-sync",
			version: "2.0.0",
		});
		const transport = new StreamableHTTPClientTransport(
			new URL(MCP_SERVER_URL),
			{ authProvider: this.authProvider, fetch: nodeFetch },
		);
		try {
			await this.client.connect(transport);
		} catch (e) {
			this.client = null;
			throw e;
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
			} catch {
				// ignore close errors
			}
			this.client = null;
		}
	}

	async finishAuth(authorizationCode: string): Promise<void> {
		// Create a transport just for the token exchange.
		// It uses the same authProvider which has the code verifier from the auth flow.
		const transport = new StreamableHTTPClientTransport(
			new URL(MCP_SERVER_URL),
			{ authProvider: this.authProvider, fetch: nodeFetch },
		);
		await transport.finishAuth(authorizationCode);
	}

	async listMeetings(
		timeRange: SyncTimeRange,
		onlyMyMeetings: boolean,
		signal?: AbortSignal,
		folderId?: string,
	): Promise<string> {
		return this.callToolText(
			this.rateLimiter,
			"list_meetings",
			buildListMeetingsArgs(timeRange, onlyMyMeetings, undefined, folderId),
			2,
			signal,
		);
	}

	async listMeetingFolders(signal?: AbortSignal): Promise<ParsedFolder[]> {
		try {
			const text = await this.callToolText(
				this.rateLimiter,
				"list_meeting_folders",
				{},
				2,
				signal,
			);
			return parseMeetingFoldersResponse(text);
		} catch (error) {
			if (signal?.aborted) throw error;
			console.warn("Granola: list_meeting_folders unavailable or failed", error);
			return [];
		}
	}

	async getMeetings(meetingIds: string[], signal?: AbortSignal): Promise<string> {
		return this.callToolText(
			this.rateLimiter,
			"get_meetings",
			{ meeting_ids: meetingIds },
			2,
			signal,
		);
	}

	async getTranscript(
		meetingId: string,
		signal?: AbortSignal,
		onTick?: (remainingSeconds: number) => void,
	): Promise<string> {
		return this.callToolText(
			this.transcriptRateLimiter,
			"get_meeting_transcript",
			{ meeting_id: meetingId },
			2,
			signal,
			onTick,
		);
	}

	async getAccountInfo(signal?: AbortSignal): Promise<string> {
		return this.callToolText(this.rateLimiter, "get_account_info", {}, 2, signal);
	}

	private async callToolText(
		limiter: RateLimiter,
		name: string,
		args: Record<string, unknown>,
		retries = 2,
		signal?: AbortSignal,
		onTick?: (remainingSeconds: number) => void,
	): Promise<string> {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted", "AbortError");
		}
		return limiter.execute(
			async () => {
				for (let attempt = 0; attempt <= retries; attempt++) {
					if (signal?.aborted) {
						throw new DOMException("The operation was aborted", "AbortError");
					}
					if (!this.client) {
						throw new Error("Not connected to Granola");
					}
					const result = await this.client.callTool(
						{ name, arguments: args },
						undefined,
						signal ? { signal } : undefined,
					);
					const text = (result.content as Array<{ type: string; text?: string }>)
						.filter((c) => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text!)
						.join("\n");

					if (isTranscriptErrorResponse(text)) {
						if (attempt < retries) {
							limiter.backoff(attempt);
							const delay = limiter.baseIntervalMs * Math.pow(2, attempt);
							await sleep(delay, signal);
							continue;
						}
						throw new Error(`Granola rate limit: ${text.trim()}`);
					}

					return text;
				}
				throw new Error("Tool execution failed after retries");
			},
			{ signal, onTick },
		);
	}
}
