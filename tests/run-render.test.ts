import { describe, expect, it } from "vitest";

import { collectFindings } from "../src/run/collect.js";
import {
	type RunAnnotations,
	type RunMeta,
	renderFindingsJson,
	renderReport,
} from "../src/run/render.js";
import type { PlannedSeat, SeatOutcomeFacts } from "../src/run/types.js";
import type { Finding } from "../src/seat/schema.js";

const meta: RunMeta = {
	runId: "2026-08-04T12-00-00-000Z-feat-review-run-0123456789abcdef",
	baseRef: "feat/review-run",
	baseOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	headOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const correctnessSeat: PlannedSeat = {
	rosterId: "roster-correctness",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "correctness",
	lensPrompt: "You review through a correctness lens.",
};
const securitySeat: PlannedSeat = {
	rosterId: "roster-security",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "security",
	lensPrompt: "You review through a security lens.",
};
const testsSeat: PlannedSeat = {
	rosterId: "roster-tests",
	provider: "anthropic",
	model: "claude-opus-7",
	lens: "tests",
	lensPrompt: "You review through a tests lens.",
};
const perfSeat: PlannedSeat = {
	rosterId: "roster-perf",
	provider: "anthropic",
	model: "claude-opus-7",
	lens: "perf",
	lensPrompt: "You review through a perf lens.",
};
const docsSeat: PlannedSeat = {
	rosterId: "roster-docs",
	provider: "google-gemini",
	model: "gemini-3-pro",
	lens: "docs",
	lensPrompt: "You review through a docs lens.",
};

const correctnessLabel = "openai-codex/gpt-5.6-terra (correctness)";
const securityLabel = "openai-codex/gpt-5.6-terra (security)";
const testsLabel = "anthropic/claude-opus-7 (tests)";
const perfLabel = "anthropic/claude-opus-7 (perf)";
const docsLabel = "google-gemini/gemini-3-pro (docs)";

function replayFor(seat: PlannedSeat) {
	return {
		provider: seat.provider,
		model: seat.model,
		lens: seat.lens,
		lensPrompt: seat.lensPrompt,
		baseRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		worktree: "/snapshot",
	};
}

const lifecycle = {
	startedAtMs: 1,
	settledAtMs: 2,
	durationMs: 1,
	attempts: 1 as const,
	aborted: false,
	tokens: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, total: 26 },
	cost: 0.02,
};

const correctnessFindings: Finding[] = [
	{
		file: "src/run/collect.ts",
		line: 12,
		severity: "high",
		title: "Off-by-one in loop bound",
		evidence: "for (let i = 0; i <= rows.length; i++)",
	},
	{
		file: "src/run/render.ts",
		line: 40,
		endLine: 44,
		severity: "low",
		title: "Unreachable branch",
		evidence: "the else arm cannot fire",
	},
];
const securityFindings: Finding[] = [
	{
		file: "src/seat/process.ts",
		line: 7,
		severity: "medium",
		title: "Unbounded stderr tail",
		evidence: "stderr is read without a cap",
	},
	{
		file: "src/seat/process.ts",
		line: 21,
		severity: "medium",
		title: "Signal name echoed unvalidated",
		evidence: "reason carries the raw signal string",
	},
];

/**
 * Five planned seats: two voted with findings, one voted an empty array, and
 * two report attributed SDK failures. Collection stamps F-1..F-4 in seat-list
 * then row order.
 */
function panelOutcomes(): SeatOutcomeFacts[] {
	return [
		{
			seat: correctnessSeat,
			replay: replayFor(correctnessSeat),
			lifecycle,
			outcome: { kind: "voted", findings: correctnessFindings },
		},
		{
			seat: securitySeat,
			replay: replayFor(securitySeat),
			lifecycle,
			outcome: { kind: "voted", findings: securityFindings },
		},
		{
			seat: testsSeat,
			replay: replayFor(testsSeat),
			lifecycle,
			outcome: { kind: "voted", findings: [] },
		},
		{
			seat: perfSeat,
			replay: replayFor(perfSeat),
			lifecycle: { ...lifecycle, attempts: 2 as const },
			outcome: {
				kind: "failed",
				class: "no-submit",
				reason:
					"seat SDK session ended without submitting findings after no-submit retry",
			},
		},
		{
			seat: docsSeat,
			replay: replayFor(docsSeat),
			lifecycle,
			outcome: {
				kind: "failed",
				class: "provider-error",
				reason: "seat SDK session failed: authentication unavailable",
			},
		},
	];
}

function renderPanel(): string {
	const outcomes = panelOutcomes();
	return renderReport({ meta, stamped: collectFindings(outcomes), outcomes });
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** One heading's body: from the heading to the next level-2/3 heading. */
function section(report: string, heading: string): string {
	const start = report.indexOf(heading);
	if (start === -1) {
		throw new Error(`heading not found in report: ${heading}`);
	}
	const body = report.slice(start + heading.length);
	const next = body.search(/\n#{2,3} /);
	return next === -1 ? body : body.slice(0, next);
}

const FORBIDDEN_TOKENS = ["verdict", "quorum", "agreement", "consensus"];

function forbiddenTokensFound(text: string): string[] {
	const lowered = text.toLowerCase();
	return FORBIDDEN_TOKENS.filter((token) => lowered.includes(token));
}

describe("renderReport", () => {
	it("renders the run meta in the header", () => {
		const report = renderPanel();

		expect(report.startsWith(`# Review run ${meta.runId}`)).toBe(true);
		expect(report).toContain("Base ref: `feat/review-run`");
		expect(report).toContain(
			"Base OID: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
		);
		expect(report).toContain(
			"HEAD OID: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`",
		);
	});

	it("orders findings severity-first, each attributed to its submitting seat (AC-14)", () => {
		const report = renderPanel();

		const highIndex = report.indexOf("### F-1 [high]");
		const mediumFirstIndex = report.indexOf("### F-3 [medium]");
		const mediumSecondIndex = report.indexOf("### F-4 [medium]");
		const lowIndex = report.indexOf("### F-2 [low]");

		expect(highIndex).toBeGreaterThan(-1);
		expect(mediumFirstIndex).toBeGreaterThan(highIndex);
		expect(mediumSecondIndex).toBeGreaterThan(mediumFirstIndex);
		expect(lowIndex).toBeGreaterThan(mediumSecondIndex);

		expect(section(report, "### F-1 [high]")).toContain(
			`- Seat: ${correctnessLabel}`,
		);
		expect(section(report, "### F-3 [medium]")).toContain(
			`- Seat: ${securityLabel}`,
		);
		expect(section(report, "### F-2 [low]")).toContain(
			`- Seat: ${correctnessLabel}`,
		);
	});

	it("renders a finding's location, evidence, and same-severity stability", () => {
		const report = renderPanel();

		const high = section(report, "### F-1 [high]");
		expect(high).toContain("- Location: src/run/collect.ts:12");
		expect(high).toContain(
			"- Evidence: for (let i = 0; i <= rows.length; i++)",
		);

		const low = section(report, "### F-2 [low]");
		expect(low).toContain("- Location: src/run/render.ts:40-44");

		// Same-severity findings keep collection (id) order: stable, not re-ranked.
		expect(section(report, "### F-3 [medium]")).toContain(
			"Unbounded stderr tail",
		);
		expect(section(report, "### F-4 [medium]")).toContain(
			"Signal name echoed unvalidated",
		);
	});

	it("names every planned seat exactly once with its outcome (AC-10)", () => {
		const report = renderPanel();

		for (const label of [
			correctnessLabel,
			securityLabel,
			testsLabel,
			perfLabel,
			docsLabel,
		]) {
			expect(countOccurrences(report, `### ${label}`)).toBe(1);
		}

		expect(section(report, `### ${correctnessLabel}`)).toContain(
			"- Outcome: voted, 2 findings",
		);
		expect(section(report, `### ${securityLabel}`)).toContain(
			"- Outcome: voted, 2 findings",
		);

		const failed = section(report, `### ${perfLabel}`);
		expect(failed).toContain("- Outcome: failed");
		expect(failed).toContain("- Failure class: no-submit");
		expect(failed).toContain(
			"- Reason: seat SDK session ended without submitting findings after no-submit retry",
		);

		const neverRan = section(report, `### ${docsLabel}`);
		expect(neverRan).toContain("- Outcome: failed");
		expect(neverRan).toContain("- Failure class: provider-error");
		expect(neverRan).toContain(
			"- Reason: seat SDK session failed: authentication unavailable",
		);
	});

	it("reports a seat that voted an empty array as voted with zero, never a failure (AC-11)", () => {
		const report = renderPanel();

		const zeroSeat = section(report, `### ${testsLabel}`);
		expect(zeroSeat).toContain("- Outcome: voted, 0 findings");
		expect(zeroSeat.toLowerCase()).not.toContain("failed");
	});

	it("renders SDK lifecycle facts without exposing durable replay input", () => {
		const outcomes = panelOutcomes();
		const report = renderReport({
			meta,
			stamped: collectFindings(outcomes),
			outcomes,
		});

		for (const facts of outcomes) {
			expect(facts.replay).toEqual(replayFor(facts.seat));
			expect(
				section(
					report,
					`### ${facts.seat.provider}/${facts.seat.model} (${facts.seat.lens})`,
				),
			).toContain("- SDK lifecycle:");
		}
		expect(report).not.toContain("Replay input");
		expect(report).not.toContain("/snapshot");
		expect(report).not.toContain(correctnessSeat.lensPrompt);
	});

	it("contains no verdict, quorum, agreement, or consensus language (NC-1)", () => {
		const report = renderPanel();

		// The negative assertion is only meaningful if the report is non-trivial:
		// assert there IS content to scan before asserting what it lacks.
		expect(report).toContain("## Findings");
		expect(report).toContain("## Seats");
		expect(report).toContain("- SDK lifecycle:");
		expect(report).toContain("### F-1 [high]");

		expect(forbiddenTokensFound(report)).toEqual([]);

		// Canary: the same oracle detects every token when they ARE present, so
		// the pass above is not vacuous.
		const planted =
			"The quorum reached a verdict by agreement of the consensus.";
		expect(forbiddenTokensFound(planted)).toEqual([
			"verdict",
			"quorum",
			"agreement",
			"consensus",
		]);
	});

	it("renders a run where every seat voted empty without inventing findings", () => {
		const outcomes: SeatOutcomeFacts[] = [
			{
				seat: correctnessSeat,
				replay: replayFor(correctnessSeat),
				lifecycle,
				outcome: { kind: "voted", findings: [] },
			},
			{
				seat: securitySeat,
				replay: replayFor(securitySeat),
				lifecycle,
				outcome: { kind: "voted", findings: [] },
			},
		];

		const report = renderReport({
			meta,
			stamped: collectFindings(outcomes),
			outcomes,
		});

		expect(report).toContain("No findings were submitted.");
		expect(report).not.toContain("### F-");
		expect(section(report, `### ${correctnessLabel}`)).toContain(
			"- Outcome: voted, 0 findings",
		);
	});
});

describe("renderReport annotations", () => {
	function annotationsReport(annotations: RunAnnotations): string {
		const outcomes = panelOutcomes();
		return renderReport({
			meta,
			stamped: collectFindings(outcomes),
			outcomes,
			annotations,
		});
	}

	it("renders a flag inline on the flagged finding, carrying the prior discard reason (AC-16)", () => {
		const report = annotationsReport({
			flags: [
				{
					findingId: "F-3",
					reason: "discarded as a false positive last run",
				},
			],
			notices: [],
		});

		const flagged = section(report, "### F-3 [medium]");
		expect(flagged).toContain(
			"- Flag: co-locates with a finding discarded in a prior run.",
		);
		expect(flagged).toContain(
			"- Prior discard reason: discarded as a false positive last run",
		);

		// Only the flagged finding carries it: its siblings stay clean.
		for (const heading of [
			"### F-1 [high]",
			"### F-2 [low]",
			"### F-4 [medium]",
		]) {
			expect(section(report, heading)).not.toContain("- Flag:");
		}
	});

	it("renders unreadable-ledger notices in a loud section ahead of the findings (AC-33)", () => {
		const report = annotationsReport({
			flags: [],
			notices: [
				{
					recordPath: "/records/prior-one",
					reason: "discard-ledger.json is not valid JSON",
				},
				{
					recordPath: "/records/prior-two",
					reason: "discard-ledger.json could not be read",
				},
			],
		});

		// Every notice is listed, attributed to its record, reason verbatim.
		const notices = section(report, "## Unreadable discard ledgers");
		expect(notices).toContain("- Record: /records/prior-one");
		expect(notices).toContain(
			"- Reason: discard-ledger.json is not valid JSON",
		);
		expect(notices).toContain("- Record: /records/prior-two");
		expect(notices).toContain(
			"- Reason: discard-ledger.json could not be read",
		);

		// Loud means leading: the section sits ahead of the findings, not
		// buried below them. The findings still render after it.
		expect(report.indexOf("## Unreadable discard ledgers")).toBeLessThan(
			report.indexOf("## Findings"),
		);
		expect(report).toContain("### F-1 [high]");
	});

	it("renders flags and notices together: flags inline, notices in their own section", () => {
		const report = annotationsReport({
			flags: [{ findingId: "F-1", reason: "prior reason" }],
			notices: [
				{
					recordPath: "/records/prior-one",
					reason: "discard-ledger.json is not valid JSON",
				},
			],
		});

		expect(section(report, "### F-1 [high]")).toContain(
			"- Prior discard reason: prior reason",
		);
		expect(section(report, "## Unreadable discard ledgers")).toContain(
			"- Record: /records/prior-one",
		);

		// No bleed between the two surfaces.
		expect(section(report, "### F-1 [high]")).not.toContain(
			"/records/prior-one",
		);
		expect(section(report, "## Unreadable discard ledgers")).not.toContain(
			"- Flag:",
		);
	});

	it("renders an empty annotations input byte-identical to no annotations", () => {
		const outcomes = panelOutcomes();
		const stamped = collectFindings(outcomes);
		const bare = renderReport({ meta, stamped, outcomes });
		const empty = renderReport({
			meta,
			stamped,
			outcomes,
			annotations: { flags: [], notices: [] },
		});

		expect(empty).toBe(bare);
		expect(bare).not.toContain("- Flag:");
		expect(bare).not.toContain("Unreadable discard ledgers");
	});

	it("keeps annotated reports free of verdict, quorum, agreement, or consensus language (NC-1)", () => {
		const report = annotationsReport({
			flags: [{ findingId: "F-2", reason: "prior reason" }],
			notices: [
				{
					recordPath: "/records/prior-one",
					reason: "discard-ledger.json is not valid JSON",
				},
			],
		});

		expect(report).toContain("- Prior discard reason: prior reason");
		expect(report).toContain("## Unreadable discard ledgers");
		expect(forbiddenTokensFound(report)).toEqual([]);
	});
});

describe("renderFindingsJson", () => {
	it("equals the stamped findings exactly, ids included (AC-13 cross-file identity)", () => {
		const outcomes = panelOutcomes();
		const stamped = collectFindings(outcomes);
		const report = renderReport({ meta, stamped, outcomes });

		const parsed: unknown = JSON.parse(renderFindingsJson(stamped));
		expect(parsed).toEqual(stamped);

		const entries = parsed as Array<Record<string, unknown>>;
		expect(entries.map((entry) => entry.id)).toEqual([
			"F-1",
			"F-2",
			"F-3",
			"F-4",
		]);
		// Nothing invented: exactly the stamped shape, no extra fields.
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(["finding", "id", "seat"]);
		}

		// Cross-file identity: the SAME id appears in report.md and findings.json.
		for (const entry of stamped) {
			expect(report).toContain(`### ${entry.id} [`);
		}
	});

	it("renders an empty stamped set as an empty array", () => {
		expect(JSON.parse(renderFindingsJson([]))).toEqual([]);
	});
});
