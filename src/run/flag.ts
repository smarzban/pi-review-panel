// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, readFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import type { Finding } from "../seat/schema.js";
import { COMPLETE_MARKER } from "./record.js";
import type { FindingFlag, LedgerNotice, RunAnnotations } from "./render.js";
import type { StampedFinding } from "./types.js";

/**
 * Co-location drift window in lines (ADR-0002): two findings co-locate iff
 * they name the same file path and their line numbers differ by at most
 * this much, INCLUSIVE. The bias is deliberate over-flagging: a false flag
 * costs a glance; a missed flag silently permits a re-discarded defect.
 */
export const CO_LOCATION_DRIFT_LINES = 20;

/**
 * The discard ledger's file name at the record root. The convention this
 * module defines now and feature 4 writes later: a JSON array of rows
 * `{ id, file, line, reason }`, where id is the discarded finding's
 * run-stamped id (required so feature 4's completeness gate can count
 * finding ids per the constitution).
 */
export const DISCARD_LEDGER_FILE = "discard-ledger.json";

/** One discard row as feature 4 will write it. */
export type DiscardLedgerRow = {
	id: string;
	file: string;
	line: number;
	reason: string;
};

type LedgerRead =
	| { ok: true; present: boolean; rows: DiscardLedgerRow[] }
	| { ok: false; reason: string };

/**
 * Flags current findings that co-locate with a prior discard, carrying the
 * prior reason forward verbatim (AC-16). Mechanical only, per the
 * constitution's "the tool never judges": co-location is arithmetic per
 * ADR-0002, with no similarity, ranking, or sameness inference.
 *
 * No filesystem discovery: `priorRecordPaths` arrive explicit from the
 * caller, newest-first by contract. Only records bearing a completion
 * marker are consumed (AC-32): the run COMPLETE marker. A missing ledger is a
 * non-event, the same as an empty `[]`: no discards recorded. A
 * present-but-unreadable ledger in a completed record becomes a notice,
 * never a silent skip (AC-33). No prior paths means no flags and no notices
 * (AC-17).
 *
 * Confinement: prior records live in the semi-trusted reviewed repo, so
 * consumption never follows leaf symlinks. A symlinked record path or
 * COMPLETE marker leaves the record unconsumed (treated as unmarked,
 * AC-32); a symlinked ledger is refused and surfaced as unreadable (AC-33).
 * Ancestor containment (a symlinked `.review-panel` or runs tree) is enforced by
 * discovery before any path reaches this module.
 */
export function flagPersistence(
	stamped: StampedFinding[],
	priorRecordPaths: string[],
): RunAnnotations {
	const flags: FindingFlag[] = [];
	const notices: LedgerNotice[] = [];
	const flagged = new Set<string>();

	// Newest-first input order: the first ledger that co-locates with a
	// finding is the newest matching discard, and its reason wins.
	for (const recordPath of priorRecordPaths) {
		if (!isRealDirectory(recordPath)) {
			continue;
		}
		const completedRun = isRealFile(path.join(recordPath, COMPLETE_MARKER));
		if (!completedRun) {
			continue;
		}

		const ledger = readDiscardLedger(recordPath, DISCARD_LEDGER_FILE);
		if (!ledger.ok) {
			notices.push({ recordPath, reason: ledger.reason });
			continue;
		}

		for (const entry of stamped) {
			if (flagged.has(entry.id)) {
				continue;
			}
			const match = ledger.rows.find((row) => coLocated(entry.finding, row));
			if (match !== undefined) {
				flags.push({ findingId: entry.id, reason: match.reason });
				flagged.add(entry.id);
			}
		}
	}

	return { flags, notices };
}

/** Co-location per ADR-0002: same file path, lines within the window. */
function coLocated(finding: Finding, row: DiscardLedgerRow): boolean {
	return (
		finding.file === row.file &&
		Math.abs(finding.line - row.line) <= CO_LOCATION_DRIFT_LINES
	);
}

/**
 * Reads and validates one record's discard ledger. A missing ledger is a
 * non-event, identical to an empty `[]`: this prior recorded no discards,
 * so the read succeeds with zero rows and surfaces no notice. AC-33's
 * conjunction (the ledger exists AND is unreadable) does not reach a file
 * that is not there. Every other failure mode — symlinked or non-regular
 * file, unreadable file, invalid JSON, wrong shape, malformed row — is
 * returned as a reason, never thrown and never silently skipped. One bad
 * row poisons the whole ledger; a partially consumed ledger would hide
 * discards.
 *
 * The ledger is stat'ed with lstat BEFORE any read: lstat does not follow
 * symlinks, so a planted link cannot redirect the read outside the record
 * tree. A symlinked ledger is refused and named; fail closed.
 */
function readDiscardLedger(
	recordPath: string,
	ledgerFile = DISCARD_LEDGER_FILE,
): LedgerRead {
	const ledgerPath = path.join(recordPath, ledgerFile);
	const stat = statLedger(ledgerPath);
	if (stat === "missing") {
		return { ok: true, present: false, rows: [] };
	}
	if (stat === "symlink") {
		return {
			ok: false,
			reason: `${ledgerFile} is a symlink and was not followed`,
		};
	}
	if (stat === "unreadable") {
		return { ok: false, reason: `${ledgerFile} could not be read` };
	}

	let raw: string;
	try {
		raw = readFileSync(ledgerPath, "utf8");
	} catch {
		return { ok: false, reason: `${ledgerFile} could not be read` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: `${ledgerFile} is not valid JSON` };
	}

	const rowLabel =
		ledgerFile === DISCARD_LEDGER_FILE
			? "discard row"
			: "effective dismissal row";
	if (!Array.isArray(parsed)) {
		return {
			ok: false,
			reason: `${ledgerFile} is not a JSON array of ${
				ledgerFile === DISCARD_LEDGER_FILE
					? "discard rows"
					: "effective dismissal rows"
			}`,
		};
	}

	for (const [index, row] of parsed.entries()) {
		if (!isDiscardRow(row)) {
			return {
				ok: false,
				reason: `${ledgerFile} row ${index} is not a valid ${rowLabel}: id, file, line, and reason are required`,
			};
		}
	}

	return { ok: true, present: true, rows: parsed };
}

function isDiscardRow(row: unknown): row is DiscardLedgerRow {
	if (typeof row !== "object" || row === null || Array.isArray(row)) {
		return false;
	}
	const candidate = row as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.file === "string" &&
		isPositiveInteger(candidate.line) &&
		typeof candidate.reason === "string"
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The ledger's stat classification: why it cannot simply be read. */
type LedgerStat = "missing" | "symlink" | "unreadable" | "regular";

/**
 * Stats the ledger with lstat, which does not follow symlinks: a planted
 * link is classified as "symlink" and never read, and a link target outside
 * the record tree is never reached. "missing" (ENOENT) stays a non-event;
 * every other stat failure is "unreadable". Fail closed.
 */
function statLedger(ledgerPath: string): LedgerStat {
	try {
		const stats = lstatSync(ledgerPath);
		if (stats.isSymbolicLink()) {
			return "symlink";
		}
		if (!stats.isFile()) {
			return "unreadable";
		}
		return "regular";
	} catch (error) {
		if (isMissingFile(error)) {
			return "missing";
		}
		return "unreadable";
	}
}

/**
 * lstat never follows symlinks, so a link is NOT a real directory here: it
 * reports isSymbolicLink() and fails isDirectory(). Symlinked record paths
 * are therefore left unconsumed, fail closed.
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

/** ENOENT marks a missing ledger, which is a non-event, not AC-33. */
function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
