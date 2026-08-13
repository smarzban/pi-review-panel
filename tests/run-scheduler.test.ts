import { describe, expect, it, vi } from "vitest";

import {
	createSeatConcurrencyGate,
	DEFAULT_SEAT_BUDGET_MS,
	type SchedulerClock,
	SEAT_CONCURRENCY_CAP,
	scheduleSeats,
} from "../src/run/scheduler.js";
import type { PlannedSeat } from "../src/run/types.js";
import type { RunSeatOptions, SeatRunResult } from "../src/seat/run-seat.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

function seat(lens: string, rosterId = `seat-${lens}`): PlannedSeat {
	return {
		rosterId,
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		lens,
		lensPrompt: `Review through ${lens}.`,
	};
}

function result(spec: SeatSpec): SeatRunResult {
	return {
		identity: {
			provider: spec.provider,
			model: spec.model,
			lens: spec.lens,
		},
		replay: spec,
		lifecycle: {
			startedAtMs: 0,
			settledAtMs: 1,
			durationMs: 1,
			attempts: 1,
			aborted: false,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		outcome: { kind: "findings", findings: [] },
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function passiveClock(timeouts: number[]): SchedulerClock {
	return {
		setTimeout: (_callback, ms) => {
			timeouts.push(ms);
			return 0 as ReturnType<typeof setTimeout>;
		},
		clearTimeout: () => undefined,
		setInterval: () => 0 as ReturnType<typeof setInterval>,
		clearInterval: () => undefined,
	};
}

describe("SDK scheduler", () => {
	it("owns the concurrency cap while injected seats overlap", async () => {
		let active = 0;
		let peak = 0;
		const seats = Array.from({ length: SEAT_CONCURRENCY_CAP + 1 }, (_, index) =>
			seat(`lens-${index}`),
		);

		await scheduleSeats(
			{ seats, worktree: "/snapshot", baseRef: "base" },
			{
				runSeat: async (spec) => {
					active += 1;
					peak = Math.max(peak, active);
					await delay(2);
					active -= 1;
					return result(spec);
				},
			},
		);

		expect(peak).toBe(SEAT_CONCURRENCY_CAP);
	});

	it("rejects duplicate exact provider/model/lens identities before starting a session", async () => {
		let calls = 0;
		await expect(
			scheduleSeats(
				{
					seats: [seat("security", "first"), seat("security", "second")],
					worktree: "/snapshot",
					baseRef: "base",
				},
				{
					runSeat: async (spec) => {
						calls += 1;
						return result(spec);
					},
				},
			),
		).rejects.toThrow("duplicate seat identity");
		expect(calls).toBe(0);
	});

	it("returns injected SDK outcomes in planned order rather than settlement order", async () => {
		const planned = [seat("first"), seat("second"), seat("third")];
		const outcomes = await scheduleSeats(
			{ seats: planned, worktree: "/snapshot", baseRef: "base" },
			{
				runSeat: async (spec) => {
					await delay({ first: 9, second: 1, third: 4 }[spec.lens] ?? 0);
					return result(spec);
				},
			},
		);

		expect(outcomes.map((entry) => entry.seat)).toEqual(planned);
		expect(outcomes.map((entry) => entry.replay.lens)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("threads the configured budget, abort signal, and SDK factory to each seat", async () => {
		const timeouts: number[] = [];
		const controller = new AbortController();
		const { factory } = createSdkSeatFake();
		let received: RunSeatOptions | undefined;

		await scheduleSeats(
			{ seats: [seat("security")], worktree: "/snapshot", baseRef: "base" },
			{
				seatBudgetMs: 321,
				runAbortSignal: controller.signal,
				sessionFactory: factory,
				clock: passiveClock(timeouts),
				runSeat: async (spec, options) => {
					received = options;
					return result(spec);
				},
			},
		);

		expect(timeouts).toEqual([321]);
		expect(received?.abortSignal?.aborted).toBe(false);
		expect(received?.sessionFactory).toBe(factory);
		expect(DEFAULT_SEAT_BUDGET_MS).toBe(20 * 60_000);
	});

	it("passes its monotonic deadline clock explicitly without consulting the wall clock", async () => {
		const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("scheduler must not consult Date.now");
		});
		try {
			let received: RunSeatOptions | undefined;
			const deadlineNow = () => 42;
			await scheduleSeats(
				{ seats: [seat("security")], worktree: "/snapshot", baseRef: "base" },
				{
					seatBudgetMs: 321,
					clock: passiveClock([]),
					now: deadlineNow,
					runSeat: async (spec, options) => {
						received = options;
						return result(spec);
					},
				},
			);
			expect(received?.deadlineMs).toBe(363);
			expect(received?.deadlineNow).toBe(deadlineNow);
		} finally {
			wallClock.mockRestore();
		}
	});

	it("aborts an injected seat from its deadline callback and clears the timer", async () => {
		let timeout: (() => void) | undefined;
		const cleared: unknown[] = [];
		const clock: SchedulerClock = {
			setTimeout: (callback) => {
				timeout = callback;
				return "budget" as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: (timer) => cleared.push(timer),
			setInterval: () => 0 as ReturnType<typeof setInterval>,
			clearInterval: () => undefined,
		};
		await scheduleSeats(
			{ seats: [seat("security")], worktree: "/snapshot", baseRef: "base" },
			{
				clock,
				runSeat: async (spec, options) => {
					expect(options?.abortSignal?.aborted).toBe(false);
					timeout?.();
					expect(options?.abortSignal?.aborted).toBe(true);
					return result(spec);
				},
			},
		);
		expect(cleared).toEqual(["budget"]);
	});

	it("aborts a seat when host cancellation races listener registration", async () => {
		let registrations = 0;
		let aborted = false;
		const runAbortSignal = {
			get aborted() {
				return aborted;
			},
			addEventListener: (_type: string, _listener: () => void) => {
				registrations += 1;
				if (registrations === 2) {
					// A host may become aborted immediately after listener wiring
					// without replaying the already-fired abort event.
					aborted = true;
				}
			},
			removeEventListener: () => undefined,
		} as unknown as AbortSignal;
		let received: RunSeatOptions | undefined;

		await expect(
			scheduleSeats(
				{ seats: [seat("security")], worktree: "/snapshot", baseRef: "base" },
				{
					runAbortSignal,
					concurrencyGate: { acquire: async () => () => undefined },
					runSeat: async (spec, options) => {
						received = options;
						return result(spec);
					},
				},
			),
		).rejects.toThrow("run cancelled");

		expect(received?.abortSignal?.aborted).toBe(true);
	});

	it("shares one scheduler-owned cap across concurrent role assignments", async () => {
		const gate = createSeatConcurrencyGate();
		let active = 0;
		let peak = 0;
		const runSeat = async (spec: SeatSpec): Promise<SeatRunResult> => {
			active += 1;
			peak = Math.max(peak, active);
			await delay(2);
			active -= 1;
			return result(spec);
		};

		await Promise.all([
			scheduleSeats(
				{
					seats: [seat("security-a"), seat("security-b"), seat("security-c")],
					worktree: "/snapshot",
					baseRef: "base",
				},
				{ concurrencyGate: gate, runSeat },
			),
			scheduleSeats(
				{
					seats: [seat("tests-a"), seat("tests-b"), seat("tests-c")],
					worktree: "/snapshot",
					baseRef: "base",
				},
				{ concurrencyGate: gate, runSeat },
			),
		]);

		expect(peak).toBe(SEAT_CONCURRENCY_CAP);
	});
});
