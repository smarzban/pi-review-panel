// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { performance } from "node:perf_hooks";
import type { FindingsProfile } from "../seat/channel-profile.js";
import {
	runSeat as defaultRunSeat,
	type LiveSeatProbe,
	type RunSeatOptions,
	type SdkSessionFactory,
	type SeatRunResult,
} from "../seat/run-seat.js";
import type { SeatSpec } from "../seat/sdk-session.js";
import type { PlannedSeat, SeatOutcomeFacts } from "./types.js";

export const SEAT_CONCURRENCY_CAP = 4;
export const DEFAULT_SEAT_BUDGET_MS = 20 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Host cancellation stops the queue and aborts all active SDK sessions. */
export class RunCancelledError extends Error {
	readonly code = "RUN_CANCELLED" as const;
	constructor(
		message = "run cancelled",
		readonly outcomes: SeatOutcomeFacts[] = [],
	) {
		super(message);
		this.name = "RunCancelledError";
	}
}

export type ReviewProgressEvent = {
	kind: "seat-started" | "seat-heartbeat" | "seat-finished";
	seat: PlannedSeat;
	activeSeats: number;
	completedSeats: number;
	totalSeats: number;
	/** Available only after a seat settles successfully, or live on a heartbeat. */
	cost?: number;
	attempts?: 1 | 2;
	tokens?: number;
	lastTool?: string;
};

/** Scheduler time seam, so progress and cancellation bounds are testable. */
export type SchedulerClock = {
	setTimeout: (
		callback: () => void,
		ms: number,
	) => ReturnType<typeof setTimeout>;
	clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
	setInterval: (
		callback: () => void,
		ms: number,
	) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

/** A scheduler-owned admission gate, shareable across independent panels. */
export type SeatConcurrencyGate = {
	acquire: (signal?: AbortSignal) => Promise<() => void>;
};

type GateWaiter = {
	resolve: (release: () => void) => void;
	reject: (reason: Error) => void;
	signal: AbortSignal | undefined;
	onAbort: () => void;
};

/**
 * Creates the one admission gate that owns a group of concurrent review
 * panels. A panel still supplies the queue and outcome ordering, but it may
 * not exceed this gate's aggregate cap with another panel that shares it.
 */
export function createSeatConcurrencyGate(
	cap = SEAT_CONCURRENCY_CAP,
): SeatConcurrencyGate {
	if (!Number.isInteger(cap) || cap < 1) {
		throw new Error("seat concurrency cap must be a positive integer");
	}
	let active = 0;
	const pending: GateWaiter[] = [];

	const drain = (): void => {
		while (active < cap && pending.length > 0) {
			const waiter = pending.shift();
			if (waiter === undefined) {
				return;
			}
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("seat scheduling cancelled"));
				continue;
			}
			active += 1;
			let released = false;
			waiter.resolve(() => {
				if (released) {
					return;
				}
				released = true;
				active -= 1;
				drain();
			});
		}
	};

	return {
		acquire: (signal) =>
			new Promise<() => void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("seat scheduling cancelled"));
					return;
				}
				const waiter: GateWaiter = {
					resolve,
					reject,
					signal,
					onAbort: () => {
						const index = pending.indexOf(waiter);
						if (index >= 0) {
							pending.splice(index, 1);
							reject(new Error("seat scheduling cancelled"));
						}
					},
				};
				signal?.addEventListener("abort", waiter.onAbort, { once: true });
				pending.push(waiter);
				drain();
			}),
	};
}

const systemClock: SchedulerClock = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
};

/** Node's monotonic clock backs both scheduler budgets and seat deadlines. */
const monotonicNow = (): number => performance.now();

export type ScheduleOptions = {
	seatBudgetMs?: number;
	runAbortSignal?: AbortSignal;
	runSeat?: (
		spec: SeatSpec<FindingsProfile>,
		options?: RunSeatOptions,
	) => Promise<SeatRunResult>;
	sessionFactory?: SdkSessionFactory;
	/** Shared only when independent panels must obey one aggregate cap. */
	concurrencyGate?: SeatConcurrencyGate;
	onProgress?: (event: ReviewProgressEvent) => void;
	clock?: SchedulerClock;
	/** Monotonic time source shared with runSeat's hard deadline. */
	now?: () => number;
};

export type ScheduleInput = {
	seats: PlannedSeat[];
	worktree: string;
	/** Frozen base commit OID, never a symbolic ref. */
	baseRef: string;
	scopingNote?: string;
};

/**
 * Fans exact seat assignments through the only concurrency owner. A seat is
 * started synchronously before its asynchronous SDK work, then reports a
 * heartbeat at most every 15 seconds until it settles.
 */
export async function scheduleSeats(
	input: ScheduleInput,
	options: ScheduleOptions = {},
): Promise<SeatOutcomeFacts[]> {
	if (input.seats.length === 0) {
		throw new Error("run refused: at least one seat is required");
	}
	assertUniqueSeatIdentities(input.seats);
	if (options.runAbortSignal?.aborted) {
		throw new RunCancelledError("run cancelled before scheduling");
	}

	const clock = options.clock ?? systemClock;
	const results: Array<SeatRunResult | undefined> = new Array(
		input.seats.length,
	);
	const runSeat = options.runSeat ?? defaultRunSeat;
	const budgetMs = options.seatBudgetMs ?? DEFAULT_SEAT_BUDGET_MS;
	const now = options.now ?? monotonicNow;
	const concurrencyGate =
		options.concurrencyGate ?? createSeatConcurrencyGate();
	let nextIndex = 0;
	let activeSeats = 0;
	let completedSeats = 0;
	let cancelled = false;
	const onCancel = (): void => {
		cancelled = true;
	};
	options.runAbortSignal?.addEventListener("abort", onCancel, { once: true });

	const worker = async (): Promise<void> => {
		while (!cancelled && !options.runAbortSignal?.aborted) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= input.seats.length) {
				return;
			}
			const seat = input.seats[index];
			let release: (() => void) | undefined;
			try {
				release = await concurrencyGate.acquire(options.runAbortSignal);
				if (cancelled || options.runAbortSignal?.aborted) {
					return;
				}
				activeSeats += 1;
				const live: LiveSeatProbe = {};
				options.onProgress?.({
					kind: "seat-started",
					seat,
					activeSeats,
					completedSeats,
					totalSeats: input.seats.length,
				});
				const heartbeat = clock.setInterval(() => {
					const snap = live.current?.();
					options.onProgress?.({
						kind: "seat-heartbeat",
						seat,
						activeSeats,
						completedSeats,
						totalSeats: input.seats.length,
						...(snap === undefined
							? {}
							: {
									attempts: snap.attempts,
									...(snap.tokens === undefined ? {} : { tokens: snap.tokens }),
									...(snap.cost === undefined ? {} : { cost: snap.cost }),
									...(snap.lastTool === undefined
										? {}
										: { lastTool: snap.lastTool }),
								}),
					});
				}, HEARTBEAT_INTERVAL_MS);
				try {
					results[index] = await runSeatWithBudget(
						seatSpecFor(seat, input),
						budgetMs,
						runSeat,
						options.sessionFactory,
						options.runAbortSignal,
						clock,
						now,
						live,
					);
				} finally {
					clock.clearInterval(heartbeat);
					activeSeats -= 1;
					completedSeats += 1;
					options.onProgress?.({
						kind: "seat-finished",
						seat,
						activeSeats,
						completedSeats,
						totalSeats: input.seats.length,
						...(results[index] === undefined
							? {}
							: { cost: results[index].lifecycle.cost }),
					});
				}
			} catch (error) {
				if (cancelled || options.runAbortSignal?.aborted) {
					return;
				}
				throw error;
			} finally {
				release?.();
			}
		}
	};

	try {
		await Promise.all(
			Array.from(
				{ length: Math.min(SEAT_CONCURRENCY_CAP, input.seats.length) },
				worker,
			),
		);
	} finally {
		options.runAbortSignal?.removeEventListener("abort", onCancel);
	}
	if (cancelled || options.runAbortSignal?.aborted) {
		const outcomes = results.flatMap((result, index) =>
			result === undefined ? [] : [outcomeFactsFor(input.seats[index], result)],
		);
		throw new RunCancelledError("run cancelled", outcomes);
	}
	return results.map((result, index) => {
		if (result === undefined) {
			throw new Error(
				`internal: missing result for planned seat index ${index}`,
			);
		}
		return outcomeFactsFor(input.seats[index], result);
	});
}

async function runSeatWithBudget(
	spec: SeatSpec<FindingsProfile>,
	budgetMs: number,
	runSeat: NonNullable<ScheduleOptions["runSeat"]>,
	sessionFactory: SdkSessionFactory | undefined,
	runAbortSignal: AbortSignal | undefined,
	clock: SchedulerClock,
	now: () => number,
	live: LiveSeatProbe,
): Promise<SeatRunResult> {
	const deadlineMs = now() + budgetMs;
	const controller = new AbortController();
	const onRunAbort = (): void => controller.abort();
	runAbortSignal?.addEventListener("abort", onRunAbort, { once: true });
	if (runAbortSignal?.aborted) {
		onRunAbort();
	}
	const budget = clock.setTimeout(() => controller.abort(), budgetMs);
	try {
		return await runSeat(spec, {
			abortSignal: controller.signal,
			deadlineMs,
			deadlineNow: now,
			live,
			...(sessionFactory === undefined ? {} : { sessionFactory }),
		});
	} finally {
		clock.clearTimeout(budget);
		runAbortSignal?.removeEventListener("abort", onRunAbort);
	}
}

function seatSpecFor(
	seat: PlannedSeat,
	input: ScheduleInput,
): SeatSpec<FindingsProfile> {
	return {
		provider: seat.provider,
		model: seat.model,
		lens: seat.lens,
		lensPrompt: seat.lensPrompt,
		baseRef: input.baseRef,
		worktree: input.worktree,
		...(seat.extraExtensionPaths === undefined
			? {}
			: { extraExtensionPaths: [...seat.extraExtensionPaths] }),
		...(input.scopingNote === undefined
			? {}
			: { scopingNote: input.scopingNote }),
	};
}

function outcomeFactsFor(
	seat: PlannedSeat,
	result: SeatRunResult,
): SeatOutcomeFacts {
	return {
		seat: { ...seat },
		replay: result.replay,
		lifecycle: result.lifecycle,
		outcome:
			result.outcome.kind === "findings"
				? { kind: "voted", findings: result.outcome.findings }
				: {
						kind: "failed",
						class: result.outcome.class,
						reason: result.outcome.reason,
					},
	};
}

function assertUniqueSeatIdentities(seats: PlannedSeat[]): void {
	const seen = new Set<string>();
	for (const seat of seats) {
		const key = `${seat.provider}\0${seat.model}\0${seat.lens}`;
		if (seen.has(key)) {
			throw new Error(
				`duplicate seat identity: ${seat.provider}/${seat.model}/${seat.lens}`,
			);
		}
		seen.add(key);
	}
}
