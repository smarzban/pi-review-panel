import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import {
	COMPLETE_MARKER,
	EXECUTION_FILE,
	PANEL_FILE,
	readSignedRecord,
} from "./record.js";
import type { StampedFinding } from "./types.js";

export type PriorRunMeta = {
	runId: string;
	baseRef: string;
	baseOid: string;
	headOid: string;
};

export type PriorRun = {
	runId: string;
	recordPath: string;
	meta: PriorRunMeta;
	findings: StampedFinding[];
	/** The exact signed bytes of the record's `panel.json`. */
	panelText: string;
	/** The exact signed bytes of the record's `execution.json`. */
	executionText: string;
};

/** What to do about a record verify or comment will not take as the owner's. */
export const NEW_REVIEW_FIX =
	"run a new review; records written before signing, or by anyone without this owner's record key, cannot be used";

function isRealDirectory(target: string): boolean {
	try {
		return lstatSync(target).isDirectory();
	} catch {
		return false;
	}
}

function isRealFile(target: string): boolean {
	try {
		return lstatSync(target).isFile();
	} catch {
		return false;
	}
}

export function assertSafeRunId(runId: string): string {
	if (runId.trim() === "" || runId.includes("/") || runId.includes("\\")) {
		throw new Error("priorRunId must be a run directory name, not a path");
	}
	if (runId === "." || runId === ".." || runId.includes("..")) {
		throw new Error("priorRunId must be a run directory name, not a path");
	}
	return runId;
}

/**
 * Accept the run directory name or an absolute path to that run (or a file
 * inside it). Paths are confined to `<repo>/.review-panel/runs/<runId>`.
 */
export function resolvePriorRunId(repoDir: string, priorRunId: string): string {
	const trimmed = priorRunId.trim();
	if (!trimmed.includes("/") && !trimmed.includes("\\")) {
		return assertSafeRunId(trimmed);
	}
	if (!path.isAbsolute(trimmed)) {
		throw new Error(
			"priorRunId must be a run directory name or an absolute record path",
		);
	}
	let realRepo: string;
	let candidate: string;
	try {
		realRepo = realpathSync(repoDir);
		candidate = realpathSync(trimmed);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Verify refused: prior run path cannot be resolved: ${cause}`,
		);
	}
	if (isRealFile(candidate)) {
		candidate = path.dirname(candidate);
	}
	let expectedRoot: string;
	try {
		expectedRoot = realpathSync(path.join(realRepo, ".review-panel", "runs"));
	} catch {
		throw new Error(
			"Verify refused: priorRunId path must be a run directory under this repository's .review-panel/runs",
		);
	}
	if (path.dirname(candidate) !== expectedRoot) {
		throw new Error(
			"Verify refused: priorRunId path must be a run directory under this repository's .review-panel/runs",
		);
	}
	return assertSafeRunId(path.basename(candidate));
}

/**
 * Loads a complete review record as the owner's own. The record lives in the
 * reviewed repository, so it is taken only when it carries this owner's
 * signature (see `readSignedRecord`): `plan.json` with a valid `plan.mac`,
 * and `record.mac` over the plan, panel, meta, findings and execution bytes,
 * bound to this run id. Everything returned is parsed from those signed
 * bytes. Anything else is refused with the fix: run a new review.
 */
export function loadPriorRun(
	repoDir: string,
	priorRunId: string,
	recordKey: Buffer,
): PriorRun {
	const runId = resolvePriorRunId(repoDir, priorRunId);
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	if (!isRealDirectory(recordPath)) {
		throw new Error(`Verify refused: prior run "${runId}" was not found`);
	}
	if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
		throw new Error(`Verify refused: prior run "${runId}" is not complete`);
	}
	let signed: ReadonlyMap<string, string>;
	try {
		signed = readSignedRecord(
			recordPath,
			"review",
			recordKey,
			`prior run "${runId}"`,
			NEW_REVIEW_FIX,
		);
	} catch (error) {
		throw new Error(
			`Verify refused: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const meta = parseSigned(signed, "meta.json", runId) as PriorRunMeta;
	if (
		meta === null ||
		typeof meta !== "object" ||
		meta.runId !== runId ||
		typeof meta.baseOid !== "string" ||
		typeof meta.headOid !== "string"
	) {
		throw new Error(
			`Verify refused: prior run "${runId}" meta.json is invalid`,
		);
	}
	const findings = parseSigned(signed, "findings.json", runId);
	if (!Array.isArray(findings)) {
		throw new Error(
			`Verify refused: prior run "${runId}" findings.json is invalid`,
		);
	}
	return {
		runId,
		recordPath,
		meta,
		findings: findings as StampedFinding[],
		panelText: signed.get(PANEL_FILE) as string,
		executionText: signed.get(EXECUTION_FILE) as string,
	};
}

function parseSigned(
	signed: ReadonlyMap<string, string>,
	name: string,
	runId: string,
): unknown {
	try {
		return JSON.parse(signed.get(name) as string);
	} catch {
		throw new Error(`Verify refused: prior run "${runId}" ${name} is invalid`);
	}
}

export function selectKeptFindings(
	findings: StampedFinding[],
	keptFindingIds: readonly string[],
): StampedFinding[] {
	const byId = new Map(findings.map((row) => [row.id, row]));
	const seen = new Set<string>();
	const kept: StampedFinding[] = [];
	for (const id of keptFindingIds) {
		if (seen.has(id)) {
			throw new Error(`Verify refused: duplicate kept finding id "${id}"`);
		}
		seen.add(id);
		const row = byId.get(id);
		if (row === undefined) {
			throw new Error(
				`Verify refused: kept finding "${id}" is not in the prior run`,
			);
		}
		kept.push(row);
	}
	return kept;
}
