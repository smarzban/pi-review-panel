// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { createHash } from "node:crypto";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import type {
	PanelRecord,
	PanelRecordInput,
	PlannedSeat,
	ReservedRecord,
	SeatOutcomeFacts,
} from "./types.js";

/** Filename of the durable planned-panel record at the record root (AC-25). */
export const PANEL_FILE = "panel.json";

/** Durable SDK lifecycle, replay, cancellation, and lost-coverage facts. */
export const EXECUTION_FILE = "execution.json";

/** The mechanical completeness marker at the record root (AC-31). */
export const COMPLETE_MARKER = "COMPLETE";

/** Injectable clock: tests pin the run-id timestamp without sleeping. */
export type ReserveOptions = {
	now?: () => Date;
	/** Coordinator role disambiguates same-timestamp concurrent role panels. */
	role?: string;
};

/** Max characters of the lossy readable ref part (truncated, not refused). */
const MAX_REF_PART_LENGTH = 40;

/**
 * Hex characters of the collision-resistant digest appended to the run-id.
 * 16 hex = 64 bits: birthday-bound at ~2^64, a collision is not a practical
 * concern for any realistic number of reviews. The residual case (two refs
 * that do collide at the same millisecond) is handled by reserve()'s
 * fail-closed path (AC-3), which refuses and touches nothing.
 */
const DIGEST_HEX_LENGTH = 16;

/**
 * Reserves this run's record directory fail-closed: a pre-existing run-id
 * directory is refused without touching anything inside it (AC-3). The id is
 * `<timestamp>-<readable ref>-<digest>` (and, for coordinator role panels,
 * a readable role plus digest suffix): a zero-padded UTC timestamp for recency
 * ordering, lossy human-readable parts, and short collision-resistant digests
 * of the original identities. Concurrent role panels therefore cannot adopt
 * one another's record directory.
 */
export function reserve(
	repoDir: string,
	baseRef: string,
	options?: ReserveOptions,
): ReservedRecord {
	const now = options?.now ?? wallClock;
	const role = options?.role;
	const roleSuffix =
		role === undefined
			? ""
			: `-${sanitizeBaseRef(role)}-${digestBaseRef(role)}`;
	const runId = `${formatRunTimestamp(now())}-${sanitizeBaseRef(baseRef)}-${digestBaseRef(baseRef)}${roleSuffix}`;
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);

	// Create .review-panel and runs only as real directories. A pre-seeded symlink
	// at either component would let mkdirSync({ recursive: true }) follow it
	// and redirect durable records off-repo.
	ensureRealDirectory(path.join(repoDir, ".review-panel"));
	ensureRealDirectory(path.join(repoDir, ".review-panel", "runs"));
	try {
		// Deliberately not recursive: an existing directory throws EEXIST.
		mkdirSync(recordPath);
	} catch (error) {
		if (isExistsError(error)) {
			throw new Error(
				`run record already exists, refusing to adopt it: ${recordPath}`,
			);
		}
		throw error;
	}

	return {
		runId,
		recordPath,
		reportPath: path.join(recordPath, "report.md"),
		findingsPath: path.join(recordPath, "findings.json"),
		panelPath: path.join(recordPath, PANEL_FILE),
		executionPath: path.join(recordPath, EXECUTION_FILE),
	};
}

/**
 * Persists the exact planned panel before any pinning or scheduling (AC-25):
 * the run's identity, its baseRef, the optional scoping note verbatim, and
 * each planned seat projected to exactly `rosterId`/`lens`/`provider`/`model`
 * in planned order. No prompt text, extension paths, credentials, or endpoints
 * are serialized (AC-26). The `scopingNote` key is omitted entirely when
 * absent (AC-23). Serializes with the record owner's pretty-printed idiom
 * (2-space indent, trailing newline), matching findings.json.
 */
export function writePanel(
	record: ReservedRecord,
	input: PanelRecordInput,
): void {
	const panelRecord: PanelRecord = {
		runId: input.runId,
		baseRef: input.baseRef,
		...(input.scopingNote === undefined
			? {}
			: { scopingNote: input.scopingNote }),
		seats: input.seats.map(projectSeat),
	};
	writeFileSync(record.panelPath, `${JSON.stringify(panelRecord, null, 2)}\n`);
}

/** Projects one planned seat to its durable 4-key panel row, byte-for-byte. */
function projectSeat(seat: PlannedSeat): PanelRecord["seats"][number] {
	return {
		rosterId: seat.rosterId,
		lens: seat.lens,
		provider: seat.provider,
		model: seat.model,
	};
}

/**
 * Persists the SDK execution facts independently from the presentation report.
 * Prompt and scoping bytes stay in this replay artifact, never report.md.
 */
export function writeExecution(
	record: ReservedRecord,
	input: { cancelled: boolean; outcomes: SeatOutcomeFacts[] },
): void {
	const lostCoverage = input.outcomes
		.filter((entry) => entry.outcome.kind === "failed")
		.map(
			(entry) =>
				`${entry.seat.provider}/${entry.seat.model}/${entry.seat.lens}`,
		)
		.sort();
	writeFileSync(
		record.executionPath,
		`${JSON.stringify(
			{ cancelled: input.cancelled, lostCoverage, outcomes: input.outcomes },
			null,
			2,
		)}\n`,
	);
}

/**
 * Writes the completeness marker, last and only on successful completion;
 * nothing else writes it, so an aborted run stays unmarked (AC-31).
 */
export function complete(record: ReservedRecord): void {
	writeFileSync(path.join(record.recordPath, COMPLETE_MARKER), "");
}

/**
 * Lossy, human-readable ref part of the run-id. Lowercase, characters outside
 * `[a-z0-9._-]` mapped to `-`, runs of `-` collapsed, truncated to
 * {@link MAX_REF_PART_LENGTH}. This part exists for humans; it does NOT carry
 * identity. The collision-resistant digest appended by {@link reserve} is what
 * makes distinct refs practically (not provably) yield distinct ids.
 */
export function sanitizeBaseRef(baseRef: string): string {
	const lowered = baseRef.toLowerCase();
	const mapped = lowered.replace(/[^a-z0-9._-]/g, "-");
	const collapsed = mapped.replace(/-{2,}/g, "-");
	return collapsed.slice(0, MAX_REF_PART_LENGTH);
}

/**
 * Collision-resistant hex digest of the original, untransformed ref string.
 * This is what makes distinct refs practically (not provably) yield distinct
 * run-ids even when their lossy readable parts collide (e.g. `Main` vs `main`,
 * `origin/main` vs `origin-main`). 16 hex characters (64 bits) make a collision
 * not a practical concern; the residual case is safe because reserve()'s
 * fail-closed path refuses and touches nothing (AC-3). Uses `node:crypto`
 * (a node builtin) so zero runtime dependencies still holds.
 */
export function digestBaseRef(baseRef: string): string {
	return createHash("sha256")
		.update(baseRef)
		.digest("hex")
		.slice(0, DIGEST_HEX_LENGTH);
}

/**
 * Zero-padded, most-significant-first UTC timestamp (ISO-8601-like shape,
 * dashes instead of colons so it is a safe directory name). Fixed-width,
 * ASCII digits only, no locale input, so byte-wise comparison of two ids
 * agrees with recency whenever their timestamps differ.
 *
 * Supported year range: 0000-9999. Years outside this range throw rather
 * than producing a variable-width field that would break lexicographic
 * ordering (e.g. year 10000 as "10000" sorts before "9999").
 */
function formatRunTimestamp(date: Date): string {
	const year = date.getUTCFullYear();
	if (year < 0 || year > 9999) {
		throw new Error(
			`year ${year} is outside the supported range 0-9999; run-ids use a fixed 4-digit year`,
		);
	}
	const yearStr = String(year).padStart(4, "0");
	const month = pad2(date.getUTCMonth() + 1);
	const day = pad2(date.getUTCDate());
	const hours = pad2(date.getUTCHours());
	const minutes = pad2(date.getUTCMinutes());
	const seconds = pad2(date.getUTCSeconds());
	const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
	return `${yearStr}-${month}-${day}T${hours}-${minutes}-${seconds}-${millis}Z`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function wallClock(): Date {
	return new Date();
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

/**
 * Ensures `dirPath` exists as a real directory: creates it when absent,
 * refuses when it is a symlink or a non-directory. Not recursive — the
 * parent must already exist (repoDir for `.review-panel`, `.review-panel` for `runs`).
 */
function ensureRealDirectory(dirPath: string): void {
	try {
		const stats = lstatSync(dirPath);
		if (stats.isSymbolicLink()) {
			throw new Error(
				`run refused: ${dirPath} is a symlink; run records must stay inside the repository`,
			);
		}
		if (stats.isDirectory() === false) {
			throw new Error(`run refused: ${dirPath} exists and is not a directory`);
		}
		return;
	} catch (error) {
		if (isNotFoundError(error)) {
			mkdirSync(dirPath);
			return;
		}
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
