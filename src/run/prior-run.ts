// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import { COMPLETE_MARKER } from "./record.js";
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
};

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

export function loadPriorRun(repoDir: string, priorRunId: string): PriorRun {
	const runId = resolvePriorRunId(repoDir, priorRunId);
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	if (!isRealDirectory(recordPath)) {
		throw new Error(`Verify refused: prior run "${runId}" was not found`);
	}
	if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
		throw new Error(`Verify refused: prior run "${runId}" is not complete`);
	}
	const metaPath = path.join(recordPath, "meta.json");
	if (!isRealFile(metaPath)) {
		throw new Error(`Verify refused: prior run "${runId}" has no meta.json`);
	}
	const findingsPath = path.join(recordPath, "findings.json");
	if (!isRealFile(findingsPath)) {
		throw new Error(
			`Verify refused: prior run "${runId}" has no findings.json`,
		);
	}
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PriorRunMeta;
	if (
		typeof meta.runId !== "string" ||
		typeof meta.baseOid !== "string" ||
		typeof meta.headOid !== "string"
	) {
		throw new Error(
			`Verify refused: prior run "${runId}" meta.json is invalid`,
		);
	}
	const findings = JSON.parse(
		readFileSync(findingsPath, "utf8"),
	) as StampedFinding[];
	if (!Array.isArray(findings)) {
		throw new Error(
			`Verify refused: prior run "${runId}" findings.json is invalid`,
		);
	}
	return { runId, recordPath, meta, findings };
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
