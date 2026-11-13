import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadAuditPassTable } from "../config/audit-passes.js";
import { loadLensTable } from "../config/lenses.js";
import type { Config } from "../config/schema.js";
import { isProcessAlive } from "./liveness.js";
import { discoverPriorRecords } from "./prior-records.js";
import { resolvePriorRunId } from "./prior-run.js";
import {
	COMPLETE_MARKER,
	digestBaseRef,
	PLAN_FILE,
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
 * Finishes an interrupted record in place: pins the recorded head commit,
 * runs only the unsettled seats from the record's own panel, and writes the
 * final artifacts as a first run would.
 */
export async function resumeRun(
	run: ResumableRun,
	options: ResumeOptions,
): Promise<ResumeResult> {
	const record = recordAt(run.recordPath);
	const { plan } = run;
	const { config, lensTable, passTable, ...runOptions } = options;
	const prompts =
		plan.kind === "review"
			? (lensTable ?? loadLensTable())
			: (passTable ?? loadAuditPassTable());
	const rows = new Map(config.roster.map((row) => [row.id, row]));
	const settled = [...run.settled];
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
	const resume = { settled, lost };
	const seatBudgetMs = config.defaults.seatBudgetMs;
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
						...(plan.scopingNote === undefined
							? {}
							: { scopingNote: plan.scopingNote }),
						...(seatBudgetMs === undefined ? {} : { seatBudgetMs }),
						priorRecordPaths: discoverPriorRecords(run.repoDir).map(
							(entry) => entry.path,
						),
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
						...(plan.scopingNote === undefined
							? {}
							: { scopingNote: plan.scopingNote }),
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
	};
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
	const planPath = path.join(recordPath, PLAN_FILE);
	if (!isRealFile(planPath)) {
		refuse(
			`run "${runId}" has no resume plan; it was started before runs became resumable, or it is not a review or audit run`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(planPath, "utf8"));
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

function isRealFile(target: string): boolean {
	try {
		return lstatSync(target).isFile();
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
