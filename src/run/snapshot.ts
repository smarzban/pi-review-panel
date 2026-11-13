import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	type Stats,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isProcessAlive } from "./liveness.js";

/** Release outcome: a cleanup failure is returned as data, never thrown. */
export type SnapshotReleaseOutcome = { ok: boolean; error?: string };

/** A pinned snapshot worktree and the release that tears it down. */
export type PinnedSnapshot = {
	worktreePath: string;
	release: () => SnapshotReleaseOutcome;
};

const SNAPSHOT_PREFIX = "review-panel-snapshot-";
const OWNER_FILE = "owner.json";

/**
 * Fixed operational bound for a snapshot with no trusted owner file (one made
 * before owner files existed). It is removed only once it is older than this,
 * since nothing can tell whether its run is still alive.
 */
export const OWNERLESS_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Who made a snapshot: the process and the repository's common git dir. */
type SnapshotOwner = { pid: number; repo: string };

/**
 * Each snapshot lives in a private holder folder that `mkdtemp` makes in the
 * temp folder (mode 0700, so no other user can put anything in it). The
 * holder keeps the owner file and the worktree, so the owner file is never
 * inside the worktree seats read.
 */
export function snapshotOwnerPath(worktreePath: string): string {
	return path.join(path.dirname(worktreePath), OWNER_FILE);
}

/** What a sweep removed and what it left because a live run may own it. */
export type SnapshotSweep = { removed: string[]; kept: string[] };

/**
 * Pins a frozen commit into a throwaway detached worktree so a run reviews
 * one snapshot. Uncommitted working-tree changes and later commits in the
 * host repo are invisible inside the snapshot (AC-1). `commit` defaults to
 * HEAD; callers that must freeze the start-of-run tip should resolve the OID
 * before any other side effect and pass it here. Throws on creation failure
 * so the run aborts before any seat spawns.
 */
export function pinSnapshot(
	repoDir: string,
	commit: string = "HEAD",
): PinnedSnapshot {
	try {
		sweepStaleSnapshots(repoDir);
	} catch {
		// A sweep is housekeeping; it never stops a run.
	}
	// Everything the owner file needs is known before the holder exists.
	const owner: SnapshotOwner = {
		pid: process.pid,
		repo: commonGitDir(repoDir),
	};
	const holder = mkdtempSync(path.join(tmpdir(), SNAPSHOT_PREFIX));
	const worktreePath = path.join(holder, path.basename(holder));

	try {
		// The owner is on disk before the worktree is registered, so a sweep
		// never sees a registered snapshot of this version without an owner.
		writeOwnerFile(snapshotOwnerPath(worktreePath), owner);
		git(repoDir, ["worktree", "add", "--detach", worktreePath, commit]);
	} catch (error) {
		rmSync(holder, { recursive: true, force: true });
		throw error;
	}

	return {
		worktreePath,
		release: () => releaseSnapshot(repoDir, worktreePath),
	};
}

/**
 * Creates the owner file exclusively (never over anything already there, and
 * never through a symlink), readable only by this user.
 */
function writeOwnerFile(ownerPath: string, owner: SnapshotOwner): void {
	let fd: number;
	try {
		fd = openSync(
			ownerPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (error) {
		throw new Error(
			`snapshot owner file ${ownerPath} could not be created: ${failureMessage(error)}`,
		);
	}
	try {
		writeSync(fd, `${JSON.stringify(owner)}\n`);
	} finally {
		closeSync(fd);
	}
}

/**
 * Removes the snapshot through git so no worktree registration survives the
 * run (AC-18). A plain remove refuses an unclean worktree, so a failed first
 * attempt retries with --force (git-worktree(1): "Unclean worktrees ... can
 * be removed with --force"). Never throws: a cleanup failure is returned as
 * data so it cannot mask the run's outcome (AC-19).
 */
function releaseSnapshot(
	repoDir: string,
	worktreePath: string,
): SnapshotReleaseOutcome {
	const holder = path.dirname(worktreePath);
	try {
		git(repoDir, ["worktree", "remove", worktreePath]);
		rmSync(holder, { recursive: true, force: true });
		return { ok: true };
	} catch {
		// Fall through to the forced removal.
	}

	try {
		git(repoDir, ["worktree", "remove", "--force", worktreePath]);
		rmSync(holder, { recursive: true, force: true });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: failureMessage(error) };
	}
}

/**
 * Removes snapshots of this repository that no live run uses: those whose
 * owner process has exited, and those with no trusted owner that are older
 * than {@link OWNERLESS_SNAPSHOT_MAX_AGE_MS}. The temp folder may be shared
 * with other users (`/tmp`), so nothing found there is taken on trust:
 *
 * - Only a folder this user owns is touched, found by `lstat` (a symlink is
 *   never followed), and only directly inside the temp folder.
 * - An owner file is trusted only inside a holder this user owns that no one
 *   else can write, and only as a regular file this user owns with one link.
 * - A folder with no trusted owner is removed only when it is registered as a
 *   worktree of this repository and is past the age bound.
 *
 * A snapshot owned by a live process, or by another repository, is never
 * touched, and nothing else in the repository's worktree list is (no
 * repo-wide `git worktree prune`).
 */
export function sweepStaleSnapshots(
	repoDir: string,
	options: { now?: () => number } = {},
): SnapshotSweep {
	const now = options.now ?? Date.now;
	const repo = commonGitDir(repoDir);
	const root = tmpdir();
	const realRoot = realpathSync(root);
	const registered = registeredSnapshots(repoDir, realRoot);
	const names = new Set(registered.keys());
	for (const entry of safeReaddir(realRoot)) {
		// Only folders are judged below. A `<name>.owner.json` file beside one
		// is skipped like any other file: it is not this version's, and anyone
		// can create one in a shared temp folder.
		if (entry.startsWith(SNAPSHOT_PREFIX)) {
			names.add(entry);
		}
	}

	const removed: string[] = [];
	const kept: string[] = [];
	for (const name of [...names].sort()) {
		const folder = path.join(realRoot, name);
		const shown = path.join(root, name);
		const folderStats = safeLstat(folder);
		if (folderStats !== undefined && !ownedDirectory(folderStats)) {
			// A symlink, a file, or another user's folder: not ours to judge.
			continue;
		}
		const listed = registered.get(name);
		const owner =
			folderStats !== undefined && isHolder(folder, folderStats, listed)
				? readOwner(path.join(folder, OWNER_FILE))
				: undefined;
		let stale: boolean;
		if (owner !== undefined) {
			if (owner.repo !== repo) {
				continue;
			}
			stale = !isProcessAlive(owner.pid);
		} else if (listed !== undefined) {
			const modified = safeLstat(listed.path)?.mtimeMs;
			stale =
				modified === undefined ||
				now() - modified > OWNERLESS_SNAPSHOT_MAX_AGE_MS;
		} else {
			// Not ours to judge: no trusted owner and not registered here.
			continue;
		}
		if (!stale) {
			kept.push(listed?.shown ?? shown);
			continue;
		}
		if (listed !== undefined) {
			dropWorktree(repoDir, repo, listed.path);
		}
		const current = safeLstat(folder);
		if (current !== undefined && ownedDirectory(current)) {
			rmSync(folder, { recursive: true, force: true });
		}
		removed.push(listed?.shown ?? shown);
	}
	// No `git worktree prune`: it would also drop the registration of any
	// unrelated worktree whose folder is away at this moment. Each snapshot is
	// removed above by its own exact path only.
	return { removed, kept };
}

/**
 * Removes one registered snapshot worktree. When its folder is there (a real
 * folder this user owns), through `git worktree remove --force`. When it is
 * gone, git is not handed the path at all (something else could be put
 * there); its registration is dropped from this repository's own worktree
 * list instead, the way `git worktree prune` drops one entry.
 */
function dropWorktree(
	repoDir: string,
	commonDir: string,
	listed: string,
): void {
	const stats = safeLstat(listed);
	if (stats !== undefined) {
		if (!ownedDirectory(stats)) {
			return;
		}
		try {
			git(repoDir, ["worktree", "remove", "--force", listed]);
		} catch {
			// Best effort; the next sweep tries again.
		}
		return;
	}
	const admin = path.join(commonDir, "worktrees");
	for (const id of safeReaddir(admin)) {
		const entry = path.join(admin, id);
		let gitdir: string;
		try {
			gitdir = readFileSync(path.join(entry, "gitdir"), "utf8").trim();
		} catch {
			continue;
		}
		if (
			gitdir === path.join(listed, ".git") &&
			safeLstat(path.join(entry, "locked")) === undefined
		) {
			rmSync(entry, { recursive: true, force: true });
		}
	}
}

/** A registered snapshot worktree: its path as git lists it, and as shown. */
type ListedSnapshot = { path: string; shown: string };

/**
 * Snapshot worktrees registered in this repository, by the name of their
 * folder directly in the temp folder: the holder for this version's
 * snapshots, the worktree itself for older ones.
 */
function registeredSnapshots(
	repoDir: string,
	realRoot: string,
): Map<string, ListedSnapshot> {
	const names = new Map<string, ListedSnapshot>();
	const listing = git(repoDir, ["worktree", "list", "--porcelain"]);
	const root = tmpdir();
	for (const line of listing.split("\n")) {
		if (!line.startsWith("worktree ")) {
			continue;
		}
		const listed = line.slice("worktree ".length);
		const name = path.basename(listed);
		if (!name.startsWith(SNAPSHOT_PREFIX)) {
			continue;
		}
		const parent = path.dirname(listed);
		if (realDirname(listed) === realRoot) {
			names.set(name, { path: listed, shown: path.join(root, name) });
		} else if (
			path.basename(parent) === name &&
			realDirname(parent) === realRoot
		) {
			names.set(name, { path: listed, shown: path.join(root, name, name) });
		}
	}
	return names;
}

function realDirname(target: string): string {
	const parent = path.dirname(target);
	try {
		return realpathSync(parent);
	} catch {
		return parent;
	}
}

/**
 * A holder this version made: no other user can write it, and it is not a
 * worktree itself. An older snapshot's folder is the checked-out tree, whose
 * `owner.json` (if the reviewed repository tracks one) says nothing about
 * who made the snapshot.
 */
function isHolder(
	folder: string,
	stats: Stats,
	listed: ListedSnapshot | undefined,
): boolean {
	if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
		return false;
	}
	if (
		listed !== undefined &&
		path.basename(path.dirname(listed.path)) !== path.basename(folder)
	) {
		return false;
	}
	return safeLstat(path.join(folder, ".git")) === undefined;
}

/** This user's id, or undefined where there is none (Windows). */
function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** A real folder (not a symlink) that this user owns. */
function ownedDirectory(stats: {
	isDirectory(): boolean;
	uid: number;
}): boolean {
	const uid = currentUid();
	return stats.isDirectory() && (uid === undefined || stats.uid === uid);
}

/**
 * The owner file, only when it is a regular file this user owns with one
 * link, opened without following a symlink and without blocking on a FIFO.
 */
function readOwner(ownerPath: string): SnapshotOwner | undefined {
	let fd: number;
	try {
		fd = openSync(
			ownerPath,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
	} catch {
		return undefined;
	}
	try {
		const stats = fstatSync(fd);
		const uid = currentUid();
		if (
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(uid !== undefined && stats.uid !== uid)
		) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"pid" in parsed &&
			"repo" in parsed &&
			typeof parsed.pid === "number" &&
			typeof parsed.repo === "string"
		) {
			return { pid: parsed.pid, repo: parsed.repo };
		}
	} catch {
		// Unreadable: treated as owner-less.
	} finally {
		closeSync(fd);
	}
	return undefined;
}

function safeLstat(target: string): Stats | undefined {
	try {
		return lstatSync(target);
	} catch {
		return undefined;
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** The repository identity shared by all of its worktrees. */
function commonGitDir(repoDir: string): string {
	const common = git(repoDir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).trim();
	try {
		return realpathSync(common);
	} catch {
		return common;
	}
}

function failureMessage(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"stderr" in error &&
		typeof error.stderr === "string" &&
		error.stderr.trim() !== ""
	) {
		return error.stderr.trim();
	}
	return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
