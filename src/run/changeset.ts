import { execFileSync } from "node:child_process";

import {
	type Changeset,
	computeSuggestions,
	type Suggestion,
	type SuggestionsUnavailable,
} from "./suggest.js";

/**
 * How much `git diff` output the rules read before giving up: 32 MiB. The
 * panel runs inside the host's process, so the diff and its parse must stay
 * small enough never to exhaust that process's memory.
 */
export const MAX_DIFF_BYTES = 32 * 1024 * 1024;

/**
 * How many added lines the rules hold. Memory grows with the line count, not
 * the byte count (a file of short lines is small in git but huge as records),
 * so a diff over this is reported as unavailable instead of parsed whole.
 */
export const MAX_ADDED_LINES = 200_000;

/** The diff could not be read; the message is the cause, for the reply. */
class DiffUnreadable extends Error {}

function git(repoDir: string, args: string[], maxBytes: number): string {
	try {
		return execFileSync("git", args, {
			cwd: repoDir,
			encoding: "utf8",
			maxBuffer: maxBytes,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (error) {
		throw new DiffUnreadable(gitFailureCause(error, maxBytes));
	}
}

function gitFailureCause(error: unknown, maxBytes: number): string {
	const failure = error as NodeJS.ErrnoException & {
		status?: number | null;
		signal?: string | null;
	};
	// execFileSync reports output over maxBuffer as ENOBUFS (and kills git).
	if (
		failure.code === "ENOBUFS" ||
		failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
	) {
		return `the diff is over ${formatBytes(maxBytes)}`;
	}
	if (typeof failure.status === "number") {
		return `git diff exited with status ${failure.status}`;
	}
	if (typeof failure.signal === "string") {
		return `git diff was stopped by ${failure.signal}`;
	}
	if (typeof failure.code === "string") {
		return `git could not run (${failure.code})`;
	}
	return "git diff failed";
}

function formatBytes(bytes: number): string {
	const mib = 1024 * 1024;
	return bytes >= mib && bytes % mib === 0
		? `${bytes / mib} MiB`
		: `${bytes} bytes`;
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
 * whole quoted string. Never throws.
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
	let start = 0;
	while (start <= diff.length) {
		const end = diff.indexOf("\n", start);
		const line = diff.slice(start, end === -1 ? diff.length : end);
		start = end === -1 ? diff.length + 1 : end + 1;
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
			if (added.length >= MAX_ADDED_LINES) {
				throw new DiffUnreadable(
					`the diff adds over ${MAX_ADDED_LINES.toLocaleString("en-US")} lines`,
				);
			}
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
 * config or the repository's attributes say: paths unquoted except where git
 * must (tab, newline, quote, backslash), the standard `a/` and `b/` prefixes,
 * no colour, no external diff or text conversion, and every file diffed as
 * text, so a NUL byte or a `-diff` attribute cannot hide added lines.
 */
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--text"];

export function buildChangeset(
	repoDir: string,
	baseOid: string,
	headOid: string,
	options: { maxDiffBytes?: number } = {},
): Changeset {
	const maxBytes = options.maxDiffBytes ?? MAX_DIFF_BYTES;
	const range = `${baseOid}...${headOid}`;
	const names = git(
		repoDir,
		[
			"-c",
			"core.quotePath=false",
			"diff",
			"--name-only",
			"-z",
			...DIFF_OPTIONS,
			range,
		],
		maxBytes,
	);
	const files = names.split("\0").filter((name) => name.length > 0);
	const diff = git(
		repoDir,
		[
			"-c",
			"core.quotePath=false",
			"diff",
			"-U0",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			...DIFF_OPTIONS,
			range,
		],
		maxBytes,
	);
	return { files, addedLines: parseAddedLines(diff) };
}

/**
 * The rules' suggestions, or why the diff could not be read. A diff that
 * could not be read never reads as "no rule matched": no rule ran. Never
 * throws, so a review that already ran still gets its reply.
 */
export function suggestLenses(
	repoDir: string,
	baseOid: string,
	headOid: string,
	options: { maxDiffBytes?: number } = {},
): Suggestion[] | SuggestionsUnavailable {
	try {
		return computeSuggestions(
			buildChangeset(repoDir, baseOid, headOid, options),
		);
	} catch (error) {
		return {
			unavailable:
				error instanceof DiffUnreadable
					? error.message
					: "the diff could not be parsed",
		};
	}
}
