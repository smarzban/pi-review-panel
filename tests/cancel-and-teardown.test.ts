import { describe, expect, it } from "vitest";

import {
	RunCancelledError,
	SEAT_CONCURRENCY_CAP,
	scheduleSeats,
} from "../src/run/scheduler.js";
import type { PlannedSeat } from "../src/run/types.js";

function seat(lens: string): PlannedSeat {
	return {
		rosterId: `roster-${lens}`,
		provider: "openai-codex",
		model: "gpt-5.6-terra",
		lens,
		lensPrompt: `lens ${lens}`,
	};
}

describe("SDK cancellation", () => {
	it("aborts active SDK sessions, preserves their settled facts, and never starts queued seats", async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const aborted: string[] = [];
		const seats = ["a", "b", "c", "d", "e"].map(seat);
		const pending = scheduleSeats(
			{ seats, worktree: "/snapshot", baseRef: "base" },
			{
				runAbortSignal: controller.signal,
				runSeat: async (spec, options) => {
					started.push(spec.lens);
					await new Promise<void>((resolve) => {
						options?.abortSignal?.addEventListener(
							"abort",
							() => {
								aborted.push(spec.lens);
								resolve();
							},
							{ once: true },
						);
					});
					return {
						identity: {
							provider: spec.provider,
							model: spec.model,
							lens: spec.lens,
						},
						replay: spec,
						lifecycle: {
							startedAtMs: 1,
							settledAtMs: 2,
							durationMs: 1,
							attempts: 1,
							aborted: true,
							tokens: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
							cost: 0,
						},
						outcome: {
							kind: "failure",
							class: "killed",
							reason: "seat SDK session was aborted",
						},
					};
				},
			},
		);

		while (started.length < SEAT_CONCURRENCY_CAP) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		controller.abort();
		const error = await pending.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(RunCancelledError);
		expect(started).toHaveLength(SEAT_CONCURRENCY_CAP);
		expect(aborted).toEqual(started);
		if (error instanceof RunCancelledError) {
			expect(error.outcomes).toHaveLength(SEAT_CONCURRENCY_CAP);
			expect(error.outcomes.every((outcome) => outcome.lifecycle.aborted)).toBe(
				true,
			);
		}
	});
});
