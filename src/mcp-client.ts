import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GranolaAuthProvider } from "./auth";
import { nodeFetch } from "./fetch";

const MCP_SERVER_URL = "https://mcp.granola.ai/mcp";

export type SyncTimeRange = "this_week" | "last_week" | "last_30_days";

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
 */
export function buildListMeetingsArgs(
	timeRange: SyncTimeRange,
	onlyMyMeetings: boolean,
): Record<string, unknown> {
	const args: Record<string, unknown> = { time_range: timeRange };
	if (onlyMyMeetings) {
		args.involvement = { captured_by_me: true, listed_as_participant: true };
	}
	return args;
}

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

	async listMeetings(timeRange: SyncTimeRange, onlyMyMeetings: boolean): Promise<string> {
		return this.callToolText("list_meetings", buildListMeetingsArgs(timeRange, onlyMyMeetings));
	}

	/**
	 * `attachments` is passed either way rather than left to Granola's default:
	 * "none" keeps the response free of image descriptions nobody will read.
	 */
	async getMeetings(meetingIds: string[], attachments: "list" | "none"): Promise<string> {
		return this.callToolText("get_meetings", { meeting_ids: meetingIds, attachments });
	}

	/**
	 * One attachment's image, as the base64 Granola sends inline.
	 *
	 * Asked for one at a time: a response holds about 6 MB of images, so a
	 * batch of full-size screenshots comes back partly deferred, and a single
	 * image needs no pairing of pictures with their metadata. The signed URL
	 * alongside it is ignored, since the image is already here.
	 */
	async getAttachmentImage(meetingId: string, attachmentId: string): Promise<AttachmentImage> {
		const content = await this.callToolContent("get_meeting_attachment", {
			meeting_id: meetingId,
			attachment_id: attachmentId,
		});
		const image = content.find((c) => c.type === "image" && typeof c.data === "string");
		if (!image) {
			const text = content.map((c) => c.text ?? "").join("\n").trim();
			throw new Error(`No image for attachment ${attachmentId}: ${text || "empty response"}`);
		}
		return { data: image.data!, mimeType: image.mimeType ?? "" };
	}

	async getTranscript(meetingId: string): Promise<string> {
		return this.callToolText("get_meeting_transcript", { meeting_id: meetingId });
	}

	async getAccountInfo(): Promise<string> {
		return this.callToolText("get_account_info", {});
	}

	private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
		return (await this.callToolContent(name, args))
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text!)
			.join("\n");
	}

	private async callToolContent(name: string, args: Record<string, unknown>): Promise<ToolContent[]> {
		if (!this.client) {
			throw new Error("Not connected to Granola");
		}
		const result = await this.client.callTool({ name, arguments: args });
		return result.content as ToolContent[];
	}
}

/** A block of a tool result: text, or an image as base64 with its MIME type. */
interface ToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface AttachmentImage {
	/** Base64-encoded image bytes. */
	data: string;
	mimeType: string;
}
