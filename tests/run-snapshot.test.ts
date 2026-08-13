// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pinSnapshot } from "../src/run/snapshot.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A self-contained host repo with one commit; never touches the real repo. */
function createHostRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "run-snapshot-host-"));
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "run@example.test"]);
	git(repo, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(repo, "committed.txt"), "committed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base"]);
	return repo;
}

function worktreeCount(repo: string): number {
	return git(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
}

function removeFixture(...paths: string[]): void {
	for (const fixture of paths) {
		if (fixture !== "") {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
}

describe("pinSnapshot", () => {
	it("pins an explicit commit oid even when HEAD has moved on", () => {
		const repo = createHostRepo();
		const frozen = git(repo, ["rev-parse", "HEAD"]).trim();
		let snapshot = "";
		try {
			writeFileSync(path.join(repo, "late.txt"), "late\n");
			git(repo, ["add", "."]);
			git(repo, ["commit", "-m", "after capture"]);
			const tip = git(repo, ["rev-parse", "HEAD"]).trim();
			expect(tip).not.toBe(frozen);

			const pin = pinSnapshot(repo, frozen);
			snapshot = pin.worktreePath;
			expect(git(snapshot, ["rev-parse", "HEAD"]).trim()).toBe(frozen);
			expect(existsSync(path.join(snapshot, "late.txt"))).toBe(false);
		} finally {
			removeFixture(repo, snapshot);
		}
	});

	it("freezes committed HEAD: working-tree changes and later commits stay out", () => {
		const repo = createHostRepo();
		const pinnedHead = git(repo, ["rev-parse", "HEAD"]).trim();
		let snapshot = "";

		try {
			writeFileSync(path.join(repo, "committed.txt"), "dirty\n");
			writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");

			const pin = pinSnapshot(repo);
			snapshot = pin.worktreePath;

			expect(readFileSync(path.join(snapshot, "committed.txt"), "utf8")).toBe(
				"committed\n",
			);
			expect(existsSync(path.join(snapshot, "untracked.txt"))).toBe(false);

			writeFileSync(path.join(repo, "committed.txt"), "after-pin\n");
			writeFileSync(path.join(repo, "late.txt"), "late\n");
			git(repo, ["add", "."]);
			git(repo, ["commit", "-m", "after pin"]);

			expect(readFileSync(path.join(snapshot, "committed.txt"), "utf8")).toBe(
				"committed\n",
			);
			expect(existsSync(path.join(snapshot, "late.txt"))).toBe(false);
			expect(git(snapshot, ["rev-parse", "HEAD"]).trim()).toBe(pinnedHead);
		} finally {
			removeFixture(repo, snapshot);
		}
	});

	it("release removes the snapshot through git and leaves the worktree list clean", () => {
		const repo = createHostRepo();
		let snapshot = "";

		try {
			const pin = pinSnapshot(repo);
			snapshot = pin.worktreePath;
			expect(worktreeCount(repo)).toBe(2);

			const outcome = pin.release();

			expect(outcome).toEqual({ ok: true });
			expect(existsSync(snapshot)).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, snapshot);
		}
	});

	it("release falls back to force when the snapshot holds untracked files", () => {
		const repo = createHostRepo();
		let snapshot = "";

		try {
			const pin = pinSnapshot(repo);
			snapshot = pin.worktreePath;
			writeFileSync(path.join(snapshot, "untracked.txt"), "dirt\n");

			const outcome = pin.release();

			expect(outcome).toEqual({ ok: true });
			expect(existsSync(snapshot)).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, snapshot);
		}
	});

	it("release reports failure as data when the host repo is already gone", () => {
		const repo = createHostRepo();
		let snapshot = "";

		try {
			const pin = pinSnapshot(repo);
			snapshot = pin.worktreePath;
			rmSync(repo, { recursive: true, force: true });

			const outcome = pin.release();

			expect(outcome.ok).toBe(false);
			expect(typeof outcome.error).toBe("string");
			expect(outcome.error).not.toBe("");
		} finally {
			removeFixture(repo, snapshot);
		}
	});
});
