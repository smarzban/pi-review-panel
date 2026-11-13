import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildChangeset, suggestLenses } from "../src/run/changeset.js";

/**
 * The suggest rules read `git diff` of a real commit range. These tests build
 * that range with `git hash-object` and `git update-index`, so file names a
 * filesystem might refuse or normalise (a tab, an accent) still reach git
 * exactly as written.
 */

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
	});
}

type Range = { repo: string; base: string; head: string };

function withRange(
	files: Record<string, string>,
	test: (range: Range) => void,
): void {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "changeset-")));
	try {
		git(root, ["init", "-b", "main", "--quiet"]);
		git(root, ["config", "user.email", "changeset@example.test"]);
		git(root, ["config", "user.name", "Changeset Test"]);
		git(root, ["commit", "--allow-empty", "-m", "base", "--quiet"]);
		const base = git(root, ["rev-parse", "HEAD"]).trim();
		for (const [name, content] of Object.entries(files)) {
			const oid = git(root, ["hash-object", "-w", "--stdin"], content).trim();
			git(root, [
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${oid},${name}`,
			]);
		}
		git(root, ["commit", "-m", "head", "--quiet"]);
		const head = git(root, ["rev-parse", "HEAD"]).trim();
		test({ repo: root, base, head });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function securityEvidence({ repo, base, head }: Range) {
	return suggestLenses(repo, base, head).find((row) => row.lens === "security")
		?.evidence;
}

describe("the diff parser reads only real file headers", () => {
	it("keeps an added line that looks like a file header in its own file", () => {
		withRange(
			{
				"src/a.ts": [
					"++ b/evil\u001b[31mRED\u001b[0m\r# Heading [x](http://e)",
					'require("child_process");',
					"",
				].join("\n"),
			},
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/a.ts", line: 2 },
				]);
				expect(
					buildChangeset(range.repo, range.base, range.head).addedLines,
				).toEqual([
					{
						file: "src/a.ts",
						line: 1,
						text: "++ b/evil\u001b[31mRED\u001b[0m\r# Heading [x](http://e)",
					},
					{ file: "src/a.ts", line: 2, text: 'require("child_process");' },
				]);
			},
		);
	});

	it("does not let an added `++ b//dev/null` line hide the lines after it", () => {
		withRange(
			{
				"src/a.ts": [
					"++ b//dev/null",
					'require("child_process");',
					'crypto.createHash("sha256");',
					"",
				].join("\n"),
			},
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/a.ts", line: 2 },
					{ file: "src/a.ts", line: 3 },
				]);
			},
		);
	});

	it("reads a non-ASCII file name as written, as the first file in the diff", () => {
		withRange({ "auth/lógin.ts": 'require("child_process");\n' }, (range) => {
			const changeset = buildChangeset(range.repo, range.base, range.head);
			expect(changeset.files).toEqual(["auth/lógin.ts"]);
			expect(securityEvidence(range)).toEqual([
				{ file: "auth/lógin.ts", line: 1 },
			]);
			expect(
				suggestLenses(range.repo, range.base, range.head).map(
					(row) => row.lens,
				),
			).toEqual(["security", "tests"]);
		});
	});

	it("unquotes a file name holding a tab, a quote or a backslash, and pins evidence to it", () => {
		withRange(
			{
				"db/[pwn].sql": "select 1;\n",
				"src/a\tb/x.ts": 'require("child_process");\n',
				'src/q"u\\ote.ts': 'crypto.createHash("sha256");\n',
			},
			(range) => {
				const changeset = buildChangeset(range.repo, range.base, range.head);
				expect(changeset.files).toEqual([
					"db/[pwn].sql",
					"src/a\tb/x.ts",
					'src/q"u\\ote.ts',
				]);
				expect(securityEvidence(range)).toEqual([
					{ file: "src/a\tb/x.ts", line: 1 },
					{ file: 'src/q"u\\ote.ts', line: 1 },
				]);
			},
		);
	});

	it("drops the tab git appends after a file name with a space", () => {
		withRange({ "src/sp ace.ts": 'require("child_process");\n' }, (range) => {
			expect(securityEvidence(range)).toEqual([
				{ file: "src/sp ace.ts", line: 1 },
			]);
		});
	});

	it("attributes no added line to a deleted file", () => {
		withRange({ "src/gone.ts": "old\n" }, (first) => {
			git(first.repo, ["rm", "--quiet", "--cached", "src/gone.ts"]);
			const oid = git(
				first.repo,
				["hash-object", "-w", "--stdin"],
				'require("child_process");\n',
			).trim();
			git(first.repo, [
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${oid},src/z.ts`,
			]);
			git(first.repo, ["commit", "-m", "swap", "--quiet"]);
			const head = git(first.repo, ["rev-parse", "HEAD"]).trim();
			const range = { repo: first.repo, base: first.head, head };
			expect(buildChangeset(range.repo, range.base, range.head)).toEqual({
				files: ["src/gone.ts", "src/z.ts"],
				addedLines: [
					{ file: "src/z.ts", line: 1, text: 'require("child_process");' },
				],
			});
		});
	});
});
