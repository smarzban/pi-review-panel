// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { performance } from "node:perf_hooks";
// @ts-expect-error The initial scaffold has no Node type declarations.
import process from "node:process";
import { describe, expect, it } from "vitest";

import {
	type AuditProfile,
	SEAT_PROFILES,
	type VerificationProfile,
} from "../src/seat/channel-profile.js";
import {
	type LiveSeatProbe,
	runAdvisorySeat,
	runSeat,
} from "../src/seat/run-seat.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import { createSdkSeatFake, SDK_FINDING } from "./fixtures/sdk-seat-fake.js";

const spec = {
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "security",
	lensPrompt: "Review the change.",
	baseRef: "base",
	worktree: "/snapshot",
};

const auditSpec: SeatSpec<AuditProfile> = {
	...spec,
	profile: SEAT_PROFILES.audit,
	expectedIds: ["run-1/finding-1"],
};

const verificationSpec: SeatSpec<VerificationProfile> = {
	...spec,
	profile: SEAT_PROFILES.verification,
	expectedIds: ["run-1/finding-1"],
	cycle: 1,
};

type SubmissionTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
};

function submissionTool(tools: unknown[]): SubmissionTool {
	const tool = tools.find(
		(value): value is SubmissionTool =>
			typeof value === "object" &&
			value !== null &&
			"name" in value &&
			"execute" in value &&
			typeof value.name === "string" &&
			value.name.startsWith("submit_") &&
			typeof value.execute === "function",
	);
	if (tool === undefined) {
		throw new Error("expected the role submission tool");
	}
	return tool;
}

async function submit(tool: SubmissionTool, args: Record<string, unknown>) {
	return tool.execute(
		"sdk-seat-test",
		args,
		new AbortController().signal,
		() => undefined,
		{},
	);
}

function successfulSession(onPrompt: (tools: unknown[]) => Promise<void>) {
	return {
		session: {
			prompt: async () => onPrompt([]),
			abort: async () => undefined,
			dispose: () => undefined,
			getSessionStats: () => ({
				tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
				cost: 0.01,
			}),
		},
	};
}

describe("SDK findings seat", () => {
	it("submits findings through its real closure, then disposes its isolated session", async () => {
		const fake = createSdkSeatFake([{ kind: "findings" }]);
		const result = await runSeat(spec, { sessionFactory: fake.factory });

		expect(result.outcome).toMatchObject({
			kind: "findings",
			findings: [SDK_FINDING],
		});
		expect(result.lifecycle.tokens.total).toBe(26);
		expect(fake.runs).toHaveLength(1);
		expect(fake.runs[0]).toMatchObject({ disposed: true });
		expect(fake.runs[0].input.tools.map((tool) => tool.name)).toEqual([
			"git_diff",
			"submit_findings",
		]);
	});

	it("rejects malformed findings without publishing them, then accepts a valid submission", async () => {
		const result = await runSeat(spec, {
			sessionFactory: async (input) => {
				const tool = submissionTool(input.tools);
				let promptCount = 0;
				return successfulSession(async () => {
					promptCount += 1;
					if (promptCount !== 1) return;
					await expect(
						submit(tool, {
							findings: [{ file: "src/a.ts", line: 0 }],
						}),
					).rejects.toThrow();
					await submit(tool, { findings: [SDK_FINDING] });
				});
			},
		});

		expect(result.outcome).toMatchObject({
			kind: "findings",
			findings: [SDK_FINDING],
		});
	});

	it("exposes live tokens, attempt, and last tool while the session is open", async () => {
		const live: LiveSeatProbe = {};
		let seen: ReturnType<NonNullable<LiveSeatProbe["current"]>> | undefined;
		await runSeat(spec, {
			live,
			sessionFactory: async (input) => {
				input.confinementGuard({
					toolName: "read",
					input: { path: "/snapshot/a.ts" },
				});
				let prompts = 0;
				return successfulSession(async () => {
					prompts += 1;
					if (prompts === 1) {
						seen = live.current?.();
					}
				});
			},
		});
		expect(seen).toMatchObject({
			attempts: 1,
			tokens: 3,
			lastTool: "read",
		});
	});
});

describe("SDK deadline and teardown", () => {
	it("uses monotonic time for its deadline while persisting wall-clock timestamps", async () => {
		const calls: string[] = [];
		const monotonicTimes = [0, 0, 10, 10];
		const wallTimes = [1_000_000, 10];
		const result = await runSeat(spec, {
			deadlineNow: () => monotonicTimes.shift() ?? 10,
			wallNow: () => wallTimes.shift() ?? 10,
			deadlineMs: 10,
			sessionFactory: async () => ({
				session: {
					prompt: async () => {
						calls.push("prompt");
					},
					abort: async () => {
						calls.push("abort");
					},
					dispose: () => calls.push("dispose"),
					getSessionStats: () => ({
						tokens: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
						cost: 0,
					}),
				},
			}),
		});
		expect(calls).toEqual(["prompt", "abort", "dispose"]);
		expect(result.lifecycle).toMatchObject({
			startedAtMs: 1_000_000,
			settledAtMs: 10,
			durationMs: 10,
			aborted: true,
			attempts: 1,
		});
	});

	it("settles killed within the construction deadline when the session factory never resolves", async () => {
		const started = Date.now();
		const result = await runSeat(spec, {
			deadlineMs: performance.now() + 25,
			sessionFactory: async () => await new Promise<never>(() => undefined),
		});
		expect(Date.now() - started).toBeLessThan(250);
		expect(result.outcome).toMatchObject({ kind: "failure", class: "killed" });
		expect(result.lifecycle.aborted).toBe(true);
	});

	it("cleans a synchronously cancelled resolving factory session exactly once", async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		const lateSession = {
			session: {
				prompt: async () => {
					calls.push("prompt");
				},
				abort: async () => {
					calls.push("abort");
				},
				dispose: () => {
					calls.push("dispose");
				},
				getSessionStats: () => ({
					tokens: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					cost: 0,
				}),
			},
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await runSeat(spec, {
				abortSignal: controller.signal,
				sessionFactory: () => {
					const resolving = Promise.resolve(lateSession);
					return new Proxy(resolving, {
						get(target, property, receiver) {
							if (property !== "then")
								return Reflect.get(target, property, receiver);
							return (onfulfilled: (value: typeof lateSession) => unknown) =>
								target.then((value) => {
									const result = onfulfilled(value);
									controller.abort();
									return result;
								});
						},
					});
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(calls).toEqual(["abort", "dispose"]);
			expect(result.outcome).toMatchObject({
				kind: "failure",
				class: "killed",
			});
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("aborts then disposes a factory session that resolves after the deadline without prompting it", async () => {
		let resolveFactory:
			| ((value: ReturnType<typeof successfulSession>) => void)
			| undefined;
		const calls: string[] = [];
		const result = await runSeat(spec, {
			deadlineMs: performance.now() + 25,
			sessionFactory: () =>
				new Promise((resolve) => {
					resolveFactory = resolve;
				}),
		});
		expect(result.outcome).toMatchObject({ kind: "failure", class: "killed" });
		resolveFactory?.({
			session: {
				prompt: async () => {
					calls.push("prompt");
				},
				abort: async () => {
					calls.push("abort");
				},
				dispose: () => {
					calls.push("dispose");
				},
				getSessionStats: () => ({
					tokens: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
					cost: 0,
				}),
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["abort", "dispose"]);
	});

	it("observes a factory rejection that arrives after cancellation", async () => {
		let rejectFactory: ((reason?: unknown) => void) | undefined;
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await runSeat(spec, {
				deadlineMs: performance.now() + 25,
				sessionFactory: () =>
					new Promise((_resolve, reject) => {
						rejectFactory = reject;
					}),
			});
			expect(result.outcome).toMatchObject({
				kind: "failure",
				class: "killed",
			});
			rejectFactory?.(new Error("late factory rejection"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("SDK advisory seats", () => {
	it("submits a complete audit through the audit role tool", async () => {
		const fake = createSdkSeatFake([{ kind: "audit", holds: false }]);
		const result = await runAdvisorySeat(auditSpec, {
			sessionFactory: fake.factory,
		});

		expect(result.outcome).toMatchObject({
			kind: "audit",
			rows: [
				{
					id: "run-1/finding-1",
					holds: false,
					rationale: "verified against the code",
				},
			],
		});
		expect(fake.runs[0].input.tools.map((tool) => tool.name)).toEqual([
			"git_diff",
			"submit_audit",
		]);
	});

	it("submits a complete verification through the verification role tool", async () => {
		const fake = createSdkSeatFake([{ kind: "verification" }]);
		const result = await runAdvisorySeat(verificationSpec, {
			sessionFactory: fake.factory,
		});

		expect(result.outcome).toMatchObject({
			kind: "verification",
			result: {
				items: [
					{
						id: "run-1/finding-1",
						disposition: "resolved",
					},
				],
				regressions: [],
			},
		});
		expect(fake.runs[0].input.tools.map((tool) => tool.name)).toEqual([
			"git_diff",
			"submit_verification",
		]);
	});

	it("does not publish invalid audit or verification rows", async () => {
		const invalidAudit = await runAdvisorySeat(auditSpec, {
			sessionFactory: async (input) => {
				const tool = submissionTool(input.tools);
				return successfulSession(async () => {
					await expect(submit(tool, { rows: [] })).rejects.toThrow();
					await submit(tool, {
						rows: [
							{
								id: "run-1/finding-1",
								holds: true,
								rationale: "checked",
							},
						],
					});
				});
			},
		});
		const invalidVerification = await runAdvisorySeat(verificationSpec, {
			sessionFactory: async (input) => {
				const tool = submissionTool(input.tools);
				return successfulSession(async () => {
					await expect(
						submit(tool, {
							items: [
								{
									id: "run-1/finding-1",
									disposition: "resolved",
								},
							],
						}),
					).rejects.toThrow();
					await submit(tool, {
						items: [
							{
								id: "run-1/finding-1",
								disposition: "resolved",
								evidence: { file: "src/a.ts", explanation: "checked" },
							},
						],
						regressions: [],
					});
				});
			},
		});

		expect(invalidAudit.outcome).toMatchObject({
			kind: "audit",
			rows: [{ id: "run-1/finding-1", holds: true }],
		});
		expect(invalidVerification.outcome).toMatchObject({
			kind: "verification",
			result: {
				items: [{ id: "run-1/finding-1", disposition: "resolved" }],
			},
		});
	});
});
