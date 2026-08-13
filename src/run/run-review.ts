// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import type { SdkSessionFactory } from "../seat/run-seat.js";
import { collectFindings } from "./collect.js";
import { flagPersistence } from "./flag.js";
import { complete, reserve, writeExecution, writePanel } from "./record.js";
import { renderFindingsJson, renderReport } from "./render.js";
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
import type { RunConfig, RunResult } from "./types.js";

/** Filename for a durable snapshot-cleanup failure notice (AC-19). */
export const CLEANUP_ERROR_FILE = "cleanup-error.txt";

export type RunReviewResult = RunResult & {
	cleanupError?: string;
};

export type RunReviewOptions = {
	abortSignal?: AbortSignal;
	pinSnapshot?: typeof pinSnapshot;
	scheduleSeats?: typeof scheduleSeats;
	writePanel?: typeof writePanel;
	sessionFactory?: SdkSessionFactory;
	/** Shared scheduler-owned cap for concurrently executing role panels. */
	concurrencyGate?: SeatConcurrencyGate;
	onProgress?: (event: ReviewProgressEvent) => void;
};

export class RunReviewError extends Error {
	readonly stage: string;
	readonly cleanupError?: string;

	constructor(stage: string, cause: unknown, cleanupError?: string) {
		super(`run failed during stage "${stage}": ${messageOf(cause)}`);
		this.name = "RunReviewError";
		this.stage = stage;
		this.cleanupError = cleanupError;
	}
}

/**
 * End-to-end review. Snapshot release is exactly-once via releaseOnce.
 * Persistence after a successful release cannot invent a false cleanup error.
 */
export async function runReview(
	config: RunConfig,
	options: RunReviewOptions = {},
): Promise<RunReviewResult> {
	if (options.abortSignal?.aborted) {
		throw new Error("run refused: already cancelled");
	}
	if (typeof config.baseRef !== "string" || config.baseRef.trim() === "") {
		throw new Error("run refused: baseRef is required and must not be empty");
	}
	if (!Array.isArray(config.seats) || config.seats.length === 0) {
		throw new Error("run refused: at least one seat is required");
	}

	const baseOid = resolveCommitOid(
		config.repoDir,
		config.baseRevision ?? config.baseRef,
	);
	const headOid = resolveCommitOid(
		config.repoDir,
		config.headRevision ?? config.revision ?? "HEAD",
	);

	const pin = options.pinSnapshot ?? pinSnapshot;
	const schedule = options.scheduleSeats ?? scheduleSeats;

	const record = reserve(
		config.repoDir,
		config.baseRef,
		config.role === undefined ? undefined : { role: config.role },
	);
	let stage = "panel";
	let snapshot: PinnedSnapshot | undefined;
	let released = false;
	let releaseOutcome: SnapshotReleaseOutcome | undefined;

	const releaseOnce = (): SnapshotReleaseOutcome | undefined => {
		if (snapshot === undefined) {
			return undefined;
		}
		if (released) {
			return releaseOutcome;
		}
		released = true;
		releaseOutcome = snapshot.release();
		return releaseOutcome;
	};

	try {
		// The planned panel is durable before any pinning or scheduling, so a
		// run that reaches reservation retains it even if it aborts (AC-25).
		const panelWrite = options.writePanel ?? writePanel;
		panelWrite(record, {
			runId: record.runId,
			baseRef: config.baseRef,
			...(config.scopingNote === undefined
				? {}
				: { scopingNote: config.scopingNote }),
			seats: config.seats,
		});
		stage = "pin";
		snapshot = pin(config.repoDir, headOid);
		stage = "schedule";
		const outcomes = await schedule(
			{
				seats: config.seats,
				worktree: snapshot.worktreePath,
				baseRef: baseOid,
				...(config.scopingNote === undefined
					? {}
					: { scopingNote: config.scopingNote }),
			},
			{
				seatBudgetMs: config.seatBudgetMs,
				runAbortSignal: options.abortSignal,
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
		stage = "flag";
		const annotations = flagPersistence(stamped, config.priorRecordPaths ?? []);
		stage = "release";
		const release = releaseOnce();
		const cleanupError =
			release !== undefined && !release.ok
				? cleanupMessage(release.error)
				: undefined;
		stage = "render";
		const meta = {
			runId: record.runId,
			baseRef: config.baseRef,
			baseOid,
			headOid,
		};
		// Durable cleanup notice BEFORE COMPLETE (AC-19).
		writeFileSync(
			record.reportPath,
			renderReport({
				meta,
				stamped,
				outcomes,
				annotations,
				...(cleanupError === undefined ? {} : { cleanupError }),
			}),
		);
		writeFileSync(record.findingsPath, renderFindingsJson(stamped));
		writeFileSync(
			path.join(record.recordPath, "meta.json"),
			`${JSON.stringify(meta, null, 2)}\n`,
		);
		if (cleanupError !== undefined) {
			writeFileSync(
				path.join(record.recordPath, CLEANUP_ERROR_FILE),
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
			release !== undefined && !release.ok
				? cleanupMessage(release.error)
				: undefined;
		if (cause instanceof RunCancelledError) {
			writeExecution(record, { cancelled: true, outcomes: cause.outcomes });
			const err = new RunReviewError("schedule", cause, cleanupError);
			err.cause = cause;
			throw err;
		}
		throw new RunReviewError(stage, cause, cleanupError);
	}
}

function cleanupMessage(error: string | undefined): string {
	return error ?? "snapshot release failed";
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function resolveCommitOid(repoDir: string, ref: string): string {
	if (ref.startsWith("-")) {
		throw new Error(
			`run refused: baseRef must not look like a git option: ${ref}`,
		);
	}
	try {
		return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
			cwd: repoDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		throw new Error(
			`run refused: baseRef does not resolve to a commit: ${ref}`,
		);
	}
}
