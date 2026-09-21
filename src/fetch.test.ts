import { describe, it, expect, beforeEach, vi } from "vitest";

const { httpsRequestSpy, httpRequestSpy, getCACertificatesMock, tlsModuleMock } = vi.hoisted(() => {
	const getCACertificatesMock = vi.fn();
	const tlsModuleMock: { getCACertificates?: (type: string) => string[] } = {
		getCACertificates: getCACertificatesMock,
	};
	return {
		httpsRequestSpy: vi.fn(),
		httpRequestSpy: vi.fn(),
		getCACertificatesMock,
		tlsModuleMock,
	};
});

function fakeRequest() {
	return { on: vi.fn(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
}

vi.mock("node:https", () => ({
	request: (...args: unknown[]) => {
		httpsRequestSpy(...args);
		return fakeRequest();
	},
}));

vi.mock("node:http", () => ({
	request: (...args: unknown[]) => {
		httpRequestSpy(...args);
		return fakeRequest();
	},
}));

vi.mock("node:tls", () => ({ default: tlsModuleMock }));

beforeEach(() => {
	vi.resetModules();
	httpsRequestSpy.mockClear();
	httpRequestSpy.mockClear();
	getCACertificatesMock.mockReset();
	tlsModuleMock.getCACertificates = getCACertificatesMock;
});

type RequestOptions = { ca?: string[] };

describe("nodeFetch CA handling", () => {
	it("passes Node's bundled CAs plus the OS trust store as ca", async () => {
		getCACertificatesMock.mockImplementation((type: string) => (type === "default" ? ["bundled-cert"] : ["system-cert"]));
		const { nodeFetch } = await import("./fetch");

		void nodeFetch("https://example.com");

		const options = httpsRequestSpy.mock.calls[0][0] as RequestOptions;
		expect(options.ca).toEqual(["bundled-cert", "system-cert"]);
	});

	it("never passes an empty ca array", async () => {
		getCACertificatesMock.mockReturnValue([]);
		const { nodeFetch } = await import("./fetch");

		void nodeFetch("https://example.com");

		const options = httpsRequestSpy.mock.calls[0][0] as RequestOptions;
		expect(options.ca).toBeUndefined();
	});

	it("falls back to Node's defaults when tls.getCACertificates is unavailable", async () => {
		delete tlsModuleMock.getCACertificates;
		const { nodeFetch } = await import("./fetch");

		void nodeFetch("https://example.com");

		const options = httpsRequestSpy.mock.calls[0][0] as RequestOptions;
		expect(options.ca).toBeUndefined();
	});

	it("does not set ca for plain http requests", async () => {
		getCACertificatesMock.mockReturnValue(["bundled-cert"]);
		const { nodeFetch } = await import("./fetch");

		void nodeFetch("http://example.com");

		const options = httpRequestSpy.mock.calls[0][0] as RequestOptions;
		expect(options.ca).toBeUndefined();
	});
});
