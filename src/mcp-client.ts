import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GranolaAuthProvider } from "./auth";
import { nodeFetch } from "./fetch";

const MCP_SERVER_URL = "https://mcp.granola.ai/mcp";

export type SyncTimeRange = "this_week" | "last_week" | "last_30_days";

export class GranolaMcpClient {
	private client: Client | null = null;
	private authProvider: GranolaAuthProvider;

	constructor(authProvider: GranolaAuthProvider) {
		this.authProvider = authProvider;
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

	async listMeetings(timeRange: SyncTimeRange): Promise<string> {
		return this.callToolText("list_meetings", { time_range: timeRange });
	}

	async getMeetings(meetingIds: string[]): Promise<string> {
		return this.callToolText("get_meetings", { meeting_ids: meetingIds });
	}

	async getTranscript(meetingId: string): Promise<string> {
		return this.callToolText("get_meeting_transcript", { meeting_id: meetingId });
	}

	private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this.client) {
			throw new Error("Not connected to Granola");
		}
		const result = await this.client.callTool({ name, arguments: args });
		return (result.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text!)
			.join("\n");
	}
}
