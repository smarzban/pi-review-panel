import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `mkdtempSync` passes through, except that a test can act on the folder it
 * just made before `pinSnapshot` does anything else with it.
 */
const fsHook = vi.hoisted(() => ({
	afterMkdtemp: undefined as ((made: string) => void) | undefined,
	/** Folders (by name) whose `lstat` reports another user as the owner. */
	otherUserFolders: new Set<string>(),
	/** When set, every `fstat` reports this uid as the owner. */
	fstatUid: undefined as number | undefined,
}));

/** Every git command `snapshot.ts` runs, by its arguments. */
const gitLog = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		execFileSync: (...args: Parameters<typeof real.execFileSync>) => {
			if (args[0] === "git" && Array.isArray(args[1])) {
				gitLog.calls.push(args[1].map(String));
			}
			return real.execFileSync(...args);
		},
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		mkdtempSync: (...args: Parameters<typeof real.mkdtempSync>) => {
			const made = real.mkdtempSync(...args);
			const act = fsHook.afterMkdtemp;
			fsHook.afterMkdtemp = undefined;
			act?.(String(made));
			return made;
		},
		lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
			const stats = real.lstatSync(...args);
			if (
				stats !== undefined &&
				fsHook.otherUserFolders.has(path.basename(String(args[0])))
			) {
				stats.uid = Number(stats.uid) + 1;
			}
			return stats;
		},
		fstatSync: (...args: Parameters<typeof real.fstatSync>) => {
			const stats = real.fstatSync(...args);
			if (fsHook.fstatUid !== undefined) {
				stats.uid = fsHook.fstatUid;
			}
			return stats;
		},
	};
});

afterEach(() => {
	fsHook.afterMkdtemp = undefined;
	fsHook.otherUserFolders.clear();
	fsHook.fstatUid = undefined;
	gitLog.calls.length = 0;
	vi.restoreAllMocks();
});

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
			// A snapshot's private holder folder, when it has one.
			const holder = path.dirname(fixture);
			if (path.basename(holder).startsWith("review-panel-snapshot-")) {
				rmSync(holder, { recursive: true, force: true });
			}
		}
	}
}

/** The repository's common git dir, as the sweep names it. */
function commonGitDir(repo: string): string {
	return realpathSync(
		git(repo, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]).trim(),
	);
}

/**
 * A snapshot as 0.3.0 made it: a registered worktree folder straight in the
 * temp folder, with no owner file.
 */
function legacySnapshot(repo: string): string {
	const folder = mkdtempSync(path.join(tmpdir(), "review-panel-snapshot-"));
	rmSync(folder, { recursive: true });
	git(repo, ["worktree", "add", "--quiet", "--detach", folder]);
	return folder;
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

describe("the sweep trusts only what this user made", () => {
	it("ignores a sidecar planted beside a snapshot this user should keep", () => {
		const repo = createHostRepo();
		const folder = legacySnapshot(repo);
		const planted = `${folder}.owner.json`;
		try {
			// Another local user can create this file in a shared temp folder.
			writeFileSync(
				planted,
				`${JSON.stringify({ pid: 0, repo: commonGitDir(repo) })}\n`,
			);

			const swept = sweepStaleSnapshots(repo);

			expect(swept.removed).toEqual([]);
			expect(existsSync(path.join(folder, "committed.txt"))).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
		} finally {
			rmSync(planted, { force: true });
			removeFixture(repo, folder);
		}
	});

	it("never takes an owner.json the reviewed tree itself holds as the owner", () => {
		const repo = createHostRepo();
		// The reviewed repository tracks a root owner.json that names it.
		writeFileSync(
			path.join(repo, "owner.json"),
			`${JSON.stringify({ pid: deadPid(), repo: commonGitDir(repo) })}\n`,
		);
		git(repo, ["add", "owner.json"]);
		git(repo, ["commit", "-m", "owner.json"]);
		const folder = legacySnapshot(repo);
		try {
			expect(existsSync(path.join(folder, "owner.json"))).toBe(true);

			const swept = sweepStaleSnapshots(repo);

			expect(swept.removed).toEqual([]);
			expect(existsSync(path.join(folder, "committed.txt"))).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
		} finally {
			removeFixture(repo, folder);
		}
	});

	it("never reads an owner file through a symlink", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		const outside = mkdtempSync(path.join(tmpdir(), "run-snapshot-victim-"));
		try {
			const fake = path.join(outside, "owner.json");
			writeFileSync(
				fake,
				`${JSON.stringify({ pid: deadPid(), repo: commonGitDir(repo) })}\n`,
			);
			const ownerPath = snapshotOwnerPath(pin.worktreePath);
			rmSync(ownerPath);
			symlinkSync(fake, ownerPath);

			const swept = sweepStaleSnapshots(repo);

			expect(swept.removed).toEqual([]);
			expect(existsSync(pin.worktreePath)).toBe(true);
			expect(existsSync(fake)).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
		} finally {
			removeFixture(repo, pin.worktreePath, outside);
		}
	});

	it.skipIf(typeof process.getuid !== "function")(
		"never removes a snapshot owned by another user, even with a dead owner",
		() => {
			const repo = createHostRepo();
			const pin = pinSnapshot(repo);
			try {
				ownedBy(pin.worktreePath, deadPid());
				const me = (process.getuid as () => number)();
				// Seen as another user, this user's files are someone else's.
				vi.spyOn(process, "getuid").mockReturnValue(me + 1);

				const swept = sweepStaleSnapshots(repo);

				vi.restoreAllMocks();
				expect(swept.removed).toEqual([]);
				expect(existsSync(pin.worktreePath)).toBe(true);
				expect(worktreeCount(repo)).toBe(2);
			} finally {
				vi.restoreAllMocks();
				removeFixture(repo, pin.worktreePath);
			}
		},
	);

	it("never follows a snapshot-named symlink in the temp folder", () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-snapshot-victim-"));
		const link = path.join(
			tmpdir(),
			`review-panel-snapshot-link${process.pid}`,
		);
		try {
			writeFileSync(
				path.join(outside, "owner.json"),
				`${JSON.stringify({ pid: deadPid(), repo: commonGitDir(repo) })}\n`,
			);
			mkdirSync(path.join(outside, "keep"));
			symlinkSync(outside, link);

			sweepStaleSnapshots(repo);

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(existsSync(path.join(outside, "keep"))).toBe(true);
			expect(existsSync(path.join(outside, "owner.json"))).toBe(true);
		} finally {
			rmSync(link, { force: true });
			removeFixture(repo, outside);
		}
	});

	it("keeps a registered snapshot-named worktree that is not directly in the temp folder", () => {
		const repo = createHostRepo();
		const away = mkdtempSync(path.join(tmpdir(), "run-snapshot-away-"));
		const folder = path.join(away, "review-panel-snapshot-away");
		try {
			git(repo, ["worktree", "add", "--quiet", "--detach", folder]);
			const old = new Date(Date.now() - OWNERLESS_SNAPSHOT_MAX_AGE_MS - 60_000);
			utimesSync(folder, old, old);

			sweepStaleSnapshots(repo);

			expect(existsSync(path.join(folder, "committed.txt"))).toBe(true);
			expect(worktreeCount(repo)).toBe(2);
		} finally {
			removeFixture(repo, away);
		}
	});
});

describe("pinSnapshot writes its owner file safely", () => {
	it("refuses a symlink planted at the owner path and never follows it", () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-snapshot-victim-"));
		const victim = path.join(outside, "victim.txt");
		const planted: string[] = [];
		try {
			writeFileSync(victim, "keep me\n");
			// The moment the folder exists, plant a symlink at every place an
			// owner file could go: beside the folder and inside it.
			fsHook.afterMkdtemp = (made) => {
				for (const target of [
					`${made}.owner.json`,
					path.join(made, "owner.json"),
				]) {
					try {
						symlinkSync(victim, target);
						planted.push(target);
					} catch {
						// This user cannot plant there; neither can anyone else.
					}
				}
			};

			let pinned: string | undefined;
			let refusal: unknown;
			try {
				const pin = pinSnapshot(repo);
				pinned = pin.worktreePath;
				pin.release();
			} catch (error) {
				refusal = error;
			}

			expect(readFileSync(victim, "utf8")).toBe("keep me\n");
			expect(pinned).toBeUndefined();
			expect(String(refusal)).toMatch(/owner file/);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			for (const target of planted) {
				rmSync(target, { force: true });
			}
			removeFixture(repo, outside);
		}
	});

	it("puts the owner file and the worktree in a private folder only this user can enter", () => {
		const repo = createHostRepo();
		const pin = pinSnapshot(repo);
		try {
			const holder = path.dirname(pin.worktreePath);
			expect(path.basename(holder)).toMatch(/^review-panel-snapshot-/);
			expect(lstatSync(holder).mode & 0o777).toBe(0o700);
			const owner = lstatSync(snapshotOwnerPath(pin.worktreePath));
			expect(owner.isFile()).toBe(true);
			expect(owner.mode & 0o777).toBe(0o600);
			expect(path.dirname(snapshotOwnerPath(pin.worktreePath))).toBe(holder);
			expect(pin.release()).toEqual({ ok: true });
			expect(existsSync(holder)).toBe(false);
		} finally {
			removeFixture(repo, pin.worktreePath);
		}
	});
});

describe("each guard on what the sweep trusts holds on its own", () => {
	/** A snapshot this user made whose owner process has exited. */
	function deadSnapshot(repo: string): { worktree: string; holder: string } {
		const pin = pinSnapshot(repo);
		ownedBy(pin.worktreePath, deadPid());
		return {
			worktree: pin.worktreePath,
			holder: path.dirname(pin.worktreePath),
		};
	}

	function expectKept(repo: string, worktree: string, registered = true): void {
		const swept = sweepStaleSnapshots(repo);
		expect(swept.removed).toEqual([]);
		expect(existsSync(path.join(worktree, "committed.txt"))).toBe(true);
		expect(worktreeCount(repo)).toBe(registered ? 2 : 1);
	}

	it("never trusts the owner file of a folder that is itself a worktree", () => {
		const repo = createHostRepo();
		const { worktree, holder } = deadSnapshot(repo);
		try {
			// Unregistered, so only the `.git` check stops the owner file being read.
			rmSync(path.join(repo, ".git", "worktrees", path.basename(worktree)), {
				recursive: true,
				force: true,
			});
			writeFileSync(path.join(holder, ".git"), "gitdir: elsewhere\n");

			expectKept(repo, worktree, false);
		} finally {
			removeFixture(repo, worktree);
		}
	});

	it.skipIf(process.platform === "win32").each([0o720, 0o702])(
		"never trusts the owner file in a holder with mode %o that others can write",
		(mode) => {
			const repo = createHostRepo();
			const { worktree, holder } = deadSnapshot(repo);
			try {
				chmodSync(holder, mode);
				expectKept(repo, worktree);
			} finally {
				chmodSync(holder, 0o700);
				removeFixture(repo, worktree);
			}
		},
	);

	it("never trusts an owner file with a second hard link", () => {
		const repo = createHostRepo();
		const { worktree, holder } = deadSnapshot(repo);
		try {
			linkSync(snapshotOwnerPath(worktree), path.join(holder, "second-link"));
			expectKept(repo, worktree);
		} finally {
			removeFixture(repo, worktree);
		}
	});

	it.skipIf(typeof process.getuid !== "function")(
		"never trusts an owner file another user owns, in a holder this user owns",
		() => {
			const repo = createHostRepo();
			const { worktree } = deadSnapshot(repo);
			try {
				fsHook.fstatUid = (process.getuid as () => number)() + 1;
				expectKept(repo, worktree);
			} finally {
				fsHook.fstatUid = undefined;
				removeFixture(repo, worktree);
			}
		},
	);

	it.skipIf(typeof process.getuid !== "function")(
		"never touches a holder another user owns, even with this user's dead owner file",
		() => {
			const repo = createHostRepo();
			const { worktree, holder } = deadSnapshot(repo);
			try {
				fsHook.otherUserFolders.add(path.basename(holder));
				expectKept(repo, worktree);
			} finally {
				fsHook.otherUserFolders.clear();
				removeFixture(repo, worktree);
			}
		},
	);

	it("never hands git the path of a dead snapshot whose folder is gone", () => {
		const repo = createHostRepo();
		const { worktree } = deadSnapshot(repo);
		try {
			rmSync(worktree, { recursive: true, force: true });
			gitLog.calls.length = 0;

			sweepStaleSnapshots(repo);

			expect(worktreeCount(repo)).toBe(1);
			const named = gitLog.calls.filter((args) =>
				args.some((arg) => arg.includes(path.basename(worktree))),
			);
			expect(named).toEqual([]);
		} finally {
			removeFixture(repo, worktree);
		}
	});

	it("keeps the registration of a gone snapshot that is locked", () => {
		const repo = createHostRepo();
		const { worktree } = deadSnapshot(repo);
		try {
			rmSync(worktree, { recursive: true, force: true });
			writeFileSync(
				path.join(repo, ".git", "worktrees", path.basename(worktree), "locked"),
				"",
			);

			sweepStaleSnapshots(repo);

			expect(worktreeCount(repo)).toBe(2);
		} finally {
			removeFixture(repo, worktree);
		}
	});
});
