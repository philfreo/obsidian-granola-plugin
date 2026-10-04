// Provide window global for Node-based Vitest runs, mirroring Obsidian's Electron environment.
if (typeof window === "undefined") {
	(globalThis as unknown as { window: unknown }).window = globalThis;
}
