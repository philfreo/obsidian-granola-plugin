/**
 * Node.js-based fetch implementation that bypasses browser CORS restrictions.
 * Obsidian/Electron's built-in fetch enforces CORS, but Node's https module does not.
 *
 * Node's https module only trusts its own bundled Mozilla CA list, not the OS
 * trust store. On networks with TLS-inspecting proxies (common on corporate
 * machines), this causes "self signed certificate in certificate chain"
 * errors even though the browser/OS trusts the connection fine. To fix that,
 * on macOS we pull the system's trusted root certs and pass them explicitly
 * as extra CAs for every HTTPS request.
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { execSync } from "node:child_process";

const MAX_REDIRECTS = 5;

let cachedCAs: string[] | null = null;

/** Reads trusted root certificates from the macOS keychains. Cached after first call. */
function getSystemCAs(): string[] {
	if (cachedCAs) return cachedCAs;
	if (process.platform !== "darwin") {
		cachedCAs = [];
		return cachedCAs;
	}
	try {
		const keychains = [
			"/System/Library/Keychains/SystemRootCertificates.keychain",
			"/Library/Keychains/System.keychain",
		];
		const pems: string[] = [];
		for (const kc of keychains) {
			try {
				const out = execSync(`security find-certificate -a -p "${kc}"`, {
					maxBuffer: 1024 * 1024 * 20,
				}).toString();
				const matches = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
				if (matches) pems.push(...matches);
			} catch (e) {
				// A single keychain being unreadable shouldn't block the others.
				console.error(`Granola: failed to read keychain ${kc}:`, e);
			}
		}
		cachedCAs = pems;
	} catch (e) {
		console.error("Granola: failed to read system CAs:", e);
		cachedCAs = [];
	}
	return cachedCAs;
}

export function nodeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	return doFetch(input, init, 0);
}

function doFetch(input: string | URL, init: RequestInit | undefined, redirectCount: number): Promise<Response> {
	return new Promise((resolve, reject) => {
		const url = typeof input === "string" ? new URL(input) : input;
		const isHttps = url.protocol === "https:";
		const fn = isHttps ? httpsRequest : httpRequest;

		// Convert headers
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = new Headers(init.headers);
			h.forEach((v, k) => {
				headers[k] = v;
			});
		}

		// Prepare body
		let bodyBuffer: Buffer | undefined;
		if (init?.body != null) {
			if (typeof init.body === "string") {
				bodyBuffer = Buffer.from(init.body, "utf-8");
			} else if (init.body instanceof URLSearchParams) {
				bodyBuffer = Buffer.from(init.body.toString(), "utf-8");
			} else if (init.body instanceof ArrayBuffer) {
				bodyBuffer = Buffer.from(init.body);
			} else if (ArrayBuffer.isView(init.body)) {
				bodyBuffer = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
			}
		}

		if (bodyBuffer && !headers["content-length"] && !headers["Content-Length"]) {
			headers["content-length"] = String(bodyBuffer.length);
		}

		const req = fn(
			{
				hostname: url.hostname,
				port: url.port || undefined,
				path: url.pathname + url.search,
				method: init?.method || "GET",
				headers,
				...(isHttps ? { ca: getSystemCAs() } : {}),
			},
			(res: IncomingMessage) => {
				// Handle redirects
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location &&
					redirectCount < MAX_REDIRECTS
				) {
					const redirectUrl = new URL(res.headers.location, url);
					res.resume();
					doFetch(redirectUrl, init, redirectCount + 1).then(resolve, reject);
					return;
				}

				// Build Response headers
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (value !== undefined) {
						if (Array.isArray(value)) {
							for (const v of value) responseHeaders.append(key, v);
						} else {
							responseHeaders.set(key, value);
						}
					}
				}

				// Convert Node readable stream to Web ReadableStream
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						res.on("data", (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk));
						});
						res.on("end", () => {
							controller.close();
						});
						res.on("error", (err: Error) => {
							controller.error(err);
						});
					},
					cancel() {
						res.destroy();
					},
				});

				resolve(
					new Response(body, {
						status: res.statusCode || 200,
						statusText: res.statusMessage || "",
						headers: responseHeaders,
					}),
				);
			},
		);

		req.on("error", reject);

		if (init?.signal) {
			if (init.signal.aborted) {
				req.destroy();
				reject(new DOMException("The operation was aborted", "AbortError"));
				return;
			}
			init.signal.addEventListener("abort", () => {
				req.destroy();
				reject(new DOMException("The operation was aborted", "AbortError"));
			});
		}

		if (bodyBuffer) {
			req.write(bodyBuffer);
		}

		req.end();
	});
}
