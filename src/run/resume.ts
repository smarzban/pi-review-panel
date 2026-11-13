import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

import {
	MAX_AUDIT_SEATS,
	MAX_AUDIT_SEATS_PER_PASS,
} from "../config/audit-panel.js";
import { loadAuditPassTable } from "../config/audit-passes.js";
import {
	HOLISTIC_LENS,
	loadLensTable,
	SPECIALIST_SEAT_CAP,
} from "../config/lenses.js";
import { MAX_REVIEW_SEATS } from "../config/panel.js";
import type { Config } from "../config/schema.js";
import { isProcessAlive } from "./liveness.js";
import { discoverPriorRecords } from "./prior-records.js";
import { resolvePriorRunId } from "./prior-run.js";
import {
	acquireRunLock,
	assertRealDirectory,
	assertRecordWritable,
	COMPLETE_MARKER,
	digestBaseRef,
	PLAN_FILE,
	readRegularFile,
	readSettledOutcomes,
	recordAt,
	runLockHolder,
	sanitizeBaseRef,
} from "./record.js";
import {
	executeAudit,
	type RunAuditOptions,
	type RunAuditResult,
} from "./run-audit.js";
import {
	executeReview,
	type RunReviewOptions,
	type RunReviewResult,
} from "./run-review.js";
import type { PlannedSeat, RunPlan, SeatOutcomeFacts } from "./types.js";

/** An interrupted review or audit record that `resume` can finish. */
export type ResumableRun = {
	repoDir: string;
	runId: string;
	recordPath: string;
	plan: RunPlan;
	/** Settled outcomes by planned index; undefined where a seat must run again. */
	settled: Array<SeatOutcomeFacts | undefined>;
	/** The planned seat identities that have no settled outcome, in order. */
	missing: RunPlan["seats"];
};

export type ResumeResult = (RunReviewResult | RunAuditResult) & {
	kind: RunPlan["kind"];
	runId: string;
	plan: RunPlan;
	resumedSeats: PlannedSeat[];
	/** Planned seats resume could not rebuild from the owner config: lost coverage. */
	lostSeats: PlannedSeat[];
	/** True when the record named a scoping note, which resume does not pass on. */
	scopingNoteDropped: boolean;
};

export type ResumeOptions = RunReviewOptions &
	RunAuditOptions & {
		/**
		 * The owner config. Seat models, extension paths and the seat budget come
		 * from it, never from the record in the reviewed repository.
		 */
		config: Config;
		/** Package prompt tables; injectable for tests only. */
		lensTable?: Map<string, string>;
		passTable?: Map<string, string>;
		/**
		 * Called once the run lock is held and the record re-read, with the
		 * number of seats about to run, before any seat starts.
		 */
		onStart?: (start: { toRun: number }) => void;
	};

const VERIFY_RUN_SUFFIX = `-${sanitizeBaseRef("verify")}-${digestBaseRef("verify")}`;

function refuse(message: string): never {
	throw new Error(`Resume refused: ${message}`);
}

/**
 * Checks that a record can be resumed, before anything runs: it exists, is
 * not complete, is a review or audit with a resume plan, is not held by a
 * live run, and its frozen commits still resolve here.
 */
export function loadResumable(
	repoDir: string,
	priorRunId: string,
): ResumableRun {
	// A symlink at either folder would take reads and writes out of the
	// repository; reserve() refuses the same.
	for (const dir of [
		path.join(repoDir, ".review-panel"),
		path.join(repoDir, ".review-panel", "runs"),
	]) {
		try {
			assertRealDirectory(dir);
		} catch (error) {
			if (isNotFound(error)) {
				break;
			}
			refuse(error instanceof Error ? error.message : String(error));
		}
	}
	let runId: string;
	try {
		runId = resolvePriorRunId(repoDir, priorRunId);
	} catch (error) {
		refuse(
			(error instanceof Error ? error.message : String(error)).replace(
				/^Verify refused: /,
				"",
			),
		);
	}
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
	if (!isRealDirectory(recordPath)) {
		refuse(`run "${runId}" was not found`);
	}
	if (exists(path.join(recordPath, COMPLETE_MARKER))) {
		refuse(`run "${runId}" is already complete; there is nothing to resume`);
	}
	if (runId.endsWith(VERIFY_RUN_SUFFIX)) {
		refuse(
			`run "${runId}" is a verify run; start a new verify instead (verify runs one or two seats in sequence, so a fresh run costs the same as a resume)`,
		);
	}
	const plan = readPlan(recordPath, runId);
	checkPanelCaps(plan, runId);
	checkWritable(recordPath, plan);
	const holder = runLockHolder(recordPath);
	if (holder !== undefined && isProcessAlive(holder)) {
		refuse(`run "${runId}" is still in progress (pid ${holder})`);
	}
	for (const [label, oid] of [
		["head", plan.headOid],
		["base", plan.baseOid],
	] as const) {
		if (!commitResolves(repoDir, oid)) {
			refuse(
				`${label} commit ${oid} of run "${runId}" cannot be resolved in this repository`,
			);
		}
	}
	const settled = readSettledOutcomes(recordPath, plan.seats);
	const missing = plan.seats.filter((_, index) => settled[index] === undefined);
	return { repoDir, runId, recordPath, plan, settled, missing };
}

/**
 * Finishes an interrupted record in place: takes the run lock, re-reads the
 * record under it, pins the recorded head commit, runs only the unsettled
 * seats from the record's own panel, and writes the final artifacts as a
 * first run would. The record's scoping note is not passed to the seats: the
 * record lives in the reviewed repository, and resume takes no prompt text
 * from it.
 */
export async function resumeRun(
	run: ResumableRun,
	options: ResumeOptions,
): Promise<ResumeResult> {
	const record = recordAt(run.recordPath);
	const { plan } = run;
	const { config, lensTable, passTable, onStart, ...runOptions } = options;
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = acquireRunLock(run.recordPath);
	} catch (error) {
		refuse(error instanceof Error ? error.message : String(error));
	}
	let handedOver = false;
	try {
		// Another process may have settled seats, or finished the record,
		// between loading it and taking the lock.
		if (exists(path.join(run.recordPath, COMPLETE_MARKER))) {
			refuse(
				`run "${run.runId}" is already complete; there is nothing to resume`,
			);
		}
		checkWritable(run.recordPath, plan);
		const prompts =
			plan.kind === "review"
				? (lensTable ?? loadLensTable())
				: (passTable ?? loadAuditPassTable());
		const rows = new Map(config.roster.map((row) => [row.id, row]));
		const settled = readSettledOutcomes(run.recordPath, plan.seats);
		const lost: number[] = [];
		const seats = plan.seats.map((identity, index): PlannedSeat => {
			const row = rows.get(identity.rosterId);
			const prompt = prompts.get(identity.lens);
			// Only the four identity keys cross from the record; anything else a
			// planted plan carries is dropped here.
			const seat: PlannedSeat = {
				rosterId: identity.rosterId,
				provider: identity.provider,
				model: identity.model,
				lens: identity.lens,
				lensPrompt: prompt ?? "",
				...(row?.extraExtensionPaths === undefined
					? {}
					: { extraExtensionPaths: [...row.extraExtensionPaths] }),
			};
			const reason =
				row === undefined
					? `roster row "${identity.rosterId}" is not in the owner config`
					: row.provider !== identity.provider || row.model !== identity.model
						? `roster row "${identity.rosterId}" is now ${row.provider}/${row.model}, not ${identity.provider}/${identity.model}`
						: prompt === undefined
							? `"${identity.lens}" is not a ${plan.kind === "review" ? "lens" : "audit pass"} this package ships`
							: undefined;
			if (settled[index] === undefined && reason !== undefined) {
				lost.push(index);
				settled[index] = unrecoverable(seat, plan, reason);
			}
			return seat;
		});
		const scopingNoteDropped = plan.scopingNote !== undefined;
		const resume = {
			settled,
			lost,
			heldLock: releaseLock,
			scopingNoteDropped,
		};
		const seatBudgetMs = config.defaults.seatBudgetMs;
		const priorRecordPaths =
			plan.kind === "review"
				? discoverPriorRecords(run.repoDir).map((entry) => entry.path)
				: [];
		onStart?.({
			toRun: settled.filter((facts) => facts === undefined).length,
		});
		// From here the run owns the lock and releases it when it ends.
		handedOver = true;
		const result =
			plan.kind === "review"
				? await executeReview(
						record,
						{
							repoDir: run.repoDir,
							baseRef: plan.baseRef,
							baseOid: plan.baseOid,
							headOid: plan.headOid,
							seats,
							...(seatBudgetMs === undefined ? {} : { seatBudgetMs }),
							priorRecordPaths,
						},
						runOptions,
						resume,
					)
				: await executeAudit(
						record,
						{
							repoDir: run.repoDir,
							revision: plan.headOid,
							seats,
							...(seatBudgetMs === undefined ? {} : { seatBudgetMs }),
						},
						runOptions,
						resume,
					);
		return {
			...result,
			kind: plan.kind,
			runId: run.runId,
			plan,
			resumedSeats: result.resumedSeats ?? [],
			lostSeats: lost.map((index) => seats[index] as PlannedSeat),
			scopingNoteDropped,
		};
	} finally {
		// Once handed over, the run releases the lock itself.
		if (!handedOver) {
			releaseLock?.();
		}
	}
}

/** Refuses a record that holds something a run could not safely write over. */
function checkWritable(recordPath: string, plan: RunPlan): void {
	try {
		assertRecordWritable(recordPath, plan.seats.length);
	} catch (error) {
		refuse(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Refuses a plan the panel planner could never have made: more seats than a
 * panel may have, one lens or pass on more seats than its cap, or one seat
 * identity twice. Settled and unrebuildable seats count too, so a planted
 * plan cannot spend past the owner's limits.
 */
function checkPanelCaps(plan: RunPlan, runId: string): void {
	const review = plan.kind === "review";
	const maxSeats = review ? MAX_REVIEW_SEATS : MAX_AUDIT_SEATS;
	if (plan.seats.length > maxSeats) {
		refuse(
			`run "${runId}" plans ${plan.seats.length} seats; a${review ? " review panel" : "n audit"} has at most ${maxSeats}`,
		);
	}
	const identities = new Set<string>();
	const perLens = new Map<string, number>();
	for (const seat of plan.seats) {
		const identity = JSON.stringify([seat.provider, seat.model, seat.lens]);
		if (identities.has(identity)) {
			refuse(`run "${runId}" plans the same seat twice`);
		}
		identities.add(identity);
		perLens.set(seat.lens, (perLens.get(seat.lens) ?? 0) + 1);
	}
	for (const [lens, count] of perLens) {
		if (review && lens !== HOLISTIC_LENS && count > SPECIALIST_SEAT_CAP) {
			refuse(
				`run "${runId}" plans lens "${lens}" on ${count} seats; at most ${SPECIALIST_SEAT_CAP}`,
			);
		}
		if (!review && count > MAX_AUDIT_SEATS_PER_PASS) {
			refuse(
				`run "${runId}" plans pass "${lens}" on ${count} seats; at most ${MAX_AUDIT_SEATS_PER_PASS}`,
			);
		}
	}
}

/** A failed outcome for a seat resume could not rebuild; it never runs. */
function unrecoverable(
	seat: PlannedSeat,
	plan: RunPlan,
	reason: string,
): SeatOutcomeFacts {
	const now = Date.now();
	return {
		seat,
		replay: {
			provider: seat.provider,
			model: seat.model,
			lens: seat.lens,
			lensPrompt: seat.lensPrompt,
			baseRef: plan.baseOid,
			worktree: "",
		},
		lifecycle: {
			startedAtMs: now,
			settledAtMs: now,
			durationMs: 0,
			attempts: 1,
			aborted: false,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		outcome: {
			kind: "failed",
			class: "spawn-failure",
			reason: `resume could not rebuild this seat: ${reason}`,
		},
	};
}

function readPlan(recordPath: string, runId: string): RunPlan {
	const text = readRegularFile(path.join(recordPath, PLAN_FILE));
	if (text === undefined) {
		refuse(
			`run "${runId}" has no resume plan, so it cannot be resumed: it stopped before its plan was written, when no seat had run yet, or a version without resume started it. Start a new run instead.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		refuse(`run "${runId}" has an unreadable resume plan`);
	}
	if (!isRunPlan(parsed)) {
		refuse(`run "${runId}" has an invalid resume plan`);
	}
	return parsed;
}

function isRunPlan(value: unknown): value is RunPlan {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const plan = value as Partial<RunPlan>;
	return (
		plan.version === 1 &&
		(plan.kind === "review" || plan.kind === "audit") &&
		typeof plan.baseRef === "string" &&
		isOid(plan.baseOid) &&
		isOid(plan.headOid) &&
		(plan.scopingNote === undefined || typeof plan.scopingNote === "string") &&
		Array.isArray(plan.seats) &&
		plan.seats.length > 0 &&
		plan.seats.every(
			(seat) =>
				typeof seat === "object" &&
				seat !== null &&
				typeof seat.rosterId === "string" &&
				typeof seat.provider === "string" &&
				typeof seat.model === "string" &&
				typeof seat.lens === "string",
		)
	);
}

/** Only a full hex object id; never something git could read as an option. */
function isOid(value: unknown): value is string {
	return (
		typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)
	);
}

function commitResolves(repoDir: string, oid: string): boolean {
	try {
		execFileSync("git", ["cat-file", "-e", `${oid}^{commit}`], {
			cwd: repoDir,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function isRealDirectory(target: string): boolean {
	try {
		return lstatSync(target).isDirectory();
	} catch {
		return false;
	}
}

function exists(target: string): boolean {
	try {
		lstatSync(target);
		return true;
	} catch {
		return false;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
