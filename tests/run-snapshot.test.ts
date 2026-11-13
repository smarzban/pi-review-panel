import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	OWNERLESS_SNAPSHOT_MAX_AGE_MS,
	pinSnapshot,
	snapshotOwnerPath,
	sweepStaleSnapshots,
} from "../src/run/snapshot.js";

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
			rmSync(snapshotOwnerPath(fixture), { force: true });
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

/** The pid of a process that has already exited. */
function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	if (pid === undefined) {
		throw new Error("could not spawn a short-lived child");
	}
	return pid;
}

function ownedBy(worktreePath: string, pid: number): void {
	const ownerPath = snapshotOwnerPath(worktreePath);
	const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
	writeFileSync(ownerPath, `${JSON.stringify({ ...owner, pid })}\n`);
}

describe("sweepStaleSnapshots", () => {
	it("pinSnapshot records its owner outside the worktree", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			const owner = JSON.parse(
				readFileSync(snapshotOwnerPath(pin.worktreePath), "utf8"),
			);
			expect(owner.pid).toBe(process.pid);
			expect(git(pin.worktreePath, ["status", "--porcelain"])).toBe("");
			pin.release();
			expect(existsSync(snapshotOwnerPath(pin.worktreePath))).toBe(false);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});

	it("removes a snapshot left by a dead run and its registration", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			ownedBy(pin.worktreePath, deadPid());
			expect(worktreeCount(repo)).toBe(2);

			const swept = sweepStaleSnapshots(repo);

			expect(swept.removed).toEqual([pin.worktreePath]);
			expect(existsSync(pin.worktreePath)).toBe(false);
			expect(existsSync(snapshotOwnerPath(pin.worktreePath))).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});

	it("never removes a snapshot whose owner is alive", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			const swept = sweepStaleSnapshots(repo);

			expect(swept.removed).toEqual([]);
			expect(existsSync(pin.worktreePath)).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
			expect(pin.release()).toEqual({ ok: true });
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});

	it("runs at the next pin: the dead leftover goes, the new snapshot stays", () => {
		const repo = createHostRepo();
		const leftover = pinSnapshot(repo);
		let next = "";
		try {
			ownedBy(leftover.worktreePath, deadPid());

			const pin = pinSnapshot(repo);
			next = pin.worktreePath;

			expect(existsSync(leftover.worktreePath)).toBe(false);
			expect(existsSync(next)).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
			expect(pin.release()).toEqual({ ok: true });
		} finally {
			removeFixture(repo, leftover.worktreePath, next);
		}
	});

	it("leaves another repository's dead snapshot alone", () => {
		const mine = createHostRepo();
		const theirs = createHostRepo();
		const pin = pinSnapshot(theirs);
		try {
			ownedBy(pin.worktreePath, deadPid());

			sweepStaleSnapshots(mine);

			expect(existsSync(pin.worktreePath)).toBe(true);
			expect(worktreeCount(theirs)).toBe(2);
		} finally {
			removeFixture(mine, theirs, pin.worktreePath);
			rmSync(snapshotOwnerPath(pin.worktreePath), { force: true });
		}
	});

	it("removes an unregistered snapshot folder whose owner is dead", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			ownedBy(pin.worktreePath, deadPid());
			rmSync(
				path.join(repo, ".git", "worktrees", path.basename(pin.worktreePath)),
				{ recursive: true, force: true },
			);
			expect(worktreeCount(repo)).toBe(1);

			sweepStaleSnapshots(repo);

			expect(existsSync(pin.worktreePath)).toBe(false);
			expect(existsSync(snapshotOwnerPath(pin.worktreePath))).toBe(false);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});

	it("keeps an ownerless snapshot until it is older than the fixed bound", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			// Snapshots made before owner files existed have none.
			rmSync(snapshotOwnerPath(pin.worktreePath));

			expect(sweepStaleSnapshots(repo).removed).toEqual([]);
			expect(existsSync(pin.worktreePath)).toBe(true);

			const old = new Date(Date.now() - OWNERLESS_SNAPSHOT_MAX_AGE_MS - 60_000);
			utimesSync(pin.worktreePath, old, old);

			expect(sweepStaleSnapshots(repo).removed).toEqual([pin.worktreePath]);
			expect(existsSync(pin.worktreePath)).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});

	it("leaves an unrelated worktree registered while its folder is away", () => {
		const repo = createHostRepo();
		const away = mkdtempSync(path.join(tmpdir(), "run-snapshot-away-"));
		const feature = path.join(away, "feature");
		const parked = path.join(away, "parked");
		try {
			git(repo, ["worktree", "add", "--quiet", "--detach", feature]);
			// The folder is briefly elsewhere: an unmounted disk, a move.
			renameSync(feature, parked);

			sweepStaleSnapshots(repo);

			renameSync(parked, feature);
			expect(worktreeCount(repo)).toBe(2);
			expect(git(feature, ["status", "--porcelain"])).toBe("");
		} finally {
			removeFixture(repo, away);
		}
	});

	it("drops a dead snapshot's registration by its own path when its folder is gone", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			ownedBy(pin.worktreePath, deadPid());
			rmSync(pin.worktreePath, { recursive: true, force: true });
			expect(worktreeCount(repo)).toBe(2);

			sweepStaleSnapshots(repo);

			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});
});
