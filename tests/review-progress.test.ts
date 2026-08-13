import { describe, expect, it } from "vitest";

import { scheduleSeats } from "../src/run/scheduler.js";

const seat = {
	rosterId: "terra",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "correctness",
	lensPrompt: "Review this change.",
};

describe("review progress", () => {
	it("emits seat progress before an injected SDK seat settles", async () => {
		const progress: Array<{
			kind: string;
			activeSeats: number;
			completedSeats: number;
			totalSeats: number;
			cost?: number;
		}> = [];
		let release: (() => void) | undefined;
		const pending = scheduleSeats(
			{
				seats: [seat],
				worktree: "/snapshot",
				baseRef: "base-oid",
			},
			{
				onProgress: (event) => progress.push(event),
				runSeat: async (spec) => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
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
							tokens: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
							cost: 0,
						},
						outcome: { kind: "findings", findings: [] },
					};
				},
			},
		);
		await Promise.resolve();
		expect(progress.map((event) => event.kind)).toContain("seat-started");
		expect(progress[0]).toMatchObject({
			kind: "seat-started",
			activeSeats: 1,
			completedSeats: 0,
			totalSeats: 1,
		});
		release?.();
		await pending;
		expect(progress.at(-1)).toMatchObject({
			kind: "seat-finished",
			activeSeats: 0,
			completedSeats: 1,
			totalSeats: 1,
			cost: 0,
		});
	});

	it("bounds first progress and heartbeats with a fake clock", async () => {
		let now = 0;
		const events: Array<{ kind: string; at: number }> = [];
		const intervals = new Map<
			number,
			{ callback: () => void; every: number; next: number }
		>();
		let intervalId = 0;
		const clock = {
			setTimeout: (_callback: () => void, _ms: number) =>
				0 as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: (_timer: ReturnType<typeof setTimeout>) => undefined,
			setInterval: (callback: () => void, every: number) => {
				intervalId += 1;
				intervals.set(intervalId, { callback, every, next: now + every });
				return intervalId as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: (timer: ReturnType<typeof setInterval>) => {
				intervals.delete(timer as unknown as number);
			},
		};
		const advance = (to: number): void => {
			for (const timer of intervals.values()) {
				while (timer.next <= to) {
					now = timer.next;
					timer.callback();
					timer.next += timer.every;
				}
			}
			now = to;
		};
		let release: (() => void) | undefined;
		const pending = scheduleSeats(
			{ seats: [seat], worktree: "/snapshot", baseRef: "base" },
			{
				clock,
				onProgress: (event) => events.push({ kind: event.kind, at: now }),
				runSeat: async (spec) => {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
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
							tokens: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
							cost: 0,
						},
						outcome: { kind: "findings", findings: [] },
					};
				},
			},
		);
		await Promise.resolve();
		expect(events[0]).toEqual({ kind: "seat-started", at: 0 });
		expect(events[0]?.at).toBeLessThanOrEqual(2_000);
		advance(30_000);
		const heartbeats = events.filter(
			(event) => event.kind === "seat-heartbeat",
		);
		expect(heartbeats).toEqual([
			{ kind: "seat-heartbeat", at: 15_000 },
			{ kind: "seat-heartbeat", at: 30_000 },
		]);
		for (let index = 1; index < heartbeats.length; index += 1) {
			const previous = heartbeats[index - 1];
			const current = heartbeats[index];
			if (previous === undefined || current === undefined) {
				throw new Error("missing heartbeat");
			}
			expect(current.at - previous.at).toBeLessThanOrEqual(15_000);
		}
		release?.();
		await pending;
	});

	it("copies live seat tokens, attempt, and last tool onto heartbeats", async () => {
		const heartbeats: Array<{
			tokens?: number;
			attempts?: 1 | 2;
			lastTool?: string;
		}> = [];
		const intervals: Array<() => void> = [];
		const clock = {
			setTimeout: (_callback: () => void, _ms: number) =>
				0 as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: (_timer: ReturnType<typeof setTimeout>) => undefined,
			setInterval: (callback: () => void, _every: number) => {
				intervals.push(callback);
				return intervals.length as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: (_timer: ReturnType<typeof setInterval>) => undefined,
		};
		let release: (() => void) | undefined;
		const pending = scheduleSeats(
			{ seats: [seat], worktree: "/snapshot", baseRef: "base" },
			{
				clock,
				onProgress: (event) => {
					if (event.kind === "seat-heartbeat") {
						heartbeats.push({
							...(event.tokens === undefined ? {} : { tokens: event.tokens }),
							...(event.attempts === undefined
								? {}
								: { attempts: event.attempts }),
							...(event.lastTool === undefined
								? {}
								: { lastTool: event.lastTool }),
						});
					}
				},
				runSeat: async (spec, options) => {
					if (options?.live !== undefined) {
						options.live.current = () => ({
							attempts: 2,
							tokens: 12_000,
							lastTool: "read",
						});
					}
					await new Promise<void>((resolve) => {
						release = resolve;
					});
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
							attempts: 2,
							aborted: false,
							tokens: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 12_000,
							},
							cost: 0,
						},
						outcome: { kind: "findings", findings: [] },
					};
				},
			},
		);
		await Promise.resolve();
		expect(intervals.length).toBeGreaterThan(0);
		intervals[0]?.();
		expect(heartbeats[0]).toEqual({
			attempts: 2,
			tokens: 12_000,
			lastTool: "read",
		});
		release?.();
		await pending;
	});
});
