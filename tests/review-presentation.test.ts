import { describe, expect, it } from "vitest";

import type { RunReviewResult } from "../src/run/run-review.js";
import type { RunVerifyResult } from "../src/run/run-verify.js";
import type { ReviewProgressEvent } from "../src/run/scheduler.js";
import type { Suggestion, SuggestionsUnavailable } from "../src/run/suggest.js";
import type { PlannedSeat, SeatOutcomeFacts } from "../src/run/types.js";
import type { SeatLifecycle } from "../src/seat/classify.js";
import {
	compactPanelRoster,
	formatSuggestion,
	MAX_PRESENTATION_BYTES,
	progressFromReviewEvent,
	progressFromVerifyEvent,
	renderAuditResult,
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

describe("seats line", () => {
	const terra: PlannedSeat = { ...seat };
	const glm: PlannedSeat = {
		...seat,
		rosterId: "glm",
		provider: "ollama",
		model: "glm-5.2",
	};
	const terraTests: PlannedSeat = { ...seat, lens: "tests" };

	function outcomesOf(
		seats: PlannedSeat[],
		failed: PlannedSeat[] = [],
	): RunReviewResult {
		return {
			recordPath: "/tmp/run-seats",
			outcomes: seats.map((planned) =>
				failed.includes(planned)
					? {
							seat: planned,
							outcome: {
								kind: "failed",
								class: "provider-error",
								reason: "quota",
							},
						}
					: { seat: planned, outcome: { kind: "voted", findings: [] } },
			),
		} as unknown as RunReviewResult;
	}

	it("groups the review panel by lens in planned order, failed seats included", () => {
		const panel = [terra, glm, terraTests];
		const text = renderReviewResult({
			recordPath: "/tmp/run-seats",
			panel,
			result: outcomesOf(panel, [glm]),
		});
		expect(text).toBe(
			[
				"# Review panel",
				"2/3 voted · 0 findings",
				"Seats: holistic (terra, glm), tests (terra)",
				"Lost: glm/holistic (provider-error)",
				"Record: `/tmp/run-seats`",
				"",
				"None submitted.",
			].join("\n"),
		);
	});

	it("puts the seats line under the audit summary, before areas and lost", () => {
		const security: PlannedSeat = { ...terra, lens: "security" };
		const glmSecurity: PlannedSeat = { ...glm, lens: "security" };
		const text = renderAuditResult({
			recordPath: "/tmp/audit-seats",
			panel: [security, glmSecurity],
			result: outcomesOf([security, glmSecurity], [glmSecurity]),
		});
		expect(text).toBe(
			[
				"# Repository audit",
				"1/2 voted · 0 findings",
				"Seats: security (terra, glm)",
				"Lost: glm/security (provider-error)",
				"Record: `/tmp/audit-seats`",
				"",
				"None submitted.",
			].join("\n"),
		);
	});

	it("lists the verify panel, failed seats included", () => {
		const verifier: PlannedSeat = { ...terra, lens: "fix-verification" };
		const glmVerifier: PlannedSeat = { ...glm, lens: "fix-verification" };
		const text = renderVerifyResult(
			{
				recordPath: "/tmp/verify-seats",
				priorRunId: "run-1",
				priorHeadOid: "a".repeat(40),
				headOid: "b".repeat(40),
				kept: [],
				outcomes: [
					{
						seat: verifier,
						outcome: {
							kind: "voted",
							result: { items: [], regressions: [] },
						},
					},
					{
						seat: glmVerifier,
						outcome: {
							kind: "failed",
							class: "provider-error",
							reason: "quota",
						},
					},
				],
			} as RunVerifyResult,
			[verifier, glmVerifier],
		);
		expect(text).toBe(
			[
				"# Review panel verify",
				"1/2 voted · no kept ids · no regressions",
				"Seats: fix-verification (terra, glm)",
				"Lost: glm/fix-verification",
				"Record: `/tmp/verify-seats`",
			].join("\n"),
		);
	});
});

describe("suggest block", () => {
	const security: Suggestion = {
		lens: "security",
		reason: "added line(s) touch auth/crypto/subprocess/deserialization",
		evidence: [
			{ file: "src/run/record-key.ts", line: 42 },
			{ file: "src/run/record-key.ts", line: 50 },
			{ file: "src/a.ts", line: 3 },
		],
	};
	const migrations: Suggestion = {
		lens: "migrations",
		reason: "changed file(s) match a migration/DDL path or extension",
		evidence: [{ file: "db/001.sql" }],
	};
	const tests: Suggestion = {
		lens: "tests",
		reason: "code changed",
		evidence: [{ file: "src/a.ts" }, { file: "src/b.ts" }],
	};

	function review(
		suggestions: Suggestion[] | SuggestionsUnavailable,
		panel: PlannedSeat[] = [seat],
	): string {
		return renderReviewResult({
			recordPath: "/tmp/run-suggest",
			panel,
			result: {
				recordPath: "/tmp/run-suggest",
				outcomes: panel.map((planned) => ({
					seat: planned,
					outcome: { kind: "voted", findings: [] },
				})),
			} as unknown as RunReviewResult,
			suggestions,
		});
	}

	it("gives each untaken lens its reason and first evidence, with a count of the rest", () => {
		expect(review([security, migrations]).split("\n").slice(-4)).toEqual([
			"",
			"Suggest:",
			"- security: added line(s) touch auth/crypto/subprocess/deserialization (`src/run/record-key.ts:42`, +2 more)",
			"- migrations: changed file(s) match a migration/DDL path or extension (`db/001.sql`)",
		]);
	});

	it("leaves out a lens that ran, which the seats line already shows", () => {
		const text = review([tests, security], [seat, { ...seat, lens: "tests" }]);
		expect(text).toContain("Seats: holistic (terra), tests (terra)");
		expect(text.split("\n").slice(-3)).toEqual([
			"",
			"Suggest:",
			"- security: added line(s) touch auth/crypto/subprocess/deserialization (`src/run/record-key.ts:42`, +2 more)",
		]);
		expect(text).not.toContain("- tests:");
	});

	it("says the suggestions are unavailable, with the cause, when the diff could not be read", () => {
		const text = review({ unavailable: "the diff is over 16 bytes" });
		expect(text.split("\n").slice(-3)).toEqual([
			"",
			"Suggest:",
			"- Suggestions unavailable: the diff could not be read (the diff is over 16 bytes).",
		]);
		expect(text).not.toContain("No suggestion rule matched");
	});

	it("has no block when every suggested lens ran", () => {
		const text = review([tests], [seat, { ...seat, lens: "tests" }]);
		expect(text).not.toContain("Suggest");
		expect(text.endsWith("None submitted.")).toBe(true);
	});

	it("formats one suggestion with no evidence, one, or several pieces", () => {
		expect(formatSuggestion({ ...migrations, evidence: [] })).toBe(
			"- migrations: changed file(s) match a migration/DDL path or extension",
		);
		expect(formatSuggestion(tests)).toBe(
			"- tests: code changed (`src/a.ts`, +1 more)",
		);
		expect(formatSuggestion(security, { evidence: 2 })).toBe(
			"- security: added line(s) touch auth/crypto/subprocess/deserialization (`src/run/record-key.ts:42`, `src/run/record-key.ts:50`, +1 more)",
		);
		expect(formatSuggestion(tests, { note: "already on, owner default" })).toBe(
			"- tests (already on, owner default): code changed (`src/a.ts`, +1 more)",
		);
	});

	it("shows a hostile file name as one inert code span: no escape, line break, bidi control or markdown", () => {
		const line = formatSuggestion({
			lens: "security",
			reason: "added line(s) touch auth/crypto/subprocess/deserialization",
			evidence: [
				{
					file: "evil\u001b[31mRED\u001b]52;c;eA==\u0007\r# Heading [x](http://e) `tick` \u202Eevil\u2066\u009b",
					line: 7,
				},
			],
		});
		expect(line).toBe(
			"- security: added line(s) touch auth/crypto/subprocess/deserialization (``evil\uFFFD[31mRED\uFFFD]52;c;eA==\uFFFD\uFFFD# Heading [x](http://e) `tick` \uFFFDevil\uFFFD\uFFFD:7``)",
		);
		expect(line).not.toMatch(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about control characters
			/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/,
		);
	});

	it.each([
		["a Unicode tag character", "\u{E0049}\u{E0047}"],
		["a zero-width space, joiner and non-joiner", "\u200B\u200C\u200D"],
		["a word joiner", "\u2060"],
		["a byte-order mark", "\uFEFF"],
		["a line separator", "\u2028"],
		["a paragraph separator", "\u2029"],
		["a C1 control", "\u0085"],
		["a Hangul filler", "\u3164"],
		["a variation selector", "\uFE0F"],
		["a combining grapheme joiner", "\u034F"],
	])("replaces %s in a file name", (_label, hidden) => {
		const line = formatSuggestion({
			lens: "security",
			reason: "r",
			evidence: [{ file: `src/a${hidden}b.ts`, line: 1 }],
		});
		expect(line).toBe(
			`- security: r (\`src/a${"\uFFFD".repeat([...hidden].length)}b.ts:1\`)`,
		);
		expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
	});

	it("cuts a long file name at 200 code points before the line number and the closing fence", () => {
		const long = "é".repeat(250);
		expect(
			formatSuggestion({
				lens: "security",
				reason: "r",
				evidence: [{ file: long, line: 3 }],
			}),
		).toBe(`- security: r (\`${"é".repeat(200)}…:3\`)`);
		expect(
			formatSuggestion({
				lens: "tests",
				reason: "r",
				evidence: [{ file: long }],
			}),
		).toBe(`- tests: r (\`${"é".repeat(200)}…\`)`);
	});

	it("strips control characters from a lens name and a reason", () => {
		expect(
			formatSuggestion({
				lens: "sec\u001burity",
				reason: "why\r# no\u202E",
				evidence: [],
			}),
		).toBe("- sec\uFFFDurity: why\uFFFD# no\uFFFD");
	});
});

describe("no reply implies a pass", () => {
	it("no reply carries the old merge line or pass wording", () => {
		const text = [
			renderReviewResult({
				recordPath: "/tmp/r",
				panel: [seat],
				result: {
					recordPath: "/tmp/r",
					outcomes: [{ seat, outcome: { kind: "voted", findings: [] } }],
				} as unknown as RunReviewResult,
			}),
			renderAuditResult({
				recordPath: "/tmp/a",
				panel: [seat],
				result: {
					recordPath: "/tmp/a",
					outcomes: [{ seat, outcome: { kind: "voted", findings: [] } }],
				} as unknown as RunReviewResult,
			}),
			renderVerifyResult({
				recordPath: "/tmp/v",
				priorRunId: "r",
				priorHeadOid: "a".repeat(40),
				headOid: "b".repeat(40),
				kept: [],
				outcomes: [],
			} as RunVerifyResult),
		].join("\n");
		expect(text).not.toContain("merge decision");
		expect(text).not.toMatch(/\b(ready|clean|approved|pass(ed)?)\b/i);
	});
});
