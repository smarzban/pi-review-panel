// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdtempSync, rmSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

/** Release outcome: a cleanup failure is returned as data, never thrown. */
export type SnapshotReleaseOutcome = { ok: boolean; error?: string };

/** A pinned snapshot worktree and the release that tears it down. */
export type PinnedSnapshot = {
	worktreePath: string;
	release: () => SnapshotReleaseOutcome;
};

const SNAPSHOT_PREFIX = "review-panel-snapshot-";

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
	const worktreePath = mkdtempSync(path.join(tmpdir(), SNAPSHOT_PREFIX));

	try {
		git(repoDir, ["worktree", "add", "--detach", worktreePath, commit]);
	} catch (error) {
		rmSync(worktreePath, { recursive: true, force: true });
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
		return { ok: true };
	} catch {
		// Fall through to the forced removal.
	}

	try {
		git(repoDir, ["worktree", "remove", "--force", worktreePath]);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: failureMessage(error) };
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
