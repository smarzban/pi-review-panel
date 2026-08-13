// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
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

/** Parse a unified diff into added-line records. */
export function parseAddedLines(diff: string): Changeset["addedLines"] {
	const added: Changeset["addedLines"] = [];
	let file = "";
	let newLine = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice("+++ b/".length);
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk !== null) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (file === "" || file === "/dev/null") {
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			added.push({ file, line: newLine, text: line.slice(1) });
			newLine += 1;
			continue;
		}
		if (line.startsWith(" ") || line.startsWith("-")) {
			if (!line.startsWith("-")) {
				newLine += 1;
			}
		}
	}
	return added;
}

export function buildChangeset(
	repoDir: string,
	baseOid: string,
	headOid: string,
): Changeset {
	const names = git(repoDir, [
		"diff",
		"--name-only",
		"--no-ext-diff",
		"--no-textconv",
		`${baseOid}...${headOid}`,
	]);
	const files = names
		.split("\n")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const diff = git(repoDir, [
		"diff",
		"-U0",
		"--no-ext-diff",
		"--no-textconv",
		`${baseOid}...${headOid}`,
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
