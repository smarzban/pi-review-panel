// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, readdirSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import { COMPLETE_MARKER } from "./record.js";

/**
 * Shared prior-record discovery: the durable run records a later review may
 * consume for persistence flagging. Completed runs carry the COMPLETE marker.
 *
 * Filesystem-honest by construction: only real completed directories are
 * discovered, and nothing here follows symlinks. lstat does not follow
 * links, so a symlinked entry, a symlinked completion marker, or a
 * symlinked `.review-panel`/runs ancestor fails the checks below and is
 * skipped: refuse-don't-adopt, fail closed. The reviewed repository is
 * semi-trusted and can pre-seed its record trees, so a planted link may
 * neither fake completion nor redirect consumption outside the real tree.
 * A missing tree stays ordinary no-prior-record behavior.
 */

/** One discovered prior record: its kind and its real directory path. */
export type PriorRecord = {
	kind: "run";
	path: string;
};

type RecencyEntry = PriorRecord & {
	/** Newest-first ordering key in epoch milliseconds. */
	recency: number;
	name: string;
};

/** Absent recency facts sort oldest; name order breaks ties below. */
const UNKNOWN_RECENCY = Number.NEGATIVE_INFINITY;

/**
 * Discovers prior completed run records under `<repoDir>/.review-panel/`,
 * newest-first. Recency is the timestamp encoded in the run id (fixed-width,
 * so id order is recency order). Ties break by name descending.
 */
export function discoverPriorRecords(repoDir: string): PriorRecord[] {
	const stateDir = path.join(repoDir, ".review-panel");
	if (!isRealDirectory(stateDir)) {
		return [];
	}

	const entries: RecencyEntry[] = [];

	const runsDir = path.join(stateDir, "runs");
	if (isRealDirectory(runsDir)) {
		for (const name of safeReaddir(runsDir)) {
			const recordPath = path.join(runsDir, name);
			if (!isRealDirectory(recordPath)) {
				continue;
			}
			if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
				continue;
			}
			entries.push({
				kind: "run",
				path: recordPath,
				name,
				recency: runIdRecency(name),
			});
		}
	}

	entries.sort(
		(a, b) =>
			b.recency - a.recency || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
	);
	return entries.map((entry) => ({ kind: entry.kind, path: entry.path }));
}

/** The fixed-width UTC timestamp prefix of a run id, as epoch milliseconds. */
function runIdRecency(name: string): number {
	// Shape produced by run reservation: YYYY-MM-DDTHH-MM-SS-mmmZ-...
	const prefix = name.slice(0, 24);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(prefix)) {
		return UNKNOWN_RECENCY;
	}
	const iso = `${prefix.slice(0, 13)}:${prefix.slice(14, 16)}:${prefix.slice(17, 19)}.${prefix.slice(20, 23)}Z`;
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? UNKNOWN_RECENCY : parsed;
}

function safeReaddir(dirPath: string): string[] {
	try {
		return readdirSync(dirPath);
	} catch {
		return [];
	}
}

/**
 * lstat never follows symlinks, so a link is NOT a real directory here: it
 * reports isSymbolicLink() and fails isDirectory(). Symlinked entries and
 * ancestors are therefore never discovered, fail closed.
 */
function isRealDirectory(candidatePath: string): boolean {
	try {
		return lstatSync(candidatePath).isDirectory();
	} catch {
		return false;
	}
}

/** Like {@link isRealDirectory}, for regular files: a link is not a file. */
function isRealFile(candidatePath: string): boolean {
	try {
		return lstatSync(candidatePath).isFile();
	} catch {
		return false;
	}
}
