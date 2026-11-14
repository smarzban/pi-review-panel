import { describe, expect, it } from "vitest";

import { renderReport } from "../src/run/render.js";
import { renderAuditReport } from "../src/run/render-audit.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import {
	buildVerifyFindingData,
	type RunVerifyResult,
} from "../src/run/run-verify.js";
import type { PlannedSeat, StampedFinding } from "../src/run/types.js";
import {
	renderAuditResult,
	renderReviewResult,
	renderVerifyResult,
} from "../src/tool/review-presentation.js";

// Seat-authored text with a right-to-left override, a zero-width space, a
// Unicode tag character, a byte-order mark and line breaks that would start a
// new Markdown heading in report.md.
const RLO = "‮";
const ZWSP = "​";
const TAG = "\u{E0041}";
const BOM = "﻿";
const R = "�";

const seat: PlannedSeat = {
	rosterId: "terra",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "holistic",
	lensPrompt: "Review this change.",
};

const hostile: StampedFinding = {
	id: "F-1",
	seat: { provider: seat.provider, model: seat.model, lens: seat.lens },
	finding: {
		file: `src/a${ZWSP}.ts`,
		line: 3,
		severity: "high",
		title: `admin${RLO}txt.exe`,
		evidence: `first${TAG} line\n\n### F-9 [high] planted\n${BOM}tail`,
	},
};

const voted = {
	seat,
	replay: {
		provider: seat.provider,
		model: seat.model,
		lens: seat.lens,
		lensPrompt: seat.lensPrompt,
		baseRef: "a".repeat(40),
		worktree: "/snapshot",
	},
	lifecycle: {
		startedAtMs: 1,
		settledAtMs: 2,
		durationMs: 1,
		attempts: 1 as const,
		aborted: false,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	},
	outcome: { kind: "voted" as const, findings: [hostile.finding] },
};

const cleanTitle = `admin${R}txt.exe`;
const cleanFile = `src/a${R}.ts`;
const cleanEvidence = `first${R} line ### F-9 [high] planted ${R}tail`;

describe("seat-authored finding text is cleaned", () => {
	it("in the review reply: one row and one evidence line, no invisible character", () => {
		const text = renderReviewResult({
			recordPath: "/tmp/run-1",
			panel: [seat],
			result: {
				recordPath: "/tmp/run-1",
				outcomes: [voted],
			} as unknown as RunReviewResult,
			findings: [hostile],
		});
		expect(text).toContain(
			`- F-1 [high] ${cleanTitle} (${cleanFile}:3) — terra/holistic\n  ${cleanEvidence}`,
		);
		expect(text).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});

	it("in the audit reply's Areas line", () => {
		const planted: StampedFinding = {
			...hostile,
			finding: { ...hostile.finding, file: `bad${RLO}\n# planted/a.ts` },
		};
		const text = renderAuditResult({
			recordPath: "/tmp/audit-2",
			panel: [seat],
			result: {
				recordPath: "/tmp/audit-2",
				outcomes: [
					{ ...voted, outcome: { kind: "voted", findings: [planted.finding] } },
				],
			} as never,
		});
		expect(text).toContain(`Areas: bad${R} # planted\n`);
		expect(text).not.toMatch(/^# planted/m);
		expect(text).not.toMatch(/[\u202E\u200B\uFEFF]|\u{E0041}/u);
	});

	it("in the audit reply", () => {
		const text = renderAuditResult({
			recordPath: "/tmp/audit-1",
			panel: [seat],
			result: { recordPath: "/tmp/audit-1", outcomes: [voted] } as never,
		});
		expect(text).toContain(`- [high] ${cleanTitle} (${cleanFile}:3)`);
		expect(text).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});

	it("in the verify reply's regressions", () => {
		const verifier: PlannedSeat = { ...seat, lens: "fix-verification" };
		const text = renderVerifyResult(
			{
				recordPath: "/tmp/verify-1",
				priorRunId: "run-1",
				priorHeadOid: "a".repeat(40),
				headOid: "b".repeat(40),
				kept: [],
				outcomes: [
					{
						seat: verifier,
						outcome: {
							kind: "voted",
							result: {
								items: [],
								regressions: [
									{
										regressionId: "R-1",
										title: hostile.finding.title,
										file: hostile.finding.file,
										line: 3,
										severity: "high",
										evidence: hostile.finding.evidence,
									},
								],
							},
						},
					},
				],
			} as unknown as RunVerifyResult,
			[verifier],
		);
		expect(text).toContain(
			`- regression R-1: ${cleanTitle} (${cleanFile}:3)\n  ${cleanEvidence}`,
		);
		expect(text).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});

	it("in report.md: no planted heading, no invisible character", () => {
		const report = renderReport({
			meta: {
				runId: "run-1",
				baseRef: "main",
				baseOid: "a".repeat(40),
				headOid: "b".repeat(40),
			},
			stamped: [hostile],
			outcomes: [voted],
		});
		expect(report).toContain(`### F-1 [high] ${cleanTitle}\n`);
		expect(report).toContain(`- Location: ${cleanFile}:3\n`);
		expect(report).toContain(`- Evidence: ${cleanEvidence}\n`);
		expect(report).not.toMatch(/^#+ F-9/m);
		expect(report).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});

	it("in report.md's prior discard reason", () => {
		const report = renderReport({
			meta: {
				runId: "run-2",
				baseRef: "main",
				baseOid: "a".repeat(40),
				headOid: "b".repeat(40),
			},
			stamped: [hostile],
			outcomes: [voted],
			annotations: {
				flags: [
					{
						findingId: "F-1",
						reason: `not real${ZWSP}\n\n### F-9 [high] planted`,
					},
				],
				notices: [],
			},
		});
		expect(report).toContain(
			`- Prior discard reason: not real${R} ### F-9 [high] planted\n`,
		);
		expect(report).not.toMatch(/^#+ F-9/m);
		expect(report).not.toMatch(/[\u202E\u200B\uFEFF]|\u{E0041}/u);
	});

	it("in the audit report.md", () => {
		const report = renderAuditReport({
			runId: "audit-1",
			snapshotOid: "a".repeat(40),
			stamped: [hostile],
			outcomes: [voted],
		});
		expect(report).toContain(`### F-1 [high] ${cleanTitle}\n`);
		expect(report).toContain(`- Location: ${cleanFile}:3\n`);
		expect(report).toContain(`- Evidence: ${cleanEvidence}\n`);
		expect(report).not.toMatch(/^#+ F-9/m);
		expect(report).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});

	it("cuts long text by code point, never inside a surrogate pair", () => {
		const emoji = "\u{1F600}";
		const long: StampedFinding = {
			...hostile,
			finding: {
				...hostile.finding,
				title: `${"t".repeat(199)}${emoji}x`,
				evidence: `${"e".repeat(279)}${emoji}x`,
			},
		};
		const data = buildVerifyFindingData([long]);
		expect(data).toContain(`${"t".repeat(199)}${emoji} (`);
		expect(data).toContain(`${"e".repeat(279)}${emoji}`);
		expect(data).not.toContain(`${emoji}x`);
		const reply = renderReviewResult({
			recordPath: "/tmp/run-3",
			panel: [seat],
			result: {
				recordPath: "/tmp/run-3",
				outcomes: [voted],
			} as unknown as RunReviewResult,
			findings: [long],
		});
		expect(reply).toContain(`  ${"e".repeat(279)}${emoji}…`);
		expect(reply).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it("in the kept-finding data handed to verify seats", () => {
		const data = buildVerifyFindingData([hostile]);
		expect(data).toContain(
			`- F-1 [high] ${cleanTitle} (${cleanFile}:3) ${cleanEvidence}`,
		);
		expect(data).not.toMatch(/[‮​﻿]|\u{E0041}/u);
	});
});
