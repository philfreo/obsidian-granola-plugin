/**
 * Node.js-based fetch implementation that bypasses browser CORS restrictions.
 * Obsidian/Electron's built-in fetch enforces CORS, but Node's https module does not.
 *
 * Node's https module only trusts its own bundled Mozilla CA list, not the OS
 * trust store. On networks with TLS-inspecting proxies (common on corporate
 * machines), this causes "self signed certificate in certificate chain"
 * errors even though the browser/OS trusts the connection fine. Where
 * available (tls.getCACertificates, Node 22.9+), we pass Node's bundled CAs
 * plus the OS trust store as extra CAs for every HTTPS request. On older
 * Node/Electron runtimes, or if reading the OS store fails, we fall back to
 * Node's default bundled-only behavior rather than risk trusting nothing.
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import tls from "node:tls";

const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_RETRY_DELAY_MS = 1500;
export const DEFAULT_MAX_RETRY_DELAY_MS = 70000;

// null = not yet computed, undefined = unavailable (use Node's defaults).
let cachedCAs: string[] | undefined | null = null;

/** Node's bundled CAs plus the OS trust store, when Node exposes them. Cached after first call. */
export function getCACertificates(): string[] | undefined {
	if (cachedCAs !== null) return cachedCAs;
	if (typeof tls.getCACertificates !== "function") {
		cachedCAs = undefined;
		return cachedCAs;
	}
	try {
		const certs = [...tls.getCACertificates("default"), ...tls.getCACertificates("system")];
		// An empty ca list would make Node trust nothing, worse than not passing it at all.
		cachedCAs = certs.length > 0 ? certs : undefined;
	} catch (e) {
		console.error("Granola: failed to read CA certificates:", e);
		cachedCAs = undefined;
	}
	return cachedCAs;
}

/** Reset cached CAs (used by unit tests). */
export function resetCachedCAs(): void {
	cachedCAs = null;
}

/**
 * Parse a Retry-After header into milliseconds.
 * Supports either integer seconds or an HTTP-date string.
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | null {
	if (!headerValue) return null;
	const trimmed = headerValue.trim();
	if (!trimmed) return null;
	const seconds = Number(trimmed);
	if (!isNaN(seconds) && seconds >= 0) {
		return seconds * 1000;
	}
	const date = new Date(trimmed);
	if (!isNaN(date.getTime())) {
		const diff = date.getTime() - Date.now();
		return Math.max(0, diff);
	}
	return null;
}

export interface RetryOptions {
	maxRetries?: number;
	baseRetryDelayMs?: number;
	maxRetryDelayMs?: number;
	randomFn?: () => number;
}

/**
 * Compute the delay for a retry attempt.
 */
export function computeRetryDelay(
	attempt: number,
	retryAfterMs: number | null,
	baseDelayMs = DEFAULT_BASE_RETRY_DELAY_MS,
	maxDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
	randomFn = Math.random,
): number {
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs + randomFn() * 250, maxDelayMs);
	}
	const backoff = baseDelayMs * Math.pow(2, attempt);
	const jitter = randomFn() * 500;
	return Math.min(backoff + jitter, maxDelayMs);
}

export async function nodeFetch(
	input: string | URL,
	init?: RequestInit,
	retryOptions?: RetryOptions,
): Promise<Response> {
	let attempt = 0;
	const maxRetries = retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES;
	const maxDelay = retryOptions?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	const baseDelay = retryOptions?.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
	const randomFn = retryOptions?.randomFn ?? Math.random;

	while (true) {
		if (init?.signal?.aborted) {
			throw new DOMException("The operation was aborted", "AbortError");
		}
		const response = await doFetch(input, init, 0);
		if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
			const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
			const delay = computeRetryDelay(attempt, retryAfter, baseDelay, maxDelay, randomFn);
			attempt++;
			// Consume body so Node releases socket
			await response.text().catch(() => {});
			await sleepWithAbort(delay, init?.signal);
			continue;
		}
		return response;
	}
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal | null): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = window.setTimeout(resolve, delayMs);

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					window.clearTimeout(timer);
					reject(new DOMException("The operation was aborted", "AbortError"));
				},
				{ once: true },
			);
		}
	});
}

function doFetch(input: string | URL, init: RequestInit | undefined, redirectCount: number): Promise<Response> {
	return new Promise((resolve, reject) => {
		const url = typeof input === "string" ? new URL(input) : input;
		const isHttps = url.protocol === "https:";
		const fn = isHttps ? httpsRequest : httpRequest;
		const ca = isHttps ? getCACertificates() : undefined;

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
				...(ca ? { ca } : {}),
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

		req.setTimeout(60000, () => {
			req.destroy(new Error("Request timed out after 60 seconds"));
		});

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
