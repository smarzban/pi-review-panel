import { describe, expect, it } from "vitest";

import { SEAT_PROFILES } from "../src/seat/channel-profile.js";
import { runAdvisorySeat, runSeat } from "../src/seat/run-seat.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";

const spec = {
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "tests",
	lensPrompt: "Review.",
	baseRef: "base",
	worktree: "/snapshot",
};

const auditSpec: SeatSpec<typeof SEAT_PROFILES.audit> = {
	...spec,
	profile: SEAT_PROFILES.audit,
	expectedIds: ["run-1/finding-1"],
};

function silentSession() {
	return {
		prompt: async () => undefined,
		abort: async () => undefined,
		dispose: () => undefined,
		getSessionStats: () => ({
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		}),
	};
}

describe("SDK seat failures", () => {
	it("does not create a session when its signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let creations = 0;

		const result = await runSeat(spec, {
			abortSignal: controller.signal,
			sessionFactory: async () => {
				creations += 1;
				return { session: silentSession() };
			},
		});

		expect(creations).toBe(0);
		expect(result.outcome).toMatchObject({ kind: "failure", class: "killed" });
		expect(result.lifecycle).toMatchObject({ attempts: 1, aborted: true });
	});

	it("retries one silent seat then attributes lost coverage", async () => {
		let prompts = 0;
		const result = await runSeat(spec, {
			sessionFactory: async () => ({
				session: {
					...silentSession(),
					prompt: async () => {
						prompts += 1;
					},
				},
			}),
		});
		expect(prompts).toBe(2);
		expect(result.outcome).toMatchObject({
			kind: "failure",
			class: "no-submit",
		});
		expect(result.lifecycle.attempts).toBe(2);
	});

	it("propagates advisory cancellation into an active audit SDK session", async () => {
		const controller = new AbortController();
		let aborted = false;
		let disposed = false;
		const result = await runAdvisorySeat(auditSpec, {
			abortSignal: controller.signal,
			sessionFactory: async () => ({
				session: {
					...silentSession(),
					prompt: async () => {
						controller.abort();
					},
					abort: async () => {
						aborted = true;
					},
					dispose: () => {
						disposed = true;
					},
				},
			}),
		});

		expect(aborted).toBe(true);
		expect(disposed).toBe(true);
		expect(result.outcome).toMatchObject({ kind: "failure", class: "killed" });
		expect(result.lifecycle.aborted).toBe(true);
	});

	it("keeps a submitted result when stats and disposal reporting fail", async () => {
		let submitted = false;
		const result = await runSeat(spec, {
			sessionFactory: async (input) => ({
				session: {
					prompt: async () => {
						const tool = input.tools.find(
							(item) => item.name === "submit_findings",
						) as unknown as {
							execute: (...args: unknown[]) => Promise<unknown>;
						};
						await tool.execute(
							"sdk-seat-test",
							{
								findings: [
									{
										file: "src/a.ts",
										line: 1,
										severity: "low",
										title: "Title",
										evidence: "Evidence",
									},
								],
							},
							new AbortController().signal,
							() => undefined,
							{},
						);
						submitted = true;
					},
					abort: async () => undefined,
					dispose: () => {
						throw new Error("dispose failed");
					},
					getSessionStats: () => {
						throw new Error("stats failed");
					},
				},
			}),
		});

		expect(submitted).toBe(true);
		expect(result.outcome).toMatchObject({ kind: "findings" });
		expect(result.lifecycle).toMatchObject({
			tokens: { total: 0 },
			cost: 0,
		});
	});
});
