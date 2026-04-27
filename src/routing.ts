import type { MeetingData } from "./response-parser";
import type { RoutingRule } from "./settings";

const SLASH_SYNTAX = /^\/(.+)\/([gimsuy]*)$/;
const DEFAULT_FLAGS = "i";

export function buildHaystack(meeting: MeetingData): string {
	const orgs = meeting.participants.map((p) => p.organization).filter(Boolean);
	const emails = meeting.participants.map((p) => p.email).filter(Boolean);
	const names = meeting.participants.map((p) => p.name).filter(Boolean);
	return [
		`TITLE: ${meeting.title}`,
		`ORG: ${orgs.join(", ")}`,
		`EMAIL: ${emails.join(", ")}`,
		`NAME: ${names.join(", ")}`,
	].join("\n");
}

interface ParsedLine {
	source: string;
	flags: string;
}

function parseLine(line: string): ParsedLine {
	const m = line.match(SLASH_SYNTAX);
	if (m) return { source: m[1], flags: m[2] || DEFAULT_FLAGS };
	return { source: line, flags: DEFAULT_FLAGS };
}

function splitNonBlankLines(pattern: string): { line: string; index: number }[] {
	const out: { line: string; index: number }[] = [];
	pattern.split("\n").forEach((raw, i) => {
		const trimmed = raw.trim();
		if (trimmed) out.push({ line: trimmed, index: i + 1 });
	});
	return out;
}

export function compileRule(rule: RoutingRule): RegExp[] {
	const compiled: RegExp[] = [];
	for (const { line } of splitNonBlankLines(rule.pattern)) {
		const { source, flags } = parseLine(line);
		try {
			compiled.push(new RegExp(source, flags));
		} catch {
			// Skip invalid line; the editor surfaces the error.
		}
	}
	return compiled;
}

export interface PatternError {
	line: number;
	message: string;
}

export function validateRulePattern(pattern: string): { errors: PatternError[] } {
	const errors: PatternError[] = [];
	for (const { line, index } of splitNonBlankLines(pattern)) {
		const { source, flags } = parseLine(line);
		try {
			new RegExp(source, flags);
		} catch (e) {
			errors.push({
				line: index,
				message: e instanceof Error ? e.message : "Invalid regex",
			});
		}
	}
	return { errors };
}

export function resolveFolder(
	meeting: MeetingData,
	rules: RoutingRule[],
	defaultFolder: string,
): string {
	const haystack = buildHaystack(meeting);
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (!rule.destinationFolder.trim()) continue;
		const compiled = compileRule(rule);
		if (compiled.some((regex) => regex.test(haystack))) {
			return rule.destinationFolder.trim().replace(/^\/+/, "");
		}
	}
	return defaultFolder;
}
