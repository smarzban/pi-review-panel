// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, readFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import {
	loadPriorRun,
	type PriorRun,
	resolvePriorRunId,
} from "../run/prior-run.js";
import { COMPLETE_MARKER, EXECUTION_FILE, PANEL_FILE } from "../run/record.js";
import type { PanelRecord } from "../run/types.js";

export type CloseoutRunFacts = {
	run: PriorRun;
	panel: PanelRecord;
	lost: string[];
};

function isRealFile(target: string): boolean {
	try {
		return lstatSync(target).isFile();
	} catch {
		return false;
	}
}

function asCommentError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace(/^Verify refused:/, "comment refused:"));
}

function readJson(filePath: string, label: string): unknown {
	if (!isRealFile(filePath)) {
		throw new Error(`comment refused: ${label} is missing`);
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`comment refused: ${label} is invalid: ${cause}`);
	}
}

export function lostFromExecution(raw: unknown): string[] {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return [];
	}
	const outcomes = (raw as { outcomes?: unknown }).outcomes;
	if (!Array.isArray(outcomes)) {
		return [];
	}
	const lost: string[] = [];
	for (const row of outcomes) {
		if (row === null || typeof row !== "object") {
			continue;
		}
		const record = row as {
			seat?: { rosterId?: unknown; lens?: unknown };
			outcome?: { kind?: unknown };
		};
		if (record.outcome?.kind !== "failed") {
			continue;
		}
		if (
			typeof record.seat?.rosterId !== "string" ||
			typeof record.seat.lens !== "string"
		) {
			continue;
		}
		lost.push(`${record.seat.rosterId}/${record.seat.lens}`);
	}
	return lost;
}

export function loadCloseoutRun(
	repoDir: string,
	priorRunId: string,
): CloseoutRunFacts {
	let run: PriorRun;
	try {
		run = loadPriorRun(repoDir, priorRunId);
	} catch (error) {
		throw asCommentError(error);
	}
	const panelRaw = readJson(
		path.join(run.recordPath, PANEL_FILE),
		"panel.json",
	);
	if (
		panelRaw === null ||
		typeof panelRaw !== "object" ||
		!Array.isArray((panelRaw as PanelRecord).seats)
	) {
		throw new Error("comment refused: panel.json is invalid");
	}
	const panel = panelRaw as PanelRecord;
	const executionPath = path.join(run.recordPath, EXECUTION_FILE);
	const lost = isRealFile(executionPath)
		? lostFromExecution(readJson(executionPath, "execution.json"))
		: [];
	return { run, panel, lost };
}

type VerificationOutcome = {
	outcome?: {
		kind?: unknown;
		result?: { items?: Array<{ id?: unknown; disposition?: unknown }> };
	};
};

export function assertFixedResolved(
	repoDir: string,
	verifyRunId: string,
	fixedIds: readonly string[],
): void {
	if (fixedIds.length === 0) {
		return;
	}
	let runId: string;
	try {
		runId = resolvePriorRunId(repoDir, verifyRunId);
	} catch (error) {
		throw asCommentError(error);
	}
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
		throw new Error(`comment refused: verify run "${runId}" is not complete`);
	}
	const raw = readJson(
		path.join(recordPath, "verification.json"),
		"verification.json",
	);
	if (raw === null || typeof raw !== "object") {
		throw new Error("comment refused: verification.json is invalid");
	}
	const outcomes = (raw as { outcomes?: unknown }).outcomes;
	if (!Array.isArray(outcomes)) {
		throw new Error("comment refused: verification.json has no outcomes");
	}
	const dispositions = new Map<string, Set<string>>();
	for (const row of outcomes as VerificationOutcome[]) {
		if (row.outcome?.kind !== "voted") {
			continue;
		}
		for (const item of row.outcome.result?.items ?? []) {
			if (typeof item.id !== "string" || typeof item.disposition !== "string") {
				continue;
			}
			const seen = dispositions.get(item.id) ?? new Set<string>();
			seen.add(item.disposition);
			dispositions.set(item.id, seen);
		}
	}
	for (const id of fixedIds) {
		const states = dispositions.get(id);
		if (states === undefined) {
			throw new Error(
				`comment refused: ${id} was not verified; pass verifyRunId from a clean verify`,
			);
		}
		if (states.size !== 1 || !states.has("resolved")) {
			throw new Error(
				`comment refused: ${id} is ${[...states].join("/")} in verify, not resolved`,
			);
		}
	}
}
