// Minimal stub of the `obsidian` module so pure modules that import it
// (e.g. template.ts) can be loaded under Vitest without the real Obsidian
// runtime. Only the members our source touches are provided.

export class TFile {}

export class App {}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
