import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			// Load `.md` imports (e.g. the bundled default template) as a string,
			// mirroring the esbuild text loader used in the production build.
			name: "md-as-string",
			load(id) {
				if (id.endsWith(".md")) {
					const content = readFileSync(id, "utf-8");
					return `export default ${JSON.stringify(content)};`;
				}
			},
		},
	],
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
