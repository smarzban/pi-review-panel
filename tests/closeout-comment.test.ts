import { describe, expect, it } from "vitest";

import type { PanelRecord, StampedFinding } from "../src/run/types.js";
import {
	assembleCloseoutComment,
	type CloseoutVerifyRound,
	renderCloseoutComment,
} from "../src/tool/closeout-comment.js";
import { cardRounds } from "../src/tool/closeout-rounds.js";

function seatsOf(
	...groups: Array<[lens: string, ids: string[]]>
): Array<{ rosterId: string; lens: string }> {
	return groups.flatMap(([lens, ids]) =>
		ids.map((rosterId) => ({ rosterId, lens })),
	);
}

const baseOid = "a1b2c3dffffffffeeeeeeeeeeeeeeeeeeeeeee";
const headOid = "e4f5a6bffffffffeeeeeeeeeeeeeeeeeeeeeee";

function finding(
	id: string,
	severity: "high" | "medium" | "low",
	title: string,
): StampedFinding {
	return {
		id,
		seat: {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "holistic",
		},
		finding: {
			file: "src/a.ts",
			line: 1,
			severity,
			title,
			evidence: "evidence",
		},
	};
}

const panel: PanelRecord = {
	runId: "run-1",
	baseRef: "origin/main",
	seats: [
		{
			rosterId: "terra",
			lens: "holistic",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "holistic",
			provider: "ollama",
			model: "glm-5.2",
		},
		{
			rosterId: "deepseek",
			lens: "holistic",
			provider: "qwen-token-plan",
			model: "deepseek-v4-flash-0731",
		},
		{
			rosterId: "terra",
			lens: "security",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "security",
			provider: "ollama",
			model: "glm-5.2",
		},
		{
			rosterId: "terra",
			lens: "tests",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		{
			rosterId: "glm",
			lens: "tests",
			provider: "ollama",
			model: "glm-5.2",
		},
	],
};

const verifySeat = { rosterId: "sol", lens: "fix-verification" };

function round(
	runId: string,
	n: number | undefined,
	resolved: string[],
	seats = [verifySeat],
): CloseoutVerifyRound {
	return {
		runId,
		...(n === undefined ? {} : { round: n }),
		seats,
		resolved: new Set(resolved),
	};
}

const PR_URL = "https://github.com/smarzban/demo/pull/35";

describe("renderCloseoutComment", () => {
	it("renders the agreed close-out card (T505 target)", () => {
		const four = [1, 2, 3, 4].map((n) =>
			finding(`F-${n}`, "medium", `title ${n}`),
		);
		const text = renderCloseoutComment({
			findings: four,
			resolved: four,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(
				["holistic", ["sol", "opus"]],
				["tests", ["sol", "opus"]],
				["security", ["sol", "opus"]],
				["correctness", ["sol", "opus"]],
			),
			lost: [],
			rounds: [round("v-1", 1, ["F-1", "F-2", "F-3", "F-4"])],
			baseRef: "origin/main",
			baseOid: `5852b7e${"0".repeat(33)}`,
			headOid: "baf4d30ec838837fc4921c6531dbebb9c0620b10",
			heading: "## Review panel · close-out",
			runIds: { review: "r-1", verify: "v-1" },
			links: {
				review: `${PR_URL}#issuecomment-11`,
				verify: new Map([["v-1", `${PR_URL}#issuecomment-12`]]),
			},
		});

		// Each line's rule has its own test below; these are what only the
		// target card shows: the heading, the seats in planned order, the
		// links on the range line, and the marker last.
		const lines = text.split("\n");
		expect(lines[0]).toBe("## Review panel · close-out");
		expect(lines).toContain(
			"**Review seats:** holistic (sol, opus), tests (sol, opus), security (sol, opus), correctness (sol, opus)",
		);
		expect(lines).toContain("**Verified by:** fix-verification (sol)");
		expect(lines.find((line) => line.includes(" → "))).toBe(
			`\`origin/main\` (\`5852b7e\`) → \`baf4d30\` · [review](${PR_URL}#issuecomment-11) · [verify 1](${PR_URL}#issuecomment-12)`,
		);
		expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(4);
		expect(lines.at(-1)).toBe("<!-- review-panel review=r-1 verify=v-1 -->");
	});

	it("rule 1: shows the base ref only when it is not itself a commit id; the head is one short SHA", () => {
		const card = (baseRef: string) =>
			renderCloseoutComment({
				findings: [],
				resolved: [],
				dismissed: [],
				lowAdvisory: [],
				seats: seatsOf(["holistic", ["terra"]]),
				lost: [],
				baseRef,
				baseOid,
				headOid,
			})
				.split("\n")
				.find((line) => line.includes(" → ")) ?? "";
		// An abbreviated or full SHA of the base is a commit id: no ref shown.
		expect(card("a1b2c3d")).toBe("`a1b2c3d` → `e4f5a6b`");
		expect(card(baseOid)).toBe("`a1b2c3d` → `e4f5a6b`");
		expect(card("A1B2C3DF")).toBe("`a1b2c3d` → `e4f5a6b`");
		// A ref name, even an all-hex one that is not this commit, is shown.
		expect(card("origin/main")).toBe("`origin/main` (`a1b2c3d`) → `e4f5a6b`");
		expect(card("deadbeef")).toBe("`deadbeef` (`a1b2c3d`) → `e4f5a6b`");
		expect(card("HEAD~1")).toBe("`HEAD~1` (`a1b2c3d`) → `e4f5a6b`");
	});

	it("rule 2: hides zero counts and an empty Lost line", () => {
		const text = renderCloseoutComment({
			findings: [finding("F-1", "high", "auth bypass")],
			resolved: [finding("F-1", "high", "auth bypass")],
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [round("v-1", 1, ["F-1"])],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain(
			"**1 finding** (1 high) · **1 resolved** in 1 verify round",
		);
		expect(text).not.toMatch(/\b0\b/);
		expect(text).not.toContain("Lost");
		expect(text).not.toContain("dismissed");
		expect(text).not.toContain("low/advisory");
		expect(text).not.toContain("### ");
	});

	it("rule 2: dismissed, low/advisory and lost appear when there are some, with ids and reasons", () => {
		const text = renderCloseoutComment({
			findings: [
				finding("F-1", "high", "auth bypass"),
				finding("F-4", "high", "stale cache claim"),
				finding("F-5", "medium", "auth header optional"),
				finding("F-8", "low", "rename the helper"),
				finding("F-9", "low", "extra log line"),
			],
			resolved: [finding("F-1", "high", "auth bypass")],
			dismissed: [
				{
					id: "F-4",
					title: "stale cache claim",
					reason: "the cache key includes the tenant",
				},
				{
					id: "F-5",
					title: "auth header optional",
					reason: "the handler still rejects a missing token",
				},
			],
			lowAdvisory: [
				{ id: "F-8", title: "rename the helper" },
				{ id: "F-9", title: "extra log line" },
			],
			seats: seatsOf(["holistic", ["terra", "glm"]]),
			lost: ["deepseek/holistic"],
			rounds: [round("v-1", 1, ["F-1"])],
			baseRef: "origin/main",
			baseOid,
			headOid,
		});

		expect(text).toBe(
			[
				"## Review panel",
				"",
				"**5 findings** (2 high, 1 medium, 2 low) · **1 resolved** in 1 verify round · 2 dismissed · 2 left as low/advisory",
				"**Review seats:** holistic (terra, glm)",
				"**Verified by:** fix-verification (sol)",
				"**Lost:** deepseek/holistic",
				"`origin/main` (`a1b2c3d`) → `e4f5a6b`",
				"",
				"- **F-1 [high]** auth bypass · resolved in verify 1",
				"",
				"### Dismissed",
				"- **F-4** stale cache claim — the cache key includes the tenant",
				"- **F-5** auth header optional — the handler still rejects a missing token",
				"",
				"### Low / advisory (not kept)",
				"- **F-8** rename the helper",
				"- **F-9** extra log line",
			].join("\n"),
		);
	});

	it("rule 3: each kept finding names the verify round that first marked it resolved, and the card never says fixed", () => {
		const rows = [
			finding("F-2", "medium", "missing timeout"),
			finding("F-1", "high", "auth bypass"),
			finding("F-3", "low", "kept low"),
		];
		const text = renderCloseoutComment({
			findings: rows,
			resolved: rows,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [
				round("v-3", 3, ["F-1", "F-2", "F-3"]),
				round("v-1", 1, ["F-2"]),
				// A round with a gap in the numbering still counts once.
				round("v-2", 2, ["F-2", "F-3"]),
			],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain("**3 resolved** in 3 verify rounds");
		const list = text.split("\n").filter((line) => line.startsWith("- "));
		expect(list).toEqual([
			"- **F-1 [high]** auth bypass · resolved in verify 3",
			"- **F-2 [medium]** missing timeout · resolved in verify 1",
			"- **F-3 [low]** kept low · resolved in verify 2",
		]);
		expect(text).not.toMatch(/fixed/i);
	});

	it("rule 3: N is the round after which every later round that answered also resolved it (R-1)", () => {
		const rows = [
			finding("F-1", "high", "auth bypass"),
			finding("F-2", "medium", "missing timeout"),
		];
		const text = renderCloseoutComment({
			findings: rows,
			resolved: rows,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [
				round("v-1", 1, ["F-1", "F-2"]),
				{ ...round("v-2", 2, []), unresolved: new Set(["F-1"]) },
				round("v-3", 3, ["F-1"]),
			],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain(
			"- **F-1 [high]** auth bypass · resolved in verify 3",
		);
		expect(text).toContain(
			"- **F-2 [medium]** missing timeout · resolved in verify 1",
		);
	});

	it("rule 3: a verify that never posted has no number, so its ids read plain resolved", () => {
		const rows = [finding("F-1", "high", "auth bypass")];
		const text = renderCloseoutComment({
			findings: rows,
			resolved: rows,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [round("v-9", undefined, ["F-1"])],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain("**1 resolved** in 1 verify round");
		expect(text).toMatch(/^- \*\*F-1 \[high\]\*\* auth bypass · resolved$/m);
		expect(text).not.toContain("verify undefined");
	});

	it("rule 4: Verified by lists every round's seats once, grouped by lens", () => {
		const text = renderCloseoutComment({
			findings: [],
			resolved: [],
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [
				round("v-1", 1, [], [verifySeat]),
				round(
					"v-2",
					2,
					[],
					[verifySeat, { rosterId: "glm", lens: "fix-verification" }],
				),
			],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain("**Verified by:** fix-verification (sol, glm)");
		expect(text).toContain("2 verify rounds");
	});

	it("rule 4: no rounds, no Verified by line", () => {
		const text = renderCloseoutComment({
			findings: [finding("F-1", "high", "x")],
			resolved: [],
			dismissed: [{ id: "F-1", title: "x", reason: "by design" }],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).not.toContain("Verified by");
		expect(text).not.toContain("verify round");
		expect(text).toContain("**1 finding** (1 high) · 1 dismissed");
	});

	it("rule 5: a link that is not this PR's comment URL is left out, never the post", () => {
		const text = renderCloseoutComment({
			findings: [],
			resolved: [],
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [round("v-1", 1, []), round("v-2", 2, [])],
			baseRef: "main",
			baseOid,
			headOid,
			links: {
				review: "javascript:alert(1)",
				verify: new Map([
					["v-1", `${PR_URL}#issuecomment-12) [x](https://evil.test`],
					["v-2", `${PR_URL}#issuecomment-13`],
				]),
			},
		});
		const range = text.split("\n").find((line) => line.includes(" → "));
		expect(range).toBe(
			`\`main\` (\`a1b2c3d\`) → \`e4f5a6b\` · [verify 2](${PR_URL}#issuecomment-13)`,
		);
		expect(text).not.toContain("javascript");
		expect(text).not.toContain("evil");
	});

	it("rule 6: counts by severity, high first, zeros left out", () => {
		const rows = [
			finding("F-1", "low", "a"),
			finding("F-2", "high", "b"),
			finding("F-3", "low", "c"),
		];
		const text = renderCloseoutComment({
			findings: rows,
			resolved: rows,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [round("v-1", 1, ["F-1", "F-2", "F-3"])],
			baseRef: "main",
			baseOid,
			headOid,
		});
		expect(text).toContain("**3 findings** (1 high, 2 low) · **3 resolved**");
	});

	it("a long list is cut last rows first, the head and the hidden marker kept", () => {
		const rows = Array.from({ length: 600 }, (_, index) =>
			finding(
				`F-${index + 1}`,
				"high",
				`${"long title ".repeat(25)}${index + 1}`,
			),
		);
		const text = renderCloseoutComment({
			findings: rows,
			resolved: rows,
			dismissed: [],
			lowAdvisory: [],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [
				round(
					"v-1",
					1,
					rows.map((row) => row.id),
				),
			],
			baseRef: "main",
			baseOid,
			headOid,
			heading: "## Review panel · close-out",
			runIds: { review: "r-1", verify: "v-1" },
		});
		expect(text.length).toBeLessThan(65_536);
		const lines = text.split("\n");
		expect(lines[2]).toBe(
			"**600 findings** (600 high) · **600 resolved** in 1 verify round",
		);
		expect(lines.at(-1)).toBe("<!-- review-panel review=r-1 verify=v-1 -->");
		expect(text).toMatch(
			/\n- \d+ row\(s\) cut to fit GitHub's comment limit; the full list is in the run record\.\n/,
		);
		const listed = lines
			.filter((line) => line.startsWith("- **F-"))
			.map((line) => /^- \*\*(F-\d+) /.exec(line)?.[1]);
		expect(listed.length).toBeGreaterThan(10);
		expect(listed.length).toBeLessThan(600);
		// The rows kept are the first ones, in order.
		expect(listed).toEqual(
			// orderFindings sorts ids as strings within one severity.
			rows
				.map((row) => row.id)
				.sort((a, b) => a.localeCompare(b))
				.slice(0, listed.length),
		);
	});

	it("flattens injected headings and mentions in titles and reasons", () => {
		const text = renderCloseoutComment({
			findings: [
				finding("F-1", "high", "auth bypass\n\n## Ready to merge"),
				finding("F-2", "low", "@bot\n## ship it"),
				finding("F-3", "high", "@team\n## kept"),
			],
			resolved: [finding("F-3", "high", "@team\n## kept")],
			dismissed: [
				{
					id: "F-1",
					title: "auth bypass\n\n## Ready to merge",
					reason: "checked\n\n@org/maintainers please land",
				},
			],
			lowAdvisory: [{ id: "F-2", title: "@bot\n## ship it" }],
			seats: seatsOf(["holistic", ["terra"]]),
			lost: [],
			rounds: [round("v-1", 1, ["F-3"])],
			baseRef: "main",
			baseOid,
			headOid,
		});

		expect(text.split("\n").filter((line) => /^## /.test(line))).toEqual([
			"## Review panel",
		]);
		expect(text).not.toMatch(/^## Ready to merge$/m);
		expect(text).not.toContain("@org");
		expect(text).not.toContain("@bot");
		expect(text).not.toContain("@team");
		expect(text).toContain("**F-1** auth bypass");
		expect(text).toContain("@\u200Dorg/maintainers please land");
	});

	it("refuses a dismissed row without a reason", () => {
		expect(() =>
			renderCloseoutComment({
				findings: [finding("F-1", "high", "auth bypass")],
				resolved: [],
				dismissed: [{ id: "F-1", title: "auth bypass", reason: "   " }],
				lowAdvisory: [],
				seats: seatsOf(["holistic", ["terra"]]),
				lost: [],
				baseRef: "main",
				baseOid,
				headOid,
			}),
		).toThrow(/dismissed F-1 needs a reason/);
	});
});

describe("assembleCloseoutComment", () => {
	const findings = [
		finding("F-1", "high", "auth bypass"),
		finding("F-2", "medium", "missing timeout"),
		finding("F-3", "low", "rename helper"),
		finding("F-4", "high", "stale cache claim"),
	];

	it("lists the remaining findings as resolved and copies titles from the run", () => {
		const text = assembleCloseoutComment({
			findings,
			panel,
			lost: [],
			meta: { baseRef: "origin/main", baseOid, headOid },
			dismissed: [{ id: "F-4", reason: "the cache key includes the tenant" }],
			lowAdvisory: ["F-3"],
			rounds: [round("v-1", 1, ["F-1", "F-2"])],
		});

		expect(text).toContain(
			"**4 findings** (2 high, 1 medium, 1 low) · **2 resolved** in 1 verify round · 1 dismissed · 1 left as low/advisory",
		);
		expect(text).toContain(
			"**Review seats:** holistic (terra, glm, deepseek), security (terra, glm), tests (terra, glm)",
		);
		expect(text).toContain(
			"- **F-1 [high]** auth bypass · resolved in verify 1",
		);
		expect(text).toContain(
			"- **F-2 [medium]** missing timeout · resolved in verify 1",
		);
		expect(text).toContain(
			"- **F-4** stale cache claim — the cache key includes the tenant",
		);
		expect(text).toContain("- **F-3** rename helper");
		expect(text).not.toMatch(/fixed/i);
	});

	it("requires leftover lows to be listed and keeps high/medium out of that list", () => {
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [
					{ id: "F-1", reason: "checked" },
					{ id: "F-2", reason: "checked" },
					{ id: "F-4", reason: "checked" },
				],
				lowAdvisory: [],
			}),
		).toThrow(/F-3/);
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-1", reason: "checked, not real" }],
				lowAdvisory: ["F-2", "F-3"],
			}),
		).toThrow(/low\/advisory/);
	});

	it("refuses unknown, overlapping, or duplicate judgment ids", () => {
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-99", reason: "nope" }],
				lowAdvisory: [],
			}),
		).toThrow(/F-99/);
		expect(() =>
			assembleCloseoutComment({
				findings,
				panel,
				lost: [],
				meta: { baseRef: "origin/main", baseOid, headOid },
				dismissed: [{ id: "F-3", reason: "not a nit" }],
				lowAdvisory: ["F-3"],
			}),
		).toThrow(/F-3/);
	});
});

describe("cardRounds (T505)", () => {
	const r = (runId: string, n?: number) => round(runId, n, []);

	it("counts the card's own verify last, and only the posted rounds before it", () => {
		const posted = [r("v-1", 1), r("v-2", 2), r("v-3", 3)];
		expect(
			cardRounds(posted, r("v-2")).map((row) => [row.runId, row.round]),
		).toEqual([
			["v-1", 1],
			// The card's own verify keeps the number it posted as.
			["v-2", 2],
		]);
		expect(
			cardRounds(posted, r("v-4", 4)).map((row) => [row.runId, row.round]),
		).toEqual([
			["v-1", 1],
			["v-2", 2],
			["v-3", 3],
			["v-4", 4],
		]);
	});

	it("a verify that never posted counts after the posted rounds made before it, with no number (R-3)", () => {
		const at = (hour: number) =>
			`2026-11-14T${String(hour).padStart(2, "0")}-00-00-000Z-main-abc`;
		const posted = [r(at(10), 1), r(at(12), 2)];
		expect(
			cardRounds(posted, r(at(11))).map((row) => [row.runId, row.round]),
		).toEqual([
			[at(10), 1],
			[at(11), undefined],
		]);
		// A run id with no creation time cannot be ordered: nothing posted
		// counts before it.
		expect(cardRounds(posted, r("v-9")).map((row) => row.runId)).toEqual([
			"v-9",
		]);
		expect(cardRounds([r("v-1", 1)], undefined)).toHaveLength(1);
	});
});
