import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
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
const OWNER_SUFFIX = ".owner.json";

/**
 * Fixed operational bound for a snapshot with no owner file (one made before
 * owner files existed). It is removed only once it is older than this, since
 * nothing can tell whether its run is still alive.
 */
export const OWNERLESS_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Who made a snapshot: the process and the repository's common git dir. */
type SnapshotOwner = { pid: number; repo: string };

/** The owner file sits beside the snapshot, never inside the worktree seats read. */
export function snapshotOwnerPath(worktreePath: string): string {
	return `${worktreePath}${OWNER_SUFFIX}`;
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
	const worktreePath = mkdtempSync(path.join(tmpdir(), SNAPSHOT_PREFIX));
	const ownerPath = snapshotOwnerPath(worktreePath);

	try {
		// The owner is on disk before the worktree is registered, so a sweep
		// never sees a registered snapshot of this version without an owner.
		const owner: SnapshotOwner = {
			pid: process.pid,
			repo: commonGitDir(repoDir),
		};
		writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
		git(repoDir, ["worktree", "add", "--detach", worktreePath, commit]);
	} catch (error) {
		rmSync(worktreePath, { recursive: true, force: true });
		rmSync(ownerPath, { force: true });
		throw error;
	}

	return {
		worktreePath,
		release: () => releaseSnapshot(repoDir, worktreePath),
	};
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
	try {
		git(repoDir, ["worktree", "remove", worktreePath]);
		rmSync(snapshotOwnerPath(worktreePath), { force: true });
		return { ok: true };
	} catch {
		// Fall through to the forced removal.
	}

	try {
		git(repoDir, ["worktree", "remove", "--force", worktreePath]);
		rmSync(snapshotOwnerPath(worktreePath), { force: true });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: failureMessage(error) };
	}
}

/**
 * Removes snapshots of this repository that no live run uses: those whose
 * owner process has exited, and owner-less ones older than
 * {@link OWNERLESS_SNAPSHOT_MAX_AGE_MS}. A snapshot owned by a live process,
 * or by another repository, is never touched, and nothing else in the
 * repository's worktree list is (no repo-wide `git worktree prune`).
 */
export function sweepStaleSnapshots(
	repoDir: string,
	options: { now?: () => number } = {},
): SnapshotSweep {
	const now = options.now ?? Date.now;
	const repo = commonGitDir(repoDir);
	const root = tmpdir();
	const realRoot = realpathSync(root);
	const registered = registeredSnapshotNames(repoDir, realRoot);
	const names = new Set(registered.keys());
	for (const entry of safeReaddir(realRoot)) {
		if (!entry.startsWith(SNAPSHOT_PREFIX)) {
			continue;
		}
		names.add(
			entry.endsWith(OWNER_SUFFIX)
				? entry.slice(0, -OWNER_SUFFIX.length)
				: entry,
		);
	}

	const removed: string[] = [];
	const kept: string[] = [];
	for (const name of [...names].sort()) {
		const worktreePath = path.join(root, name);
		const ownerPath = snapshotOwnerPath(path.join(realRoot, name));
		const owner = readOwner(ownerPath);
		const listedPath = registered.get(name);
		let stale: boolean;
		if (owner !== undefined) {
			if (owner.repo !== repo) {
				continue;
			}
			stale = !isProcessAlive(owner.pid);
		} else if (listedPath !== undefined) {
			const modified = modifiedAt(path.join(realRoot, name));
			stale =
				modified === undefined ||
				now() - modified > OWNERLESS_SNAPSHOT_MAX_AGE_MS;
		} else {
			// Not ours to judge: no owner and not registered in this repository.
			continue;
		}
		if (!stale) {
			kept.push(worktreePath);
			continue;
		}
		if (listedPath !== undefined) {
			try {
				// Also drops the registration when the folder is already gone.
				git(repoDir, ["worktree", "remove", "--force", listedPath]);
			} catch {
				// Best effort; the next sweep tries again.
			}
		}
		rmSync(path.join(realRoot, name), { recursive: true, force: true });
		rmSync(ownerPath, { force: true });
		removed.push(worktreePath);
	}
	// No `git worktree prune`: it would also drop the registration of any
	// unrelated worktree whose folder is away at this moment. Each snapshot is
	// removed above by its own exact path only.
	return { removed, kept };
}

/** Snapshot worktrees registered in this repository, by folder name. */
function registeredSnapshotNames(
	repoDir: string,
	realRoot: string,
): Map<string, string> {
	const names = new Map<string, string>();
	const listing = git(repoDir, ["worktree", "list", "--porcelain"]);
	for (const line of listing.split("\n")) {
		if (!line.startsWith("worktree ")) {
			continue;
		}
		const listed = line.slice("worktree ".length);
		const name = path.basename(listed);
		if (!name.startsWith(SNAPSHOT_PREFIX)) {
			continue;
		}
		if (realDirname(listed) === realRoot) {
			names.set(name, listed);
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

function readOwner(ownerPath: string): SnapshotOwner | undefined {
	try {
		if (!lstatSync(ownerPath).isFile()) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
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
		// Missing or unreadable: treated as owner-less.
	}
	return undefined;
}

function modifiedAt(target: string): number | undefined {
	try {
		return lstatSync(target).mtimeMs;
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
