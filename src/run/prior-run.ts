import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { commitResolves, isOid } from "./commits.js";
import {
	COMPLETE_MARKER,
	EXECUTION_FILE,
	PANEL_FILE,
	PLAN_FILE,
	readSignedRecord,
} from "./record.js";
import { planMac } from "./record-key.js";
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
	/** The owner's MAC of the record's `plan.json`, checked on load. */
	planMac: string;
	/** The exact signed bytes of the record's `findings.json`. */
	findingsText: string;
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
	assertRealRecordFolders(repoDir);
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
/**
 * Refuses a `.review-panel` or `runs` folder that is a symlink (or not a
 * folder), the rule `reserve` applies when it creates them: a linked folder
 * would let another repository's records, signed with the same owner key,
 * pass as this repository's. Only those two are checked with `lstat`, not
 * their ancestors. A missing folder is left to the "not found" refusal.
 */
function assertRealRecordFolders(repoDir: string): void {
	for (const dir of [
		path.join(repoDir, ".review-panel"),
		path.join(repoDir, ".review-panel", "runs"),
	]) {
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(dir);
		} catch {
			return;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`Verify refused: ${dir} is a symlink; run records must stay inside the repository`,
			);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Verify refused: ${dir} is not a directory`);
		}
	}
}

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
	// The key is per owner, not per repository: a record signed in another
	// repository must name commits this one holds.
	for (const oid of [meta.baseOid, meta.headOid]) {
		if (!isOid(oid) || !commitResolves(repoDir, oid)) {
			throw new Error(
				`Verify refused: prior run "${runId}" names commit ${isOid(oid) ? oid : "(not a commit id)"}, which is not a commit in this repository; run a new review here`,
			);
		}
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
		planMac: planMac(recordKey, runId, signed.get(PLAN_FILE) as string),
		findingsText: signed.get("findings.json") as string,
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
