// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { env as processEnv } from "node:process";
import { describe, expect, it } from "vitest";

import { createGitDiffTool } from "../src/seat/seat-extension.js";

type GitDiffTool = ReturnType<typeof createGitDiffTool>;

function git(worktree: string, args: string[]): string {
	return execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
}

function resultText(
	result: Awaited<ReturnType<GitDiffTool["execute"]>>,
): string {
	return result.content[0].text;
}

function diff(
	tool: GitDiffTool,
	params: { base: string; path?: string; nameOnly?: boolean },
): ReturnType<GitDiffTool["execute"]> {
	return tool.execute("tool-call", params, undefined, undefined, {});
}

function withRecordingGit(
	test: (logPath: string, worktree: string) => Promise<void> | void,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "seat-diff-git-"));
	const binDirectory = path.join(root, "bin");
	const executable = path.join(binDirectory, "git");
	const logPath = path.join(root, "git-argv.jsonl");
	const originalPath = processEnv.PATH;

	mkdirSync(binDirectory);
	writeFileSync(
		executable,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "diff") process.stdout.write("fake diff\\n");
`,
		"utf8",
	);
	chmodSync(executable, 0o755);
	processEnv.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;

	return Promise.resolve(test(logPath, root)).finally(() => {
		if (originalPath === undefined) {
			delete processEnv.PATH;
		} else {
			processEnv.PATH = originalPath;
		}
		rmSync(root, { recursive: true, force: true });
	});
}

function withGitFixture(
	test: (fixture: { worktree: string; base: string }) => Promise<void> | void,
): Promise<void> {
	const worktree = mkdtempSync(path.join(tmpdir(), "seat-diff-"));

	git(worktree, ["init", "-b", "main"]);
	git(worktree, ["config", "user.email", "seat@example.test"]);
	git(worktree, ["config", "user.name", "Seat Test"]);
	writeFileSync(path.join(worktree, "changed.txt"), "before\n");
	writeFileSync(path.join(worktree, "unchanged.txt"), "unchanged\n");
	git(worktree, ["add", "."]);
	git(worktree, ["commit", "-m", "base"]);
	const base = git(worktree, ["rev-parse", "HEAD"]).trim();

	writeFileSync(path.join(worktree, "changed.txt"), "after\n");
	writeFileSync(path.join(worktree, "added.txt"), "added\n");
	git(worktree, ["add", "."]);
	git(worktree, ["commit", "-m", "feature"]);

	return Promise.resolve(test({ worktree, base })).finally(() => {
		rmSync(worktree, { recursive: true, force: true });
	});
}

describe("git_diff", () => {
	it("disables external diff helpers in the git argv", async () => {
		await withRecordingGit(async (logPath, worktree) => {
			const tool = createGitDiffTool({ worktree });

			await diff(tool, { base: "HEAD" });

			const invocations = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line: string) => JSON.parse(line) as string[]);
			expect(invocations).toContainEqual([
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"HEAD...HEAD",
				"--",
			]);
		});
	});

	it("ignores a textconv filter configured in the reviewed repo", async () => {
		const worktree = mkdtempSync(path.join(tmpdir(), "seat-diff-"));
		try {
			git(worktree, ["init", "-b", "main"]);
			git(worktree, ["config", "user.email", "seat@example.test"]);
			git(worktree, ["config", "user.name", "Seat Test"]);
			const textconv = path.join(worktree, "textconv.sh");
			writeFileSync(textconv, '#!/bin/sh\necho TEXTCONV_MARKER\ncat "$1"\n');
			chmodSync(textconv, 0o755);
			git(worktree, ["config", "diff.marker.textconv", textconv]);
			writeFileSync(
				path.join(worktree, ".gitattributes"),
				"secret.txt diff=marker\n",
			);
			writeFileSync(path.join(worktree, "secret.txt"), "before\n");
			git(worktree, ["add", "."]);
			git(worktree, ["commit", "-m", "base"]);
			const base = git(worktree, ["rev-parse", "HEAD"]).trim();
			writeFileSync(path.join(worktree, "secret.txt"), "after\n");
			git(worktree, ["add", "."]);
			git(worktree, ["commit", "-m", "feature"]);
			const tool = createGitDiffTool({ worktree });

			const output = resultText(await diff(tool, { base }));

			expect(output).not.toContain("TEXTCONV_MARKER");
			expect(output).toBe(
				git(worktree, ["diff", "--no-textconv", `${base}...HEAD`]),
			);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("returns the whole base...HEAD patch", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			const tool = createGitDiffTool({ worktree });
			const expected = git(worktree, ["diff", `${base}...HEAD`]);

			await expect(diff(tool, { base })).resolves.toMatchObject({
				content: [{ type: "text", text: expected }],
			});
		});
	});

	it("restricts a diff to one path", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			const tool = createGitDiffTool({ worktree });
			const output = resultText(
				await diff(tool, { base, path: "changed.txt" }),
			);

			expect(output).toBe(
				git(worktree, ["diff", `${base}...HEAD`, "--", "changed.txt"]),
			);
			expect(output).not.toContain("added.txt");
		});
	});

	it("lists exactly the changed file names in name-only mode", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			const tool = createGitDiffTool({ worktree });
			const output = resultText(await diff(tool, { base, nameOnly: true }));

			expect(output).toBe("added.txt\nchanged.txt\n");
		});
	});

	it("truncates output exceeding the 50 KB limit before the line limit", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			writeFileSync(
				path.join(worktree, "large.txt"),
				Array.from(
					{ length: 100 },
					(_, line) => `line-${line}: ${"x".repeat(600)}`,
				).join("\n"),
			);
			git(worktree, ["add", "large.txt"]);
			git(worktree, ["commit", "-m", "large feature"]);
			const tool = createGitDiffTool({ worktree });
			const completeDiff = git(worktree, ["diff", `${base}...HEAD`]);
			const output = resultText(await diff(tool, { base }));

			expect(new TextEncoder().encode(completeDiff).byteLength).toBeGreaterThan(
				50 * 1024,
			);
			expect(completeDiff.split("\n").length).toBeLessThan(2_000);
			expect(output).toContain("TRUNCATED: 50 KB limit reached");
			expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
				50 * 1024,
			);
		});
	});

	it("truncates at 2,000 lines before the byte limit", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			writeFileSync(
				path.join(worktree, "many-short-lines.txt"),
				Array.from({ length: 2_001 }, (_, line) => `line-${line}`).join("\n"),
			);
			git(worktree, ["add", "many-short-lines.txt"]);
			git(worktree, ["commit", "-m", "many short lines"]);
			const tool = createGitDiffTool({ worktree });
			const completeDiff = git(worktree, ["diff", `${base}...HEAD`]);
			const output = resultText(await diff(tool, { base }));

			expect(new TextEncoder().encode(completeDiff).byteLength).toBeLessThan(
				50 * 1024,
			);
			expect(output).toContain("TRUNCATED: 2,000 lines limit reached");
			expect(output).not.toContain("+line-2000");
		});
	});

	it("rejects an option-shaped base without writing an output file", async () => {
		await withGitFixture(async ({ worktree }) => {
			const outputPath = path.join(worktree, "must-not-exist.diff");
			const tool = createGitDiffTool({ worktree });

			await expect(
				diff(tool, { base: `--output=${outputPath}` }),
			).rejects.toThrow("git diff failed: invalid base ref");
			expect(existsSync(outputPath)).toBe(false);
		});
	});

	it("diffs a tracked option-shaped path after the separator", async () => {
		await withGitFixture(async ({ worktree, base }) => {
			writeFileSync(path.join(worktree, "-x"), "option-shaped filename\n");
			git(worktree, ["add", "."]);
			git(worktree, ["commit", "-m", "add option-shaped filename"]);
			const tool = createGitDiffTool({ worktree });
			const output = resultText(await diff(tool, { base, path: "-x" }));

			expect(output).toBe(
				git(worktree, ["diff", `${base}...HEAD`, "--", "-x"]),
			);
		});
	});

	it("throws a bounded class-only error for an unknown base ref", async () => {
		await withGitFixture(async ({ worktree }) => {
			const tool = createGitDiffTool({ worktree });
			const error = await diff(tool, { base: "not-a-real-ref" }).catch(
				(reason: unknown) => reason,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				"git diff failed: unknown base ref",
			);
			expect((error as Error).message).not.toContain(worktree);
		});
	});
});
