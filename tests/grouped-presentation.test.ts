import { describe, expect, it } from "vitest";

import { type GroupingFacts, groupedView } from "../src/run/grouping.js";
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
import {
	GITHUB_COMMENT_LIMIT,
	renderReviewRound,
} from "../src/tool/round-post.js";

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

/** F-3, a member that is not its group's lead, with a hostile title. */
const HOSTILE_MEMBER: StampedFinding[] = FINDINGS.map((row) =>
	row.id === "F-3"
		? {
				...row,
				finding: { ...row.finding, title: "Leak\n# Heading‮ @octocat [x](y)" },
			}
		: row,
);

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
			"  - F-1 [medium] Cache key ignores the tenant (src/cache.ts:489) — sol/holistic",
			"    lookup() keys only on the path.",
			"  - F-3 [high] Tenant data leaks through the shared cache (src/cache.ts:511) — kimi/holistic",
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

	it("keeps every finding's id, severity, title and evidence (T495)", () => {
		const text = reply(GROUPED);
		for (const row of FINDINGS) {
			expect(text).toContain(
				`${row.id} [${row.finding.severity}] ${row.finding.title}`,
			);
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

	it("marks a group the reply cuts partway (review R-3)", () => {
		const members: StampedFinding[] = Array.from({ length: 80 }, (_, index) =>
			finding(`F-${index + 1}`, index % 2, {
				file: "src/cache.ts",
				line: index + 1,
				severity: "medium",
				title: `Leak ${index + 1}`,
				evidence: "e".repeat(400),
			}),
		);
		const grouping: GroupingFacts = {
			...GROUPED,
			outcome: {
				kind: "grouped",
				groups: [{ id: "G-1", findingIds: members.map((row) => row.id) }],
			},
		};
		const text = renderReviewResult({
			recordPath: "/r",
			panel: PANEL,
			result: result(grouping),
			findings: members,
		});
		const lines = text.split("\n");
		expect(lines).toContain("- G-1 [medium, stated by a seat] Leak 1");
		expect(
			lines.filter((line) => /^ {2}- F-\d+ /.test(line)).length,
		).toBeLessThan(80);
		const marker = lines.indexOf(
			"  - more of G-1 omitted; the full group is in the run record's report.md.",
		);
		expect(marker).toBeGreaterThan(0);
		expect(lines.at(-1)).toBe("- additional row(s) omitted.");
		expect(marker).toBe(lines.length - 2);
	});

	it("adds no group marker when the cut falls between groups", () => {
		const findings: StampedFinding[] = Array.from({ length: 80 }, (_, index) =>
			finding(`F-${index + 1}`, index % 2, {
				file: "src/cache.ts",
				line: index + 1,
				severity: "medium",
				title: `Leak ${index + 1}`,
				evidence: "e".repeat(400),
			}),
		);
		const grouping: GroupingFacts = {
			...GROUPED,
			outcome: {
				kind: "grouped",
				groups: findings.map((row, index) => ({
					id: `G-${index + 1}`,
					findingIds: [row.id],
				})),
			},
		};
		const text = renderReviewResult({
			recordPath: "/r",
			panel: PANEL,
			result: result(grouping),
			findings,
		});
		expect(text).toContain("- additional row(s) omitted.");
		expect(text).not.toContain("more of G-");
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

	it("cleans a later member's own title like any other seat text (panel P-1)", () => {
		const text = renderReviewResult({
			recordPath: "/r",
			panel: PANEL,
			result: result(GROUPED),
			findings: HOSTILE_MEMBER,
		});
		expect(text).toContain("  - F-3 [high] Leak # Heading");
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
			"  - **F-1 [medium]** Cache key ignores the tenant (`src/cache.ts:489`) — sol/holistic",
		);
		expect(body).toContain(
			"  - **F-3 [high]** Tenant data leaks through the shared cache (`src/cache.ts:511`) — kimi/holistic",
		);
		expect(body).toContain(
			"    **Evidence:** store() writes without the tenant id.",
		);
		expect(body).toContain(
			"- **G-2 / F-4 [medium]** No timeout on the fetch (`src/fetch.ts:3`) — kimi/holistic",
		);
		for (const row of FINDINGS) {
			expect(body).toContain(`${row.id} [${row.finding.severity}]`);
			expect(body).toContain(row.finding.title);
		}
		expect(body).not.toMatch(AGREEMENT);
	});

	it("posts a later member's own title through the posted-text cleaning (panel P-1)", () => {
		const body = renderReviewRound({
			runId: "r1",
			baseRef: "main",
			baseOid: "a".repeat(40),
			headOid: "b".repeat(40),
			panel: PANEL,
			result: result(GROUPED),
			findings: HOSTILE_MEMBER,
			suggestions: [],
		});
		const line = body
			.split("\n")
			.find((row) => row.startsWith("  - **F-3 [high]**"));
		// One line, the bidi override replaced, `#` and `@` joined, `[` escaped.
		expect(line).toBe(
			"  - **F-3 [high]** Leak #\u200d Heading\ufffd @\u200doctocat \\[x\\](y) (`src/cache.ts:511`) — kimi/holistic",
		);
		expect(body).not.toContain("\n# Heading");
	});

	it("posts an over-budget group partly, with a marker, and keeps the rows after it (review R-1)", () => {
		const members: StampedFinding[] = Array.from({ length: 120 }, (_, index) =>
			finding(`F-${index + 1}`, index % 2, {
				file: "src/cache.ts",
				line: index + 1,
				severity: index === 0 ? "high" : "medium",
				title: `Leak ${index + 1}`,
				evidence: "e".repeat(900),
			}),
		);
		const small = finding("F-121", 1, {
			file: "src/log.ts",
			line: 1,
			severity: "low",
			title: "Typo after the big group",
			evidence: "short",
		});
		const grouping: GroupingFacts = {
			...GROUPED,
			outcome: {
				kind: "grouped",
				groups: [
					{ id: "G-1", findingIds: members.map((row) => row.id) },
					{ id: "G-2", findingIds: ["F-121"] },
				],
			},
		};
		const body = renderReviewRound({
			runId: "r1",
			baseRef: "main",
			baseOid: "a".repeat(40),
			headOid: "b".repeat(40),
			panel: PANEL,
			result: result(grouping),
			findings: [...members, small],
			suggestions: [],
		});
		expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
		const lines = body.split("\n");
		expect(lines).toContain("- **G-1 [high, stated by a seat]** Leak 1");
		const shown = lines.filter((line) => /^ {2}- \*\*F-\d+ /.test(line));
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.length).toBeLessThan(120);
		const more = lines
			.map((line) =>
				/^ {2}- (\d+) more finding\(s\) in this group cut to fit GitHub's comment limit; the full group is in the run record's report\.md\.$/.exec(
					line,
				),
			)
			.find((match) => match !== null);
		expect(more).toBeDefined();
		expect(shown.length + Number(more?.[1])).toBe(120);
		// The marker follows the last shown member, inside the group.
		const markerAt = lines.findIndex((line) =>
			line.includes("more finding(s) in this group"),
		);
		expect(lines[markerAt - 1]?.startsWith("    **Evidence:**")).toBe(true);
		// The row after the big group still posts, and nothing is cut whole.
		expect(body).toContain(
			"- **G-2 / F-121 [low]** Typo after the big group (`src/log.ts:1`)",
		);
		expect(body).not.toContain("group(s) cut to fit");
		expect(lines.at(-1)).toBe("<!-- review-panel review=r1 -->");
	});

	it("all-dollar findings cannot push a later seat's high out of the review comment (T500 N-2)", () => {
		// Each `$` posts as `<span>$</span>`; a field is capped after
		// escaping, so a few all-`$` findings cannot fill the body budget.
		const dollars: StampedFinding[] = Array.from({ length: 4 }, (_, index) =>
			finding(`F-${index + 1}`, 0, {
				file: "src/money.ts",
				line: index + 1,
				severity: "high",
				title: "$".repeat(5_000),
				evidence: "$".repeat(5_000),
			}),
		);
		const real = finding("F-5", 1, {
			file: "src/cache.ts",
			line: 7,
			severity: "high",
			title: "Tenant data leaks through the shared cache",
			evidence: "store() writes without the tenant id.",
		});
		const body = renderReviewRound({
			runId: "r1",
			baseRef: "main",
			baseOid: "a".repeat(40),
			headOid: "b".repeat(40),
			panel: PANEL,
			result: result(),
			findings: [...dollars, real],
			suggestions: [],
		});
		expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
		for (const id of ["F-1", "F-2", "F-3", "F-4"]) {
			expect(body).toContain(`- **${id} [high]** <span>$</span>`);
		}
		expect(body).toContain(
			"- **F-5 [high]** Tenant data leaks through the shared cache",
		);
		expect(body).not.toContain("cut to fit GitHub's comment limit");
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

describe("groupedView", () => {
	const groupedAs = (groups: { id: string; findingIds: string[] }[]) =>
		({
			...GROUPED,
			outcome: { kind: "grouped", groups },
		}) satisfies GroupingFacts;

	it("is undefined, and every surface shows the flat list, when the groups do not place every shown finding exactly once", () => {
		for (const groups of [
			// F-2 is in no group.
			[
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4"] },
			],
			// F-9 is not a shown finding.
			[
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4", "F-9"] },
				{ id: "G-3", findingIds: ["F-2"] },
			],
			// F-1 is in two groups.
			[
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4", "F-1"] },
				{ id: "G-3", findingIds: ["F-2"] },
			],
			// An empty group.
			[
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4"] },
				{ id: "G-3", findingIds: ["F-2"] },
				{ id: "G-4", findingIds: [] },
			],
		]) {
			const grouping = groupedAs(groups);
			expect(groupedView(FINDINGS, grouping)).toBeUndefined();
			const text = reply(grouping);
			expect(text).toContain("2/2 voted · 4 findings ·");
			expect(text).not.toMatch(/\bG-\d/);
			expect(text).toContain(
				"- F-3 [high] Tenant data leaks through the shared cache (src/cache.ts:511) — kimi/holistic",
			);
			expect(round(grouping)).not.toMatch(/\bG-\d/);
			expect(report(grouping)).not.toMatch(/\bG-\d/);
		}
		// The same findings with every one placed once are grouped.
		expect(
			groupedView(
				FINDINGS,
				groupedAs([
					{ id: "G-1", findingIds: ["F-1", "F-3"] },
					{ id: "G-2", findingIds: ["F-4"] },
					{ id: "G-3", findingIds: ["F-2"] },
				]),
			)?.map((group) => group.id),
		).toEqual(["G-1", "G-2", "G-3"]);
	});

	it("is undefined without a grouping step or with lost grouping", () => {
		expect(groupedView(FINDINGS, undefined)).toBeUndefined();
		expect(groupedView(FINDINGS, LOST)).toBeUndefined();
	});
});
