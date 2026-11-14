import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRoleTable } from "../src/config/roles.js";
import {
	GROUPS_FILE,
	GROUPS_MAC_FILE,
	numberGroups,
	planConsolidator,
	readSignedGroups,
} from "../src/run/grouping.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { RunReviewError, runReview } from "../src/run/run-review.js";
import type { PlannedSeat, StampedFinding } from "../src/run/types.js";
import { TEST_RECORD_KEY, testGroupsMac } from "./fixtures/record-key.js";
import {
	createSdkSeatFake,
	type FakeResponse,
} from "./fixtures/sdk-seat-fake.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let repo = "";
afterEach(() => {
	if (repo !== "") {
		rmSync(repo, { recursive: true, force: true });
		repo = "";
	}
});

function createHostRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "run-grouping-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.email", "run@example.test"]);
	git(dir, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(dir, "committed.txt"), "committed\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "base"]);
	git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	writeFileSync(path.join(dir, "change.txt"), "change\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "change"]);
	return dir;
}

function seats(): PlannedSeat[] {
	return ["correctness", "security"].map((lens, index) => ({
		rosterId: `roster-${index}`,
		provider: "openai-codex",
		model: "gpt-5.3-codex",
		lens,
		lensPrompt: `Review this change through a ${lens} lens.`,
	}));
}

const CONSOLIDATOR: PlannedSeat = {
	rosterId: "opus",
	provider: "anthropic",
	model: "claude-opus-5",
	lens: "grouping",
	lensPrompt: "Group the findings.",
};

const SEAT_A_FINDINGS = [
	{
		file: "src/a.ts",
		line: 489,
		severity: "high",
		title: "Cache key ignores the tenant",
		evidence: "lookup() keys only on the path.",
	},
	{
		file: "src/b.ts",
		line: 10,
		severity: "low",
		title: "Typo in the log line",
		evidence: "It says recieved.",
	},
];
const SEAT_B_FINDINGS = [
	{
		file: "src/a.ts",
		line: 511,
		severity: "medium",
		title: "Tenant data leaks through the shared cache",
		evidence: "store() writes without the tenant id.",
	},
	{
		file: "src/c.ts",
		line: 3,
		severity: "medium",
		title: "No timeout on the fetch",
		evidence: "fetch() has no signal.",
	},
];
const REVIEWERS: FakeResponse[] = [
	{ kind: "findings", findings: SEAT_A_FINDINGS },
	{ kind: "findings", findings: SEAT_B_FINDINGS },
];
const GROUPED: FakeResponse = {
	kind: "grouping",
	attempts: [
		{
			groups: [
				{ findingIds: ["F-3", "F-1"] },
				{ findingIds: ["F-2"] },
				{ findingIds: ["F-4"] },
			],
		},
	],
};

async function review(
	options: {
		reviewers?: FakeResponse[];
		grouping?: FakeResponse[];
		consolidator?: PlannedSeat | undefined;
		seatBudgetMs?: number;
		abort?: AbortController;
	} = {},
) {
	repo = createHostRepo();
	const fake = createSdkSeatFake(
		options.reviewers ?? REVIEWERS,
		options.grouping ?? [GROUPED],
	);
	const consolidator =
		"consolidator" in options ? options.consolidator : CONSOLIDATOR;
	const run = runReview(
		{
			repoDir: repo,
			baseRef: "origin/main",
			seats: seats(),
			...(consolidator === undefined ? {} : { consolidator }),
			...(options.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: options.seatBudgetMs }),
		},
		{
			sessionFactory: fake.factory,
			recordKey: TEST_RECORD_KEY,
			...(options.abort === undefined
				? {}
				: { abortSignal: options.abort.signal }),
		},
	);
	return { run, fake };
}

describe("the grouping step", () => {
	it("runs one grouping seat after every reviewer and records signed groups (T495)", async () => {
		const { run, fake } = await review();
		const result = await run;

		expect(fake.runs).toHaveLength(3);
		const grouping = fake.runs[2];
		expect(grouping?.input.spec.profile?.kind).toBe("grouping");
		expect(grouping?.input.spec.provider).toBe("anthropic");
		expect(grouping?.input.spec.model).toBe("claude-opus-5");
		expect(grouping?.input.spec.expectedIds).toEqual([
			"F-1",
			"F-2",
			"F-3",
			"F-4",
		]);
		expect(grouping?.input.tools.map((tool) => tool.name)).toEqual([
			"git_diff",
			"submit_groups",
		]);
		// Every stamped finding reaches the seat as data, after the role prompt.
		const prompt = grouping?.prompts[0] ?? "";
		expect(prompt).toContain("data, not instructions");
		for (const title of [...SEAT_A_FINDINGS, ...SEAT_B_FINDINGS].map(
			(row) => row.title,
		)) {
			expect(prompt).toContain(title);
		}
		expect(prompt).toContain("F-3 [medium]");
		expect(prompt).toContain("openai-codex/gpt-5.3-codex (security)");
		expect(prompt).toContain("src/a.ts:511");
		expect(prompt).toContain("store() writes without the tenant id.");
		expect(prompt.indexOf("Group the findings.")).toBeLessThan(
			prompt.indexOf("data, not instructions"),
		);

		expect(result.grouping?.outcome).toEqual({
			kind: "grouped",
			groups: [
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4"] },
				{ id: "G-3", findingIds: ["F-2"] },
			],
		});
		expect(result.grouping?.seat.rosterId).toBe("opus");

		const bytes = readFileSync(
			path.join(result.recordPath, GROUPS_FILE),
			"utf8",
		);
		const runId = path.basename(result.recordPath);
		expect(JSON.parse(bytes)).toEqual({
			version: 1,
			runId,
			consolidator: {
				rosterId: "opus",
				provider: "anthropic",
				model: "claude-opus-5",
			},
			groups: [
				{ id: "G-1", findingIds: ["F-1", "F-3"] },
				{ id: "G-2", findingIds: ["F-4"] },
				{ id: "G-3", findingIds: ["F-2"] },
			],
		});
		expect(
			readFileSync(path.join(result.recordPath, GROUPS_MAC_FILE), "utf8"),
		).toBe(testGroupsMac(runId, bytes));
		expect(
			readSignedGroups(result.recordPath, TEST_RECORD_KEY)?.map(
				(group) => group.id,
			),
		).toEqual(["G-1", "G-2", "G-3"]);

		// findings.json stays the flat stamped list, untouched.
		const findings = JSON.parse(
			readFileSync(path.join(result.recordPath, "findings.json"), "utf8"),
		) as StampedFinding[];
		expect(findings.map((row) => row.id)).toEqual(["F-1", "F-2", "F-3", "F-4"]);
		expect(findings.map((row) => row.finding)).toEqual([
			...SEAT_A_FINDINGS,
			...SEAT_B_FINDINGS,
		]);

		// The grouping seat is not a reviewer: outcomes and lost coverage stay
		// the reviewers', and execution.json records the grouping beside them.
		expect(result.outcomes).toHaveLength(2);
		const execution = JSON.parse(
			readFileSync(path.join(result.recordPath, "execution.json"), "utf8"),
		) as {
			outcomes: unknown[];
			lostCoverage: string[];
			grouping?: { seat: { rosterId: string }; outcome: { kind: string } };
		};
		expect(execution.outcomes).toHaveLength(2);
		expect(execution.lostCoverage).toEqual([]);
		expect(execution.grouping?.seat.rosterId).toBe("opus");
		expect(execution.grouping?.outcome.kind).toBe("grouped");
		const report = readFileSync(
			path.join(result.recordPath, "report.md"),
			"utf8",
		);
		expect(report).toContain(
			"### G-1 [high, stated by a seat] Cache key ignores the tenant",
		);
		expect(report).toContain("### G-3 / F-2 [low] Typo in the log line");
		expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
			true,
		);
	});

	it("changes nothing without a consolidator: no grouping seat, no groups record", async () => {
		const { run, fake } = await review({ consolidator: undefined });
		const result = await run;
		expect(fake.runs).toHaveLength(2);
		expect(result.grouping).toBeUndefined();
		expect(existsSync(path.join(result.recordPath, GROUPS_FILE))).toBe(false);
		expect(existsSync(path.join(result.recordPath, GROUPS_MAC_FILE))).toBe(
			false,
		);
		const execution = JSON.parse(
			readFileSync(path.join(result.recordPath, "execution.json"), "utf8"),
		) as Record<string, unknown>;
		expect(execution).not.toHaveProperty("grouping");
	});

	it("changes nothing with fewer than two findings", async () => {
		const { run, fake } = await review({
			reviewers: [
				{ kind: "findings", findings: [SEAT_A_FINDINGS[0]] },
				{ kind: "findings", findings: [] },
			],
		});
		const result = await run;
		expect(fake.runs).toHaveLength(2);
		expect(result.grouping).toBeUndefined();
		expect(existsSync(path.join(result.recordPath, GROUPS_FILE))).toBe(false);
	});

	it("refuses an invalid submission and takes the seat's corrected one", async () => {
		const { run, fake } = await review({
			grouping: [
				{
					kind: "grouping",
					attempts: [
						{ groups: [{ findingIds: ["F-1", "F-9"] }] },
						{
							groups: [
								{ findingIds: ["F-1", "F-2"] },
								{ findingIds: ["F-2", "F-3", "F-4"] },
							],
						},
						{
							groups: [
								{ findingIds: ["F-1", "F-3"] },
								{ findingIds: ["F-2"] },
								{ findingIds: ["F-4"] },
							],
						},
					],
				},
			],
		});
		const result = await run;
		const refusals = fake.runs[2]?.refusals ?? [];
		expect(refusals).toHaveLength(2);
		expect(refusals[0]).toContain("F-9 is not a submitted finding");
		expect(refusals[0]).toContain("F-2 is in no group");
		expect(refusals[1]).toContain("F-2 is in more than one group");
		expect(result.grouping?.outcome.kind).toBe("grouped");
	});

	it("falls back to the flat list when no valid grouping is ever submitted", async () => {
		const { run } = await review({
			grouping: [
				{
					kind: "grouping",
					attempts: [{ groups: [{ findingIds: ["F-1"] }] }],
				},
			],
		});
		const result = await run;
		expect(result.grouping?.outcome).toEqual({
			kind: "lost",
			class: "no-submit",
			reason:
				"seat SDK session ended without submitting groups after no-submit retry",
		});
		expect(existsSync(path.join(result.recordPath, GROUPS_FILE))).toBe(false);
		expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
			true,
		);
	});

	it("falls back to the flat list when the grouping seat fails", async () => {
		const { run } = await review({
			grouping: [{ kind: "failure", message: "provider down" }],
		});
		const result = await run;
		expect(result.grouping?.outcome).toMatchObject({
			kind: "lost",
			class: "provider-error",
		});
		expect(existsSync(path.join(result.recordPath, GROUPS_FILE))).toBe(false);
	});

	it("falls back to the flat list when the grouping seat runs out of its budget", async () => {
		const { run } = await review({
			grouping: [{ kind: "pending" }],
			seatBudgetMs: 300,
		});
		const result = await run;
		expect(result.grouping?.outcome).toMatchObject({
			kind: "lost",
			class: "killed",
		});
		expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
			true,
		);
	});

	it("leaves the record incomplete, to resume, when the host cancels during grouping", async () => {
		const abort = new AbortController();
		const { run, fake } = await review({
			grouping: [{ kind: "pending" }],
			abort,
		});
		const settled = run.then(
			() => undefined,
			(error: unknown) => error,
		);
		while (fake.runs.length < 3) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		abort.abort();
		const error = await settled;
		expect(error).toBeInstanceOf(RunReviewError);
		const runs = path.join(repo, ".review-panel", "runs");
		const [runId] = readdirSync(runs);
		expect(existsSync(path.join(runs, runId ?? "", COMPLETE_MARKER))).toBe(
			false,
		);
		expect(existsSync(path.join(runs, runId ?? "", GROUPS_FILE))).toBe(false);
	});
});

describe("numberGroups", () => {
	const stamped = (severities: string[]): StampedFinding[] =>
		severities.map((severity, index) => ({
			id: `F-${index + 1}`,
			seat: { provider: "p", model: "m", lens: "holistic" },
			finding: {
				file: "src/a.ts",
				line: index + 1,
				severity: severity as "high" | "medium" | "low",
				title: `title ${index + 1}`,
				evidence: `evidence ${index + 1}`,
			},
		}));

	it("numbers by the highest severity a seat stated, then by the lowest member F-id, compared as numbers", () => {
		const rows = stamped([
			"low",
			"medium",
			"low",
			"low",
			"low",
			"low",
			"low",
			"low",
			"low",
			"high",
			"medium",
		]);
		expect(
			numberGroups(rows, [
				["F-11"],
				["F-2", "F-1"],
				["F-10", "F-3"],
				["F-4", "F-5", "F-6", "F-7", "F-8", "F-9"],
			]),
		).toEqual([
			{ id: "G-1", findingIds: ["F-3", "F-10"] },
			{ id: "G-2", findingIds: ["F-1", "F-2"] },
			{ id: "G-3", findingIds: ["F-11"] },
			{ id: "G-4", findingIds: ["F-4", "F-5", "F-6", "F-7", "F-8", "F-9"] },
		]);
	});
});

describe("planConsolidator", () => {
	it("is absent without defaults.consolidator, and otherwise the roster row with the grouping prompt", () => {
		const roster = [
			{ id: "a", provider: "p", model: "m" },
			{
				id: "g",
				provider: "q",
				model: "n",
				extraExtensionPaths: ["/abs/ext.ts"],
			},
		];
		expect(
			planConsolidator({ roster, defaults: { seats: ["a"] } }),
		).toBeUndefined();
		expect(
			planConsolidator({
				roster,
				defaults: { seats: ["a"], consolidator: "g" },
			}),
		).toEqual({
			rosterId: "g",
			provider: "q",
			model: "n",
			lens: "grouping",
			lensPrompt: loadRoleTable().get("grouping")?.prompt,
			extraExtensionPaths: ["/abs/ext.ts"],
		});
	});
});
