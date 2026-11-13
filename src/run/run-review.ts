import { execFileSync } from "node:child_process";
import path from "node:path";
import type { SdkSessionFactory } from "../seat/run-seat.js";
import { collectFindings } from "./collect.js";
import { flagPersistence } from "./flag.js";
import {
	acquireRunLock,
	complete,
	projectSeat,
	type RecordSeal,
	reserve,
	writeExecution,
	writePanel,
	writePlan,
	writeRecordFile,
	writeSeatOutcome,
} from "./record.js";
import {
	type ResumeFacts,
	renderFindingsJson,
	renderReport,
} from "./render.js";
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
import type {
	PlannedSeat,
	ReservedRecord,
	RunConfig,
	RunResult,
	SeatOutcomeFacts,
} from "./types.js";

/** Filename for a durable snapshot-cleanup failure notice (AC-19). */
export const CLEANUP_ERROR_FILE = "cleanup-error.txt";

export type RunReviewResult = RunResult & {
	cleanupError?: string;
	/** Seats a resume ran again; absent on a first run. */
	resumedSeats?: PlannedSeat[];
};

/** A frozen review the record already describes: what runs and against what. */
export type ReviewExecution = {
	repoDir: string;
	baseRef: string;
	baseOid: string;
	headOid: string;
	seats: PlannedSeat[];
	scopingNote?: string;
	seatBudgetMs?: number;
	priorRecordPaths?: string[];
};

/** What a resume starts from, by planned index. */
export type ResumeState = {
	/**
	 * Outcomes that need no run: seats settled before the interruption, and
	 * failed outcomes for seats that could not be rebuilt (listed in `lost`).
	 */
	settled: Array<SeatOutcomeFacts | undefined>;
	/** Planned indexes whose seat could not be rebuilt: lost coverage. */
	lost: number[];
	/**
	 * The record's run lock, already taken by the caller (resume takes it
	 * before re-reading the record). The run releases it when it ends.
	 */
	heldLock?: () => void;
	/** The record named a scoping note that resume did not pass to the seats. */
	scopingNoteDropped?: boolean;
	/** Signs the seats this resume runs; absent only for an unsigned record. */
	seal?: RecordSeal;
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
	/**
	 * The owner's record key. A first run signs its plan and seat files with
	 * it; without one the record is unsigned and cannot be resumed.
	 */
	recordKey?: Buffer;
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

	const record = reserve(
		config.repoDir,
		config.baseRef,
		config.role === undefined ? undefined : { role: config.role },
	);
	return executeReview(
		record,
		{
			repoDir: config.repoDir,
			baseRef: config.baseRef,
			baseOid,
			headOid,
			seats: config.seats,
			...(config.scopingNote === undefined
				? {}
				: { scopingNote: config.scopingNote }),
			...(config.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.seatBudgetMs }),
			...(config.priorRecordPaths === undefined
				? {}
				: { priorRecordPaths: config.priorRecordPaths }),
		},
		options,
	);
}

/**
 * Runs a reserved review record to completion. A first run writes the panel
 * and resume plan; a resume (`resume` set) reuses them and schedules only the
 * seats that had not settled. Each seat is persisted the moment it settles.
 */
export async function executeReview(
	record: ReservedRecord,
	config: ReviewExecution,
	options: RunReviewOptions = {},
	resume?: ResumeState,
): Promise<RunReviewResult> {
	const { baseOid, headOid } = config;
	const pin = options.pinSnapshot ?? pinSnapshot;
	const schedule = options.scheduleSeats ?? scheduleSeats;
	const releaseLock = resume?.heldLock ?? acquireRunLock(record.recordPath);
	const settled =
		resume?.settled ??
		config.seats.map((): SeatOutcomeFacts | undefined => undefined);
	const missing = config.seats.flatMap((_, index) =>
		settled[index] === undefined ? [index] : [],
	);
	const resumedSeats =
		resume === undefined
			? undefined
			: missing.map((index) => config.seats[index]);
	let seal = resume?.seal;
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
		if (resume === undefined) {
			const panelWrite = options.writePanel ?? writePanel;
			panelWrite(record, {
				runId: record.runId,
				baseRef: config.baseRef,
				...(config.scopingNote === undefined
					? {}
					: { scopingNote: config.scopingNote }),
				seats: config.seats,
			});
			seal = writePlan(
				record,
				{
					version: 1,
					kind: "review",
					runId: record.runId,
					baseRef: config.baseRef,
					baseOid,
					headOid,
					...(config.scopingNote === undefined
						? {}
						: { scopingNote: config.scopingNote }),
					seats: config.seats.map(projectSeat),
				},
				options.recordKey,
			);
		}
		stage = "pin";
		snapshot = pin(config.repoDir, headOid);
		stage = "schedule";
		const fresh =
			missing.length === 0
				? []
				: await schedule(
						{
							seats: missing.map((index) => config.seats[index]),
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
							onSeatSettled: (index, facts) =>
								writeSeatOutcome(record, missing[index], facts, seal),
						},
					);
		const outcomes = mergeOutcomes(settled, missing, fresh);
		writeExecution(record, {
			cancelled: false,
			outcomes,
			...(resumedSeats === undefined ? {} : { resumedSeats }),
		});
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
		writeRecordFile(
			record.reportPath,
			renderReport({
				meta,
				stamped,
				outcomes,
				annotations,
				...(cleanupError === undefined ? {} : { cleanupError }),
				...(resumedSeats === undefined
					? {}
					: {
							resume: resumeSummary(
								config.seats,
								missing,
								resume?.lost ?? [],
								resume?.scopingNoteDropped === true,
							),
						}),
			}),
		);
		writeRecordFile(record.findingsPath, renderFindingsJson(stamped));
		writeRecordFile(
			path.join(record.recordPath, "meta.json"),
			`${JSON.stringify(meta, null, 2)}\n`,
		);
		if (cleanupError !== undefined) {
			writeRecordFile(
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
			...(resumedSeats === undefined ? {} : { resumedSeats }),
		};
	} catch (cause) {
		const release = releaseOnce();
		const cleanupError =
			release !== undefined && !release.ok
				? cleanupMessage(release.error)
				: undefined;
		if (cause instanceof RunCancelledError) {
			writeExecution(record, {
				cancelled: true,
				outcomes: [...settledOnly(settled), ...cause.outcomes],
			});
			const err = new RunReviewError("schedule", cause, cleanupError);
			err.cause = cause;
			throw err;
		}
		throw new RunReviewError(stage, cause, cleanupError);
	} finally {
		releaseLock();
	}
}

/** Planned-order outcomes: settled seats as recorded, the rest from this run. */
export function mergeOutcomes(
	settled: ReadonlyArray<SeatOutcomeFacts | undefined>,
	missing: readonly number[],
	fresh: readonly SeatOutcomeFacts[],
): SeatOutcomeFacts[] {
	return settled.map((facts, index) => {
		if (facts !== undefined) {
			return facts;
		}
		const ran = fresh[missing.indexOf(index)];
		if (ran === undefined) {
			throw new Error(
				`internal: missing result for planned seat index ${index}`,
			);
		}
		return ran;
	});
}

export function settledOnly(
	settled: ReadonlyArray<SeatOutcomeFacts | undefined>,
): SeatOutcomeFacts[] {
	return settled.filter(
		(facts): facts is SeatOutcomeFacts => facts !== undefined,
	);
}

/** Which seats a resume ran again and which it kept, for the report. */
export function resumeSummary(
	seats: readonly PlannedSeat[],
	missing: readonly number[],
	lost: readonly number[],
	scopingNoteDropped = false,
): ResumeFacts {
	return {
		scopingNoteDropped,
		rerun: missing.map((index) => seats[index]),
		kept: seats.filter(
			(_, index) => !missing.includes(index) && !lost.includes(index),
		),
		lost: lost.map((index) => seats[index]),
	};
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
