import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import { resumeRun } from "../src/run/resume.js";
import type { RunAuditResult } from "../src/run/run-audit.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type { PlannedSeat } from "../src/run/types.js";
import {
	createReviewPanelTool,
	type ReviewPanelDependencies,
} from "../src/tool/review-panel.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import { TEST_RECORD_KEY } from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

/**
 * What crosses from the Pi tool's `execute` into the plain actions and on to
 * the runners: the cancellation signal, and progress back out to `onUpdate`.
 */

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function withRepository(test: (repo: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "handoff-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "handoff@example.test"]);
	git(repo, ["config", "user.name", "Handoff Test"]);
	writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	writeFileSync(path.join(repo, "head.txt"), "head\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "head", "--quiet"]);
	return test(realpathSync(repo)).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

const config: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
	],
	defaults: { seats: ["terra", "claude"] },
};

function toolWith(overrides: ReviewPanelDependencies) {
	return createReviewPanelTool({
		env: {},
		home: "/tmp/handoff-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		...overrides,
	});
}

function votedResult(repo: string, seats: PlannedSeat[]) {
	return {
		recordPath: path.join(repo, ".review-panel", "runs", "run-x"),
		outcomes: seats.map((seat) => ({
			seat,
			outcome: { kind: "voted" as const, findings: [] },
		})),
	};
}

function rosterOf(seats: PlannedSeat[]): Config {
	return {
		roster: seats.map((seat) => ({
			id: seat.rosterId,
			provider: seat.provider,
			model: seat.model,
		})),
		defaults: { seats: [seats[0]?.rosterId as string] },
	};
}

describe("review_panel execute signal reaches the runner", () => {
	async function expectSignalHandedOff(
		args: Record<string, unknown>,
		deps: (
			capture: (signal: AbortSignal | undefined) => void,
		) => ReviewPanelDependencies,
		repo: string,
	): Promise<void> {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		let calls = 0;
		const tool = toolWith(
			deps((signal) => {
				calls += 1;
				seen = signal;
			}),
		);
		await tool.execute(
			"tool-call",
			{ repository: repo, ...args },
			controller.signal,
			undefined,
			{},
		);
		expect(calls).toBe(1);
		expect(seen).toBe(controller.signal);
		expect(seen?.aborted).toBe(false);
		controller.abort();
		expect(seen?.aborted).toBe(true);
	}

	it("review", async () => {
		await withRepository((repo) =>
			expectSignalHandedOff(
				{ action: "review", base: "HEAD~1", head: "HEAD" },
				(capture) => ({
					runReview: async (runConfig, options) => {
						capture(options?.abortSignal);
						return votedResult(
							repo,
							runConfig.seats,
						) as unknown as RunReviewResult;
					},
				}),
				repo,
			),
		);
	});

	it("audit", async () => {
		await withRepository((repo) =>
			expectSignalHandedOff(
				{ action: "audit", passes: ["security"] },
				(capture) => ({
					runAudit: async (input, options) => {
						capture(options?.abortSignal);
						return votedResult(repo, input.seats) as unknown as RunAuditResult;
					},
				}),
				repo,
			),
		);
	});

	it("verify", async () => {
		await withRepository((repo) =>
			expectSignalHandedOff(
				{
					action: "verify",
					priorRunId: "run-1",
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				(capture) => ({
					runVerify: async (_input, options) => {
						capture(options?.abortSignal);
						return {
							recordPath: path.join(repo, ".review-panel", "runs", "v-1"),
							priorRunId: "run-1",
							priorHeadOid: "a".repeat(40),
							headOid: "b".repeat(40),
							kept: [],
							outcomes: [],
						};
					},
				}),
				repo,
			),
		);
	});

	it("resume", async () => {
		await withRepository(async (repo) => {
			const seats = plannedSeats(["correctness", "security"]);
			const runId = await interruptedReviewRecord(repo, seats);
			const fake = createSdkSeatFake();
			await expectSignalHandedOff(
				{ action: "resume", priorRunId: runId },
				(capture) => ({
					loadConfig: () => rosterOf(seats),
					resumeRun: (run, options) => {
						capture(options?.abortSignal);
						return resumeRun(run, {
							...(options as NonNullable<typeof options>),
							sessionFactory: fake.factory,
						});
					},
				}),
				repo,
			);
		});
	});
});

describe("review_panel forwards seat progress to onUpdate", () => {
	it("audit", async () => {
		await withRepository(async (repo) => {
			const updates: string[] = [];
			const tool = toolWith({
				runAudit: async (input, options) => {
					options?.onProgress?.({
						kind: "seat-started",
						seat: input.seats[0] as PlannedSeat,
						activeSeats: 1,
						completedSeats: 0,
						totalSeats: input.seats.length,
					});
					return votedResult(repo, input.seats) as unknown as RunAuditResult;
				},
			});
			await tool.execute(
				"tool-call",
				{ action: "audit", repository: repo, passes: ["security"] },
				undefined,
				(update: { content: Array<{ text: string }> }) =>
					updates.push(update.content[0]?.text ?? ""),
				{},
			);
			expect(updates).toHaveLength(2);
			expect(updates[0]).toMatch(
				/^security: terra, claude\naudit started · \d+m?s · 2 seats$/,
			);
			expect(updates[1]).toMatch(
				/^security: terra, claude\naudit started · \d+m?s · terra\/security · 1 active, 0\/2 done$/,
			);
		});
	});

	it("resume", async () => {
		await withRepository(async (repo) => {
			const seats = plannedSeats(["correctness", "security"]);
			const runId = await interruptedReviewRecord(repo, seats);
			const fake = createSdkSeatFake();
			const updates: string[] = [];
			const tool = toolWith({
				loadConfig: () => rosterOf(seats),
				resumeRun: (run, options) =>
					resumeRun(run, {
						...(options as NonNullable<typeof options>),
						sessionFactory: fake.factory,
					}),
			});
			await tool.execute(
				"tool-call",
				{ action: "resume", repository: repo, priorRunId: runId },
				undefined,
				(update: { content: Array<{ text: string }> }) =>
					updates.push(update.content[0]?.text ?? ""),
				{},
			);
			const roster = "correctness: seat-0 · security: seat-1\n";
			expect(updates).toHaveLength(3);
			expect(updates[0]).toMatch(/^review started · \d+m?s · 1 seat$/m);
			expect(updates[1]).toMatch(
				/^review started · \d+m?s · seat-1\/security · 1 active, 0\/1 done$/m,
			);
			expect(updates[2]).toMatch(
				/^review finished · \d+m?s · seat-1\/security · 0 active, 1\/1 done/m,
			);
			for (const update of updates) {
				expect(update.startsWith(roster)).toBe(true);
			}
		});
	});
});
