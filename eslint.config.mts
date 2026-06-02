import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mts", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Allow "Granola" as a brand name in sentence case checks
		plugins: { obsidianmd },
		rules: {
			"obsidianmd/ui/sentence-case": [
				"error",
				{ brands: ["Granola", "Obsidian"] },
			],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"release",
		"test",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"vitest.config.ts",
		"main.js",
		"versions.json",
	]),
);
