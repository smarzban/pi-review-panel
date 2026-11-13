import { execFileSync } from "node:child_process";

import {
	type Changeset,
	computeSuggestions,
	type Suggestion,
} from "./suggest.js";

function git(repoDir: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

const C_ESCAPES: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	"\\": 92,
};

/**
 * Undo git's C-style quoting of a path (`"src/a\tb.ts"`, octal bytes for
 * anything else git escapes). Returns undefined for text that is not one
 * whole quoted string. Never throws: suggestions fail open.
 */
export function unquoteGitPath(quoted: string): string | undefined {
	if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) {
		return undefined;
	}
	const bytes: number[] = [];
	const body = quoted.slice(1, -1);
	for (let index = 0; index < body.length; index += 1) {
		const char = body[index] as string;
		if (char === '"') {
			return undefined;
		}
		if (char !== "\\") {
			bytes.push(...Buffer.from(char, "utf8"));
			continue;
		}
		const next = body[index + 1];
		if (next === undefined) {
			return undefined;
		}
		const octal = /^[0-3][0-7]{2}/.exec(body.slice(index + 1));
		if (octal !== null) {
			bytes.push(Number.parseInt(octal[0], 8));
			index += 3;
			continue;
		}
		const escaped = C_ESCAPES[next];
		if (escaped === undefined) {
			return undefined;
		}
		bytes.push(escaped);
		index += 1;
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * The new-side path a `+++ ` header names, or "" for `/dev/null` or a
 * header this parser does not understand. An unquoted name with a space
 * carries a trailing tab from git; a name holding a real tab is quoted.
 */
function newSidePath(header: string): string {
	const raw = header.slice("+++ ".length);
	const name = raw.startsWith('"')
		? unquoteGitPath(raw)
		: raw.endsWith("\t")
			? raw.slice(0, -1)
			: raw;
	if (name === undefined || !name.startsWith("b/")) {
		return "";
	}
	return name.slice("b/".length);
}

/**
 * Parse a unified diff into added-line records. A `+++ ` line names a file
 * only in the header between `diff --git` and the first hunk; inside a hunk
 * every line is content, so an added line reading `++ b/x` stays content.
 */
export function parseAddedLines(diff: string): Changeset["addedLines"] {
	const added: Changeset["addedLines"] = [];
	let file = "";
	let inHeader = false;
	let newLine = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHeader = true;
			file = "";
			continue;
		}
		if (inHeader) {
			if (line.startsWith("+++ ")) {
				file = newSidePath(line);
				continue;
			}
			if (!line.startsWith("@@")) {
				continue;
			}
			inHeader = false;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk !== null) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (file === "") {
			continue;
		}
		if (line.startsWith("+")) {
			added.push({ file, line: newLine, text: line.slice(1) });
			newLine += 1;
			continue;
		}
		if (line.startsWith(" ")) {
			newLine += 1;
		}
	}
	return added;
}

/**
 * Git options that keep the diff machine-readable whatever the user's git
 * config says: paths unquoted except where git must (tab, newline, quote,
 * backslash), the standard `a/` and `b/` prefixes, no colour, no external
 * diff or text conversion.
 */
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv"];

export function buildChangeset(
	repoDir: string,
	baseOid: string,
	headOid: string,
): Changeset {
	const range = `${baseOid}...${headOid}`;
	const names = git(repoDir, [
		"-c",
		"core.quotePath=false",
		"diff",
		"--name-only",
		"-z",
		...DIFF_OPTIONS,
		range,
	]);
	const files = names.split("\0").filter((name) => name.length > 0);
	const diff = git(repoDir, [
		"-c",
		"core.quotePath=false",
		"diff",
		"-U0",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		...DIFF_OPTIONS,
		range,
	]);
	return { files, addedLines: parseAddedLines(diff) };
}

/** Fail-open: a git failure becomes no suggestions. */
export function suggestLenses(
	repoDir: string,
	baseOid: string,
	headOid: string,
): Suggestion[] {
	try {
		return computeSuggestions(buildChangeset(repoDir, baseOid, headOid));
	} catch {
		return [];
	}
}
