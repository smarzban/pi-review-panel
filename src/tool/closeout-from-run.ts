import { lstatSync } from "node:fs";
import path from "node:path";

import {
	loadPriorRun,
	NEW_REVIEW_FIX,
	type PriorRun,
	resolvePriorRunId,
} from "../run/prior-run.js";
import { COMPLETE_MARKER, readSignedRecord } from "../run/record.js";
import type { PanelRecord } from "../run/types.js";
import {
	dispositionsOf,
	resolvedIdsOf,
	type SignedVerifyRound,
	unresolvedIdsOf,
	votedSeatsOf,
} from "./closeout-rounds.js";

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

function parseJson(text: string, label: string): unknown {
	try {
		return JSON.parse(text);
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

/**
 * The review record the close-out card is built from, only when it is signed
 * by the owner's record key (see `loadPriorRun`). The panel and lost seats are
 * parsed from the same signed bytes.
 */
export function loadCloseoutRun(
	repoDir: string,
	priorRunId: string,
	recordKey: Buffer,
): CloseoutRunFacts {
	let run: PriorRun;
	try {
		run = loadPriorRun(repoDir, priorRunId, recordKey);
	} catch (error) {
		throw asCommentError(error);
	}
	return closeoutFactsOf(run);
}

/**
 * The close-out facts of a review record already loaded and authenticated by
 * `loadPriorRun`, parsed from its signed bytes, never read again from disk.
 */
export function closeoutFactsOf(run: PriorRun): CloseoutRunFacts {
	const panelRaw = parseJson(run.panelText, "panel.json");
	if (
		panelRaw === null ||
		typeof panelRaw !== "object" ||
		!Array.isArray((panelRaw as PanelRecord).seats)
	) {
		throw new Error("comment refused: panel.json is invalid");
	}
	const panel = panelRaw as PanelRecord;
	const lost = lostFromExecution(
		parseJson(run.executionText, "execution.json"),
	);
	return { run, panel, lost };
}

/**
 * Checks that a verify run of this review marked every resolved id resolved,
 * and returns that verify as a round of the card (no number: the caller
 * finds that among the posted rounds). The verify record is taken only when
 * it is signed by the owner's record key (`record.mac` over its panel, meta
 * and verification bytes, bound to its own run id); a planted or copied
 * verify record is refused.
 */
export function assertFixedResolved(
	repoDir: string,
	verifyRunId: string,
	fixedIds: readonly string[],
	expectedPriorRunId: string,
	recordKey: Buffer,
): SignedVerifyRound {
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
	let signed: ReadonlyMap<string, string>;
	try {
		signed = readSignedRecord(
			recordPath,
			"verify",
			recordKey,
			`verify run "${runId}"`,
			`${NEW_REVIEW_FIX}, then verify it`,
		);
	} catch (error) {
		throw new Error(
			`comment refused: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const raw = parseJson(
		signed.get("verification.json") as string,
		"verification.json",
	);
	if (raw === null || typeof raw !== "object") {
		throw new Error("comment refused: verification.json is invalid");
	}
	const record = raw as { priorRunId?: unknown; outcomes?: unknown };
	if (
		typeof record.priorRunId !== "string" ||
		record.priorRunId.trim() === ""
	) {
		throw new Error("comment refused: verify run has no priorRunId");
	}
	if (record.priorRunId !== expectedPriorRunId) {
		throw new Error(
			`comment refused: verify run priorRunId is "${record.priorRunId}", not "${expectedPriorRunId}"`,
		);
	}
	const outcomes = record.outcomes;
	if (!Array.isArray(outcomes)) {
		throw new Error("comment refused: verification.json has no outcomes");
	}
	const dispositions = dispositionsOf(outcomes);
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
	const meta = parseJson(signed.get("meta.json") as string, "meta.json") as {
		headOid?: unknown;
	} | null;
	return {
		runId,
		seats: votedSeatsOf(outcomes),
		resolved: resolvedIdsOf(dispositions),
		unresolved: unresolvedIdsOf(dispositions),
		...(typeof meta?.headOid === "string" ? { headOid: meta.headOid } : {}),
	};
}
