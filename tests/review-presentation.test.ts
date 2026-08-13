import { describe, expect, it } from "vitest";

import type { RunReviewResult } from "../src/run/run-review.js";
import type { RunVerifyResult } from "../src/run/run-verify.js";
import type { ReviewProgressEvent } from "../src/run/scheduler.js";
import type { PlannedSeat, SeatOutcomeFacts } from "../src/run/types.js";
import type { SeatLifecycle } from "../src/seat/classify.js";
import {
	compactPanelRoster,
	MAX_PRESENTATION_BYTES,
	progressFromReviewEvent,
	progressFromVerifyEvent,
	renderReadiness,
	renderReviewProgress,
	renderReviewResult,
	renderVerifyResult,
} from "../src/tool/review-presentation.js";

const seat: PlannedSeat = {
	rosterId: "terra",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "holistic",
	lensPrompt: "Review this change.",
};

describe("review progress presentation", () => {
	it("renders a one-line in-flight status without a verdict", () => {
		expect(
			renderReviewProgress({
				phase: "review",
				event: "started",
				elapsedMs: 250,
				total: 3,
				completed: 0,
				active: 0,
			}),
		).toBe("review started · 250ms · 3 seats");
		expect(
			renderReviewProgress({
				phase: "review",
				event: "heartbeat",
				elapsedMs: 16_000,
				seat: "terra/holistic",
				active: 2,
				completed: 1,
				total: 3,
				cost: 0.0123,
			}),
		).toBe(
			"review heartbeat · 16s · terra/holistic · 2 active, 1/3 done · $0.0123",
		);
		expect(
			renderReviewProgress({
				phase: "review",
				event: "heartbeat",
				elapsedMs: 165_000,
				seat: "deepseek/holistic",
				active: 1,
				completed: 6,
				total: 7,
				attempts: 2,
				tokens: 2_994_993,
				lastTool: "read",
				cost: 0,
			}),
		).toBe(
			"review heartbeat · 165s · deepseek/holistic · 1 active, 6/7 done · attempt 2 · 3.0M tok · read · $0",
		);
		expect(
			renderReviewProgress({
				phase: "review",
				event: "heartbeat",
				elapsedMs: 16_000,
				seat: "terra/security",
				active: 4,
				completed: 0,
				total: 7,
				roster: "holistic: terra, glm, deepseek · security: terra, glm",
			}),
		).toBe(
			"holistic: terra, glm, deepseek · security: terra, glm\nreview heartbeat · 16s · terra/security · 4 active, 0/7 done",
		);
		expect(
			renderReviewProgress({
				phase: "verify",
				event: "started",
				elapsedMs: 0,
				total: 2,
				roster: "fix-verification: terra, glm",
			}),
		).toBe("fix-verification: terra, glm\nverify started · 0ms · 2 seats");
		expect(
			renderReviewProgress({
				phase: "review",
				event: "finished",
				elapsedMs: 3_600,
				seat: "glm/holistic",
				active: 0,
				completed: 3,
				total: 3,
				cost: 0,
			}),
		).not.toMatch(/\bverdict\b/i);
	});

	it("maps scheduler and verify events onto the same view", () => {
		const started: ReviewProgressEvent = {
			kind: "seat-started",
			seat,
			activeSeats: 1,
			completedSeats: 0,
			totalSeats: 3,
		};
		expect(progressFromReviewEvent(started, 1_200)).toEqual({
			phase: "review",
			event: "started",
			elapsedMs: 1_200,
			seat: "terra/holistic",
			active: 1,
			completed: 0,
			total: 3,
		});
		expect(
			progressFromVerifyEvent(
				{
					kind: "seat-finished",
					seat: { ...seat, lens: "fix-verification" },
					completedSeats: 1,
					totalSeats: 2,
				},
				4_000,
			),
		).toEqual({
			phase: "verify",
			event: "finished",
			elapsedMs: 4_000,
			seat: "terra/fix-verification",
			active: 0,
			completed: 1,
			total: 2,
		});
	});
});

function lifecycle(input: {
	startedAtMs: number;
	settledAtMs: number;
	tokens: number;
	cost: number;
}): SeatLifecycle {
	return {
		startedAtMs: input.startedAtMs,
		settledAtMs: input.settledAtMs,
		durationMs: input.settledAtMs - input.startedAtMs,
		attempts: 1,
		aborted: false,
		tokens: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: input.tokens,
		},
		cost: input.cost,
	};
}

describe("review result presentation", () => {
	it("shows overlap-aware totals and finding evidence without a verdict", () => {
		const terra: PlannedSeat = { ...seat };
		const glm: PlannedSeat = {
			...seat,
			rosterId: "glm",
			provider: "ollama",
			model: "glm-5.2",
		};
		const text = renderReviewResult({
			recordPath: "/tmp/run-1",
			panel: [terra, glm],
			result: {
				recordPath: "/tmp/run-1",
				outcomes: [
					{
						seat: terra,
						lifecycle: lifecycle({
							startedAtMs: 1_000,
							settledAtMs: 56_000,
							tokens: 62_036,
							cost: 0.0657,
						}),
						outcome: { kind: "voted", findings: [] },
					},
					{
						seat: glm,
						lifecycle: lifecycle({
							startedAtMs: 1_200,
							settledAtMs: 217_456,
							tokens: 259_141,
							cost: 0,
						}),
						outcome: { kind: "voted", findings: [] },
					},
				],
			} as unknown as RunReviewResult,
			findings: [
				{
					id: "F-2",
					seat: {
						provider: "ollama",
						model: "glm-5.2",
						lens: "holistic",
					},
					finding: {
						file: "src/b.ts",
						line: 4,
						severity: "low",
						title: "nit",
						evidence: "style only",
					},
				},
				{
					id: "F-1",
					seat: {
						provider: "openai-codex",
						model: "gpt-5.6-terra",
						lens: "holistic",
					},
					finding: {
						file: "src/a.ts",
						line: 12,
						severity: "high",
						title: "auth bypass",
						evidence:
							"The new route skips the session check when the header is empty.",
					},
				},
			],
		});

		expect(text).toContain("2/2 voted · 2 findings · 3m 36s · $0.0657");
		expect(text).not.toContain("## Seats");
		expect(text).not.toContain("Specialist extras");
		expect(text.indexOf("F-1 [high]")).toBeLessThan(text.indexOf("F-2 [low]"));
		expect(text).toContain(
			"- F-1 [high] auth bypass (src/a.ts:12) — terra/holistic",
		);
		expect(text).toContain(
			"The new route skips the session check when the header is empty.",
		);
		expect(text).toContain("- F-2 [low] nit (src/b.ts:4) — glm/holistic");
		expect(text).not.toMatch(/\bverdict\b/i);
	});

	it("omits totals when seat lifecycle is missing", () => {
		const text = renderReviewResult({
			recordPath: "/tmp/run-2",
			panel: [seat],
			result: {
				recordPath: "/tmp/run-2",
				outcomes: [
					{
						seat,
						outcome: { kind: "voted", findings: [] },
					} as unknown as SeatOutcomeFacts,
				],
			} as unknown as RunReviewResult,
		});
		expect(text).not.toContain("$");
		expect(text).toContain("1/1 voted · 0 findings");
	});

	it("degrades oversized findings instead of throwing away the record path", () => {
		const text = renderReviewResult({
			recordPath: "/tmp/run-huge",
			panel: [seat],
			result: {
				recordPath: "/tmp/run-huge",
				outcomes: [
					{
						seat,
						outcome: { kind: "voted", findings: [] },
					} as unknown as SeatOutcomeFacts,
				],
			} as unknown as RunReviewResult,
			findings: Array.from({ length: 200 }, (_, index) => ({
				id: `F-${index}`,
				seat: {
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					lens: "holistic",
				},
				finding: {
					file: "src/a.ts",
					line: index + 1,
					severity: "low" as const,
					title: "x".repeat(200),
					evidence: "y".repeat(400),
				},
			})),
		});
		expect(text).toContain("Record: `/tmp/run-huge`");
		expect(text).toContain("omitted");
		expect(text).not.toMatch(/\bverdict\b/i);
	});

	it("omits extra readiness rows to stay under the public cap", () => {
		const text = renderReadiness({
			ready: false,
			rows: Array.from({ length: 80 }, (_, index) => ({
				prerequisite: `p-${index}-${"x".repeat(400)}`,
				remediation: `r-${index}-${"y".repeat(800)}`,
			})),
		});
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
			MAX_PRESENTATION_BYTES,
		);
		expect(text).toContain("omitted");
	});
});

describe("panel roster", () => {
	it("groups roster aliases by lens", () => {
		expect(
			compactPanelRoster([
				seat,
				{ ...seat, rosterId: "glm", provider: "ollama", model: "glm-5.2" },
				{ ...seat, lens: "subtle-correctness" },
			]),
		).toBe("holistic: terra, glm · subtle-correctness: terra");
	});
});

describe("verify result presentation", () => {
	it("includes disposition and regression evidence", () => {
		const text = renderVerifyResult({
			recordPath: "/tmp/verify-1",
			priorRunId: "run-1",
			priorHeadOid: "a".repeat(40),
			headOid: "b".repeat(40),
			kept: [],
			outcomes: [
				{
					seat: { ...seat, lens: "fix-verification" },
					outcome: {
						kind: "voted",
						result: {
							items: [
								{
									id: "F-1",
									disposition: "resolved",
									evidence: { file: "a.txt", explanation: "guard restored" },
								},
							],
							regressions: [
								{
									regressionId: "regression-1-1",
									file: "b.txt",
									line: 1,
									title: "new hole",
									evidence: "fix dropped the other check",
								},
							],
						},
					},
				},
			],
		} as RunVerifyResult);
		expect(text).toContain("1/1 voted · F-1 resolved · 1 regression");
		expect(text).toContain("new hole (b.txt:1)");
		expect(text).toContain("fix dropped the other check");
		expect(text).not.toMatch(/\bverdict\b/i);
	});
});
