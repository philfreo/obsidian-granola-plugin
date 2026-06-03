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
		// obsidianmd's recommended config leaks the type-aware rule
		// `no-plugin-as-component` into a globally-scoped layer, so it runs on
		// non-TS files (package.json, version-bump.mjs) that have no type
		// information and crashes. Disable it for non-TS files; the TS-scoped
		// copy of the rule still applies to src/**/*.ts.
		files: ["**/*.{js,jsx,mjs,cjs}", "package.json"],
		rules: {
			"obsidianmd/no-plugin-as-component": "off",
		},
	},
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
