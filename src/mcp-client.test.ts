import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GranolaAuthProvider } from "./auth";
import { buildListMeetingsArgs } from "./mcp-client";

describe("buildListMeetingsArgs", () => {
	it("asks for meetings the user captured or participated in", () => {
		expect(buildListMeetingsArgs("last_30_days", true)).toEqual({
			time_range: "last_30_days",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("omits the involvement filter when syncing every visible meeting", () => {
		expect(buildListMeetingsArgs("this_week", false)).toEqual({ time_range: "this_week" });
	});

	it("never sends workspace_only, which would exclude private meetings", () => {
		expect(buildListMeetingsArgs("last_week", true)).not.toHaveProperty("workspace_only");
		expect(buildListMeetingsArgs("last_week", false)).not.toHaveProperty("workspace_only");
	});

	it("builds custom date ranges for last_90_days", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_90_days", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-12-15",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("builds custom date ranges for last_180_days", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_180_days", false, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-09-16",
			custom_end: "2026-03-15",
		});
	});

	it("builds custom date ranges for last_1_year", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("last_1_year", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2025-03-15",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("builds custom date ranges for all_time starting at 2020-01-01", () => {
		const fixedDate = new Date(2026, 2, 15, 12, 0, 0); // Mar 15, 2026
		const args = buildListMeetingsArgs("all_time", true, fixedDate);
		expect(args).toEqual({
			time_range: "custom",
			custom_start: "2020-01-01",
			custom_end: "2026-03-15",
			involvement: { captured_by_me: true, listed_as_participant: true },
		});
	});

	it("includes folder_id when passed", () => {
		const args = buildListMeetingsArgs("last_30_days", true, undefined, "f_123");
		expect(args).toEqual({
			time_range: "last_30_days",
			involvement: { captured_by_me: true, listed_as_participant: true },
			folder_id: "f_123",
		});
	});
});

describe("GranolaMcpClient rate limiting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses separate rate limiters for meetings and transcripts and passes onTick", async () => {
		const { GranolaMcpClient } = await import("./mcp-client");
		const { RateLimiter } = await import("./rate-limiter");

		const meetingLimiter = new RateLimiter(100);
		const transcriptLimiter = new RateLimiter(5000);

		const mockAuth = {
			redirectUrl: "",
			clientMetadata: {} as never,
			state: async () => "",
			tokens: async () => undefined,
			saveTokens: async () => {},
			clientInformation: async () => undefined,
		};
		const client = new GranolaMcpClient(
			mockAuth as unknown as GranolaAuthProvider,
			meetingLimiter,
			transcriptLimiter,
		);

		// Mock internal MCP client
		const mockClient = {
			callTool: async () => ({
				content: [{ type: "text", text: "Speaker: hello" }],
			}),
		};
		(client as unknown as { client: typeof mockClient }).client = mockClient;

		const ticks: number[] = [];
		// Prime transcript limiter
		await transcriptLimiter.execute(async () => {});

		const p = client.getTranscript("m1", undefined, (sec) => ticks.push(sec));
		// Advance time slightly to ensure execution
		await vi.advanceTimersByTimeAsync(5000);
		const res = await p;

		expect(res).toBe("Speaker: hello");
		expect(ticks.length).toBeGreaterThan(0);
	});

	it("triggers backoff on transcriptRateLimiter when rate limit error text is returned", async () => {
		const { GranolaMcpClient } = await import("./mcp-client");
		const { RateLimiter } = await import("./rate-limiter");

		const meetingLimiter = new RateLimiter(100);
		const transcriptLimiter = new RateLimiter(1000);
		const backoffSpy = vi.spyOn(transcriptLimiter, "backoff");

		const mockAuth = {
			redirectUrl: "",
			clientMetadata: {} as never,
			state: async () => "",
			tokens: async () => undefined,
			saveTokens: async () => {},
			clientInformation: async () => undefined,
		};
		const client = new GranolaMcpClient(
			mockAuth as unknown as GranolaAuthProvider,
			meetingLimiter,
			transcriptLimiter,
		);

		let callCount = 0;
		const mockClient = {
			callTool: async () => {
				callCount++;
				if (callCount === 1) {
					return {
						content: [{ type: "text", text: "Rate limit exceeded. Please slow down requests." }],
					};
				}
				return {
					content: [{ type: "text", text: "Speaker: second attempt success" }],
				};
			},
		};
		(client as unknown as { client: typeof mockClient }).client = mockClient;

		const p = client.getTranscript("m1");
		// Advance by backoff delay (1000 * 2^0 = 1000ms)
		await vi.advanceTimersByTimeAsync(1100);
		const res = await p;

		expect(res).toBe("Speaker: second attempt success");
		expect(backoffSpy).toHaveBeenCalledWith(0);
	});

	it("calls list_meeting_folders and returns parsed folders", async () => {
		const { GranolaMcpClient } = await import("./mcp-client");
		const mockAuth = {
			redirectUrl: "",
			clientMetadata: {} as never,
			state: async () => "",
			tokens: async () => undefined,
			saveTokens: async () => {},
			clientInformation: async () => undefined,
		};
		const client = new GranolaMcpClient(mockAuth as unknown as GranolaAuthProvider);
		const mockClient = {
			callTool: async ({ name }: { name: string }) => {
				if (name === "list_meeting_folders") {
					return {
						content: [{ type: "text", text: JSON.stringify([{ folder_id: "f_1", title: "Acme" }]) }],
					};
				}
				return { content: [] };
			},
		};
		(client as unknown as { client: typeof mockClient }).client = mockClient;
		const folders = await client.listMeetingFolders();
		expect(folders).toEqual([{ id: "f_1", title: "Acme" }]);
	});

	it("returns empty array if list_meeting_folders throws", async () => {
		const { GranolaMcpClient } = await import("./mcp-client");
		const mockAuth = {
			redirectUrl: "",
			clientMetadata: {} as never,
			state: async () => "",
			tokens: async () => undefined,
			saveTokens: async () => {},
			clientInformation: async () => undefined,
		};
		const client = new GranolaMcpClient(mockAuth as unknown as GranolaAuthProvider);
		const mockClient = {
			callTool: async () => {
				throw new Error("Tool not found");
			},
		};
		(client as unknown as { client: typeof mockClient }).client = mockClient;
		const folders = await client.listMeetingFolders();
		expect(folders).toEqual([]);
	});
});

