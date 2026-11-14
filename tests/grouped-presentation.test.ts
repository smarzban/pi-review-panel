import { describe, expect, it } from "vitest";

import type { GroupingFacts } from "../src/run/grouping.js";
import { renderReport } from "../src/run/render.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type {
	PlannedSeat,
	SeatOutcomeFacts,
	StampedFinding,
} from "../src/run/types.js";
import type { SeatLifecycle } from "../src/seat/classify.js";
import type { Finding } from "../src/seat/schema.js";
import { renderReviewResult } from "../src/tool/review-presentation.js";
import { renderReviewRound } from "../src/tool/round-post.js";

const LIFECYCLE: SeatLifecycle = {
	startedAtMs: 1_000,
	settledAtMs: 3_000,
	durationMs: 2_000,
	attempts: 1,
	aborted: false,
	tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	cost: 0.01,
};

const PANEL: PlannedSeat[] = [
	{
		rosterId: "sol",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		lens: "holistic",
		lensPrompt: "",
	},
	{
		rosterId: "kimi",
		provider: "moonshot",
		model: "kimi-k3",
		lens: "holistic",
		lensPrompt: "",
	},
];

const CONSOLIDATOR: PlannedSeat = {
	rosterId: "opus",
	provider: "anthropic",
	model: "claude-opus-5",
	lens: "grouping",
	lensPrompt: "",
};

function finding(id: string, seatIndex: number, row: Finding): StampedFinding {
	const seat = PANEL[seatIndex] as PlannedSeat;
	return {
		id,
		seat: { provider: seat.provider, model: seat.model, lens: seat.lens },
		finding: row,
	};
}

const FINDINGS: StampedFinding[] = [
	finding("F-1", 0, {
		file: "src/cache.ts",
		line: 489,
		severity: "medium",
		title: "Cache key ignores the tenant",
		evidence: "lookup() keys only on the path.",
	}),
	finding("F-2", 0, {
		file: "src/log.ts",
		line: 10,
		severity: "low",
		title: "Typo in the log line",
		evidence: "It says recieved.",
	}),
	finding("F-3", 1, {
		file: "src/cache.ts",
		line: 511,
		severity: "high",
		title: "Tenant data leaks through the shared cache",
		evidence: "store() writes without the tenant id.",
	}),
	finding("F-4", 1, {
		file: "src/fetch.ts",
		line: 3,
		severity: "medium",
		title: "No timeout on the fetch",
		evidence: "fetch() has no signal.",
	}),
];

const GROUPED: GroupingFacts = {
	seat: CONSOLIDATOR,
	lifecycle: LIFECYCLE,
	outcome: {
		kind: "grouped",
		groups: [
			{ id: "G-1", findingIds: ["F-1", "F-3"] },
			{ id: "G-2", findingIds: ["F-4"] },
			{ id: "G-3", findingIds: ["F-2"] },
		],
	},
};

const LOST: GroupingFacts = {
	seat: CONSOLIDATOR,
	lifecycle: LIFECYCLE,
	outcome: {
		kind: "lost",
		class: "no-submit",
		reason: "seat SDK session ended without submitting groups",
	},
};

function outcomes(): SeatOutcomeFacts[] {
	return PANEL.map((seat, index) => ({
		seat,
		replay: {
			provider: seat.provider,
			model: seat.model,
			lens: seat.lens,
			lensPrompt: "",
			worktree: "",
		},
		lifecycle: LIFECYCLE,
		outcome: {
			kind: "voted" as const,
			findings: FINDINGS.filter((row) =>
				index === 0
					? row.seat.provider === "openai-codex"
					: row.seat.provider === "moonshot",
			).map((row) => row.finding),
		},
	}));
}

function result(grouping?: GroupingFacts): RunReviewResult {
	return {
		recordPath: "/repo/.review-panel/runs/r1",
		outcomes: outcomes(),
		...(grouping === undefined ? {} : { grouping }),
	};
}

function reply(grouping?: GroupingFacts): string {
	return renderReviewResult({
		recordPath: "/repo/.review-panel/runs/r1",
		panel: PANEL,
		result: result(grouping),
		findings: FINDINGS,
		suggestions: [],
	});
}

function round(grouping?: GroupingFacts): string {
	return renderReviewRound({
		runId: "r1",
		baseRef: "main",
		baseOid: "a".repeat(40),
		headOid: "b".repeat(40),
		panel: PANEL,
		result: result(grouping),
		findings: FINDINGS,
		suggestions: [],
	});
}

function report(grouping?: GroupingFacts): string {
	return renderReport({
		meta: {
			runId: "r1",
			baseRef: "main",
			baseOid: "a".repeat(40),
			headOid: "b".repeat(40),
		},
		stamped: FINDINGS,
		outcomes: outcomes(),
		...(grouping === undefined ? {} : { grouping }),
	});
}

/** Words that would present group size as agreement or a vote. */
const AGREEMENT =
	/\bagree|\bvote[sd]? for|\bconsensus|\bquorum|\b\d+ (seats?|findings?) agree|\b\d+ seats?\b/i;

describe("the grouped review reply", () => {
	it("shows each group once: a header row, then a row per member (T495)", () => {
		const text = reply(GROUPED);
		expect(text).toContain("2/2 voted · 4 findings in 3 groups");
		expect(text).toContain("Seats: holistic (sol, kimi), grouping (opus)");
		const lines = text.split("\n");
		const g1 = lines.indexOf(
			"- G-1 [high, stated by a seat] Cache key ignores the tenant",
		);
		expect(g1).toBeGreaterThan(0);
		expect(lines.slice(g1 + 1, g1 + 5)).toEqual([
			"  - F-1 [medium] sol/holistic (src/cache.ts:489)",
			"    lookup() keys only on the path.",
			"  - F-3 [high] kimi/holistic (src/cache.ts:511)",
			"    store() writes without the tenant id.",
		]);
		expect(text).toContain(
			"- G-2 / F-4 [medium] No timeout on the fetch (src/fetch.ts:3) — kimi/holistic\n  fetch() has no signal.",
		);
		expect(text).toContain(
			"- G-3 / F-2 [low] Typo in the log line (src/log.ts:10) — sol/holistic",
		);
		expect(text.indexOf("G-1")).toBeLessThan(text.indexOf("G-2"));
		expect(text.indexOf("G-2")).toBeLessThan(text.indexOf("G-3"));
		expect(text).not.toMatch(AGREEMENT);
	});

	it("counts the grouping seat's time and cost in the summary", () => {
		const grouping: GroupingFacts = {
			...GROUPED,
			lifecycle: { ...LIFECYCLE, settledAtMs: 9_000, cost: 0.5 },
		};
		expect(reply(grouping)).toContain(
			"2/2 voted · 4 findings in 3 groups · 8.0s · $0.5200",
		);
	});

	it("keeps every finding's id, severity and evidence (T495)", () => {
		const text = reply(GROUPED);
		for (const row of FINDINGS) {
			expect(text).toContain(`${row.id} [${row.finding.severity}]`);
			expect(text).toContain(row.finding.evidence);
		}
	});

	it("shows the flat list and a lost-grouping line when grouping was lost", () => {
		const text = reply(LOST);
		expect(text).toContain("Lost: grouping (opus, no-submit)");
		expect(text).toContain("Seats: holistic (sol, kimi), grouping (opus)");
		expect(text).toContain("2/2 voted · 4 findings ·");
		expect(text).not.toContain("G-1");
		expect(text).toContain(
			"- F-3 [high] Tenant data leaks through the shared cache (src/cache.ts:511) — kimi/holistic",
		);
	});

	it("is unchanged without a grouping step", () => {
		const text = reply();
		expect(text).not.toContain("grouping");
		expect(text).not.toContain("G-");
		expect(text).toContain("2/2 voted · 4 findings ·");
	});

	it("cleans seat text in a group header like any other seat text", () => {
		const hostile = FINDINGS.map((row) =>
			row.id === "F-1"
				? {
						...row,
						finding: { ...row.finding, title: "Bad\n# Heading‮" },
					}
				: row,
		);
		const text = renderReviewResult({
			recordPath: "/r",
			panel: PANEL,
			result: result(GROUPED),
			findings: hostile,
		});
		expect(text).not.toContain("\n# Heading");
		expect(text).not.toContain("‮");
	});
});

describe("the grouped review PR comment", () => {
	it("posts the grouped list with tool labels bold and seat text plain (T495)", () => {
		const body = round(GROUPED);
		expect(body).toContain("4 findings in 3 groups");
		expect(body).toContain("**Seats:** holistic (sol, kimi), grouping (opus)");
		expect(body).toContain(
			"- **G-1 [high, stated by a seat]** Cache key ignores the tenant",
		);
		expect(body).toContain(
			"  - **F-1 [medium]** (`src/cache.ts:489`) — sol/holistic",
		);
		expect(body).toContain(
			"    **Evidence:** store() writes without the tenant id.",
		);
		expect(body).toContain(
			"- **G-2 / F-4 [medium]** No timeout on the fetch (`src/fetch.ts:3`) — kimi/holistic",
		);
		for (const row of FINDINGS) {
			expect(body).toContain(`${row.id} [${row.finding.severity}]`);
		}
		expect(body).not.toMatch(AGREEMENT);
	});

	it("names lost grouping and posts the flat list", () => {
		const body = round(LOST);
		expect(body).toContain("**Lost:** grouping (opus, no-submit)");
		expect(body).not.toContain("G-1");
		expect(body).toContain("**F-3 [high]**");
	});
});

describe("the grouped report.md", () => {
	it("shows the groups with every member's full finding, and the grouping seat (T495)", () => {
		const text = report(GROUPED);
		expect(text).toContain(
			"### G-1 [high, stated by a seat] Cache key ignores the tenant",
		);
		expect(text).toContain("#### F-1 [medium] Cache key ignores the tenant");
		expect(text).toContain(
			"#### F-3 [high] Tenant data leaks through the shared cache",
		);
		expect(text).toContain("### G-2 / F-4 [medium] No timeout on the fetch");
		for (const row of FINDINGS) {
			expect(text).toContain(row.finding.title);
			expect(text).toContain(row.finding.evidence);
		}
		expect(text).toContain("## Grouping");
		expect(text).toContain("anthropic/claude-opus-5 (grouping)");
		expect(text).toContain("- Outcome: grouped 4 findings in 3 groups");
		expect(text).not.toMatch(AGREEMENT);
	});

	it("keeps the flat list and names lost grouping", () => {
		const text = report(LOST);
		expect(text).toContain("Lost: grouping (opus, no-submit)");
		expect(text).not.toContain("### G-");
		expect(text).toContain("### F-3 [high]");
		expect(text).toContain("- Outcome: lost");
		expect(text).toContain("- Failure class: no-submit");
	});

	it("is unchanged without a grouping step", () => {
		expect(report()).not.toContain("rouping");
	});
});
