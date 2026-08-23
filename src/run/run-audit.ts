// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import type { SdkSessionFactory } from "../seat/run-seat.js";
import { collectFindings } from "./collect.js";
import { complete, reserve, writeExecution, writePanel } from "./record.js";
import { renderAuditFindingsJson, renderAuditReport } from "./render-audit.js";
import { resolveCommitOid } from "./run-review.js";
import {
	type ReviewProgressEvent,
	RunCancelledError,
	type SeatConcurrencyGate,
	scheduleSeats,
} from "./scheduler.js";
import {
	type PinnedSnapshot,
	pinSnapshot,
	type SnapshotReleaseOutcome,
} from "./snapshot.js";
import type { PlannedSeat, RunResult } from "./types.js";

export const AUDIT_RECORD_REF = "audit";
export const AUDIT_CLEANUP_ERROR_FILE = "cleanup-error.txt";

export type RunAuditInput = {
	repoDir: string;
	revision?: string;
	seats: PlannedSeat[];
	scopingNote?: string;
	seatBudgetMs?: number;
};

export type RunAuditResult = RunResult & { cleanupError?: string };

export type RunAuditOptions = {
	abortSignal?: AbortSignal;
	pinSnapshot?: typeof pinSnapshot;
	scheduleSeats?: typeof scheduleSeats;
	writePanel?: typeof writePanel;
	sessionFactory?: SdkSessionFactory;
	concurrencyGate?: SeatConcurrencyGate;
	onProgress?: (event: ReviewProgressEvent) => void;
};

export class RunAuditError extends Error {
	readonly stage: string;
	readonly cleanupError?: string;

	constructor(stage: string, cause: unknown, cleanupError?: string) {
		super(`audit failed during stage "${stage}": ${messageOf(cause)}`);
		this.name = "RunAuditError";
		this.stage = stage;
		this.cleanupError = cleanupError;
	}
}

/** Runs a package-owned, whole-tree audit against one pinned HEAD snapshot. */
export async function runAudit(
	input: RunAuditInput,
	options: RunAuditOptions = {},
): Promise<RunAuditResult> {
	if (options.abortSignal?.aborted) {
		throw new Error("audit refused: already cancelled");
	}
	if (!Array.isArray(input.seats) || input.seats.length === 0) {
		throw new Error("audit refused: at least one seat is required");
	}
	const revision = resolveCommitOid(input.repoDir, input.revision ?? "HEAD");
	const record = reserve(input.repoDir, AUDIT_RECORD_REF, {
		role: "repo-audit",
	});
	const pin = options.pinSnapshot ?? pinSnapshot;
	const schedule = options.scheduleSeats ?? scheduleSeats;
	let stage = "panel";
	let snapshot: PinnedSnapshot | undefined;
	let released = false;
	let releaseOutcome: SnapshotReleaseOutcome | undefined;
	const releaseOnce = (): SnapshotReleaseOutcome | undefined => {
		if (snapshot === undefined || released) {
			return releaseOutcome;
		}
		released = true;
		releaseOutcome = snapshot.release();
		return releaseOutcome;
	};

	try {
		(options.writePanel ?? writePanel)(record, {
			runId: record.runId,
			baseRef: AUDIT_RECORD_REF,
			...(input.scopingNote === undefined
				? {}
				: { scopingNote: input.scopingNote }),
			seats: input.seats,
		});
		stage = "pin";
		snapshot = pin(input.repoDir, revision);
		stage = "schedule";
		const outcomes = await schedule(
			{
				seats: input.seats,
				worktree: snapshot.worktreePath,
				baseRef: revision,
				audit: true,
				...(input.scopingNote === undefined
					? {}
					: { scopingNote: input.scopingNote }),
			},
			{
				...(input.seatBudgetMs === undefined
					? {}
					: { seatBudgetMs: input.seatBudgetMs }),
				...(options.abortSignal === undefined
					? {}
					: { runAbortSignal: options.abortSignal }),
				...(options.sessionFactory === undefined
					? {}
					: { sessionFactory: options.sessionFactory }),
				...(options.concurrencyGate === undefined
					? {}
					: { concurrencyGate: options.concurrencyGate }),
				...(options.onProgress === undefined
					? {}
					: { onProgress: options.onProgress }),
			},
		);
		writeExecution(record, { cancelled: false, outcomes });
		stage = "collect";
		const stamped = collectFindings(outcomes);
		stage = "release";
		const release = releaseOnce();
		const cleanupError =
			release?.ok === false ? cleanupMessage(release.error) : undefined;
		stage = "render";
		writeFileSync(
			record.reportPath,
			renderAuditReport({
				runId: record.runId,
				snapshotOid: revision,
				stamped,
				outcomes,
				...(cleanupError === undefined ? {} : { cleanupError }),
			}),
		);
		writeFileSync(record.findingsPath, renderAuditFindingsJson(stamped));
		writeFileSync(
			path.join(record.recordPath, "meta.json"),
			`${JSON.stringify({ runId: record.runId, snapshotOid: revision, kind: "audit" }, null, 2)}\n`,
		);
		if (cleanupError !== undefined) {
			writeFileSync(
				path.join(record.recordPath, AUDIT_CLEANUP_ERROR_FILE),
				`${cleanupError}\n`,
			);
		}
		stage = "complete";
		complete(record);
		return {
			recordPath: record.recordPath,
			outcomes,
			...(cleanupError === undefined ? {} : { cleanupError }),
		};
	} catch (cause) {
		const release = releaseOnce();
		const cleanupError =
			release?.ok === false ? cleanupMessage(release.error) : undefined;
		if (cause instanceof RunCancelledError) {
			writeExecution(record, { cancelled: true, outcomes: cause.outcomes });
		}
		const error = new RunAuditError(stage, cause, cleanupError);
		error.cause = cause;
		throw error;
	}
}

function cleanupMessage(error: string | undefined): string {
	return error ?? "snapshot release failed";
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
