import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	buildChangeset,
	MAX_DIFF_BYTES,
	suggestLenses,
} from "../src/run/changeset.js";
import type { Suggestion } from "../src/run/suggest.js";

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
	setup: (repo: string) => void = () => {},
): void {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "changeset-")));
	try {
		git(root, ["init", "-b", "main", "--quiet"]);
		git(root, ["config", "user.email", "changeset@example.test"]);
		git(root, ["config", "user.name", "Changeset Test"]);
		setup(root);
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

function rows({ repo, base, head }: Range): Suggestion[] {
	const result = suggestLenses(repo, base, head);
	if (!Array.isArray(result)) {
		throw new Error(`suggestions unavailable: ${result.unavailable}`);
	}
	return result;
}

function securityEvidence(range: Range) {
	return rows(range).find((row) => row.lens === "security")?.evidence;
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
			expect(rows(range).map((row) => row.lens)).toEqual(["security", "tests"]);
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

describe("the diff parser cannot be steered by the user's git config or quoting", () => {
	it("decodes git's octal quoting of a file name holding ESC and pins evidence to it", () => {
		withRange(
			{ "src/esc\u001b[31m.ts": 'require("child_process");\n' },
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/esc\u001b[31m.ts", line: 1 },
				]);
			},
		);
	});

	it("keeps the a/ and b/ prefixes when the repository sets diff.noprefix", () => {
		withRange(
			{ "src/np.ts": 'require("child_process");\n' },
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/np.ts", line: 1 },
				]);
			},
			(repo) => git(repo, ["config", "diff.noprefix", "true"]),
		);
	});
});

describe("binary detection cannot hide added lines", () => {
	it("reads the added lines of a source file holding a NUL byte", () => {
		withRange(
			{ "src/nul.ts": '// \u0000\nrequire("child_process");\n' },
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/nul.ts", line: 2 },
				]);
			},
		);
	});

	it("reads the added lines of a file the change itself marks -diff, checked out at head", () => {
		withRange(
			{
				".gitattributes": "*.ts -diff\n",
				"src/hidden.ts": 'require("child_process");\n',
			},
			(range) => {
				writeFileSync(path.join(range.repo, ".gitattributes"), "*.ts -diff\n");
				expect(securityEvidence(range)).toEqual([
					{ file: "src/hidden.ts", line: 1 },
				]);
			},
		);
	});
});

describe("a diff the parser cannot read is reported, never read as no match", () => {
	it("reads a diff over 1 MiB", () => {
		withRange(
			{
				"fixtures/big.txt": `${"x".repeat(99)}\n`.repeat(12_000),
				"src/a.ts": 'require("child_process");\n',
			},
			(range) => {
				expect(securityEvidence(range)).toEqual([
					{ file: "src/a.ts", line: 1 },
				]);
			},
		);
	});

	it("reports a diff over the bound as unavailable, with the cause", () => {
		withRange({ "src/a.ts": 'require("child_process");\n' }, (range) => {
			expect(
				suggestLenses(range.repo, range.base, range.head, {
					maxDiffBytes: 16,
				}),
			).toEqual({ unavailable: "the diff is over 16 bytes" });
		});
	});

	it("reports a diff with too many added lines as unavailable, instead of holding them all", () => {
		withRange(
			{
				"fixtures/many.txt": "x\n".repeat(200_001),
				"src/a.ts": 'require("child_process");\n',
			},
			(range) => {
				expect(suggestLenses(range.repo, range.base, range.head)).toEqual({
					unavailable: "the diff adds over 200,000 lines",
				});
			},
		);
	});

	it("bounds the diff text it reads at 32 MiB", () => {
		expect(MAX_DIFF_BYTES).toBe(32 * 1024 * 1024);
	});

	it("reports a git failure as unavailable, with the cause", () => {
		withRange({ "src/a.ts": "x\n" }, (range) => {
			expect(suggestLenses(range.repo, "0".repeat(40), range.head)).toEqual({
				unavailable: "git diff exited with status 128",
			});
		});
	});
});
