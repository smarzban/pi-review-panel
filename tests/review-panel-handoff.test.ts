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

import type { ActionDependencies } from "../src/actions/actions.js";
import type { Config } from "../src/config/schema.js";
import { resumeRun } from "../src/run/resume.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type { PlannedSeat } from "../src/run/types.js";
import { renderReviewProgress } from "../src/tool/review-presentation.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import { createPanelCaller } from "./fixtures/panel-call.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/** A complete review record signed with the test key, as verify needs. */
function writeSignedReview(repo: string, runId: string): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId,
			baseRef: "main",
			baseOid: execFileSync("git", ["rev-parse", "HEAD~1"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
			headOid: execFileSync("git", ["rev-parse", "HEAD~1"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
		}),
	);
	writeFileSync(path.join(recordPath, "findings.json"), "[]");
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	signReviewRecord(recordPath);
}

import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

/**
 * What crosses from an argument object into the plain actions and on to the
 * runners: the cancellation signal, and progress back out to the caller.
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

function toolWith(overrides: ActionDependencies) {
	return createPanelCaller({
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

describe("the abort signal reaches the runner", () => {
	async function expectSignalHandedOff(
		args: Record<string, unknown>,
		deps: (
			capture: (signal: AbortSignal | undefined) => void,
		) => ActionDependencies,
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
			"call-1",
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

	it("verify", async () => {
		await withRepository((repo) => {
			writeSignedReview(repo, "run-1");
			return expectSignalHandedOff(
				{
					action: "verify",
					priorRunId: "run-1",
					head: "HEAD",
					keptFindingIds: [],
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
			);
		});
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

describe("seat progress reaches the caller, rendered as the CLI prints it", () => {
	it("review", async () => {
		await withRepository(async (repo) => {
			const updates: string[] = [];
			const tool = toolWith({
				runReview: async (runConfig, options) => {
					options?.onProgress?.({
						kind: "seat-started",
						seat: runConfig.seats[0] as PlannedSeat,
						activeSeats: 1,
						completedSeats: 0,
						totalSeats: runConfig.seats.length,
					});
					return votedResult(
						repo,
						runConfig.seats,
					) as unknown as RunReviewResult;
				},
			});
			await tool.execute(
				"call-1",
				{ action: "review", repository: repo, base: "HEAD~1", head: "HEAD" },
				undefined,
				(view) => updates.push(renderReviewProgress(view)),
				{},
			);
			expect(updates).toHaveLength(2);
			expect(updates[0]).toMatch(
				/^holistic: terra, claude\nreview started · \d+m?s · 2 seats$/,
			);
			expect(updates[1]).toMatch(
				/^holistic: terra, claude\nreview started · \d+m?s · terra\/holistic · 1 active, 0\/2 done$/,
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
				"call-1",
				{ action: "resume", repository: repo, priorRunId: runId },
				undefined,
				(view) => updates.push(renderReviewProgress(view)),
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
