import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { runVerify } from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import {
	chainState,
	loadChainPrior,
	loadVerifyChain,
} from "../src/run/verify-chain.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import { validateVerification } from "../src/seat/verification-schema.js";
import {
	signReviewRecord,
	signVerifyRecord,
	TEST_RECORD_KEY,
} from "./fixtures/record-key.js";

/**
 * Verify rounds chain: each verify checks only what is still open after the
 * one before it, against the diff from that verify's head, and every link
 * is a signed record of the same review.
 */

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

type Repo = { repo: string; commits: string[] };

/** A repository with five commits: base, the reviewed head, then three fixes. */
function makeRepo(root: string): Repo {
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "test@example.test"]);
	git(repo, ["config", "user.name", "Test"]);
	const commits: string[] = [];
	for (const name of ["base", "head", "fix1", "fix2", "fix3"]) {
		writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", name, "--quiet"]);
		commits.push(git(repo, ["rev-parse", "HEAD"]));
	}
	return { repo, commits };
}

function finding(
	id: string,
	severity: "high" | "medium" | "low",
): StampedFinding {
	return {
		id,
		seat: { provider: "p", model: "m", lens: "holistic" },
		finding: {
			file: `src/${id}.ts`,
			line: 1,
			severity,
			title: `${id} title`,
			evidence: `${id} evidence`,
		},
	};
}

const FINDINGS = [
	finding("F-1", "high"),
	finding("F-2", "high"),
	finding("F-3", "medium"),
	finding("F-4", "low"),
];

const REVIEW = "2026-11-15T10-00-00-000Z-review";

function writeReview(
	repo: string,
	runId: string,
	baseOid: string,
	headOid: string,
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({ runId, baseRef: "main", baseOid, headOid }),
	);
	writeFileSync(path.join(recordPath, "findings.json"), JSON.stringify(FINDINGS));
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
}

type Item = {
	id: string;
	disposition: "resolved" | "still present" | "inconclusive";
};
type Regression = {
	file: string;
	line: number;
	title: string;
	evidence: string;
	undoes?: string;
};

const config: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "glm", provider: "ollama", model: "glm-5.2" },
	],
	defaults: { seats: ["terra"] },
};

let root: string;
let repo: string;
let commits: string[];
let specs: SeatSpec[];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "verify-chain-"));
	({ repo, commits } = makeRepo(root));
	writeReview(repo, REVIEW, commits[0] as string, commits[1] as string);
	specs = [];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Runs the real verify with one scripted answer per seat. */
async function verify(
	prior: string,
	head: string,
	kept: string[],
	answers: Array<{ items: Item[]; regressions?: Regression[] }>,
	extra: {
		dismissed?: Array<{ id: string; reason: string }>;
		lowAdvisory?: string[];
		seats?: string[];
	} = {},
) {
	let call = 0;
	return await runVerify(
		{
			repoDir: repo,
			config,
			priorRunId: prior,
			headRevision: head,
			keptFindingIds: kept,
			...extra,
		},
		{
			recordKey: TEST_RECORD_KEY,
			pinSnapshot: () => ({
				worktreePath: repo,
				release: () => ({ ok: true }),
			}),
			runAdvisorySeat: async (spec) => {
				specs.push(spec as SeatSpec);
				const answer = answers[call] ?? answers[0];
				call += 1;
				return {
					outcome: {
						kind: "verification",
						result: {
							items: (answer?.items ?? []).map((item) =>
								item.disposition === "resolved"
									? {
											...item,
											evidence: {
												file: "src/x.ts",
												explanation: `${item.id} fixed here`,
											},
										}
									: item,
							),
							regressions: (answer?.regressions ?? []).map((row) => ({
								...row,
								regressionId: "regression-1-1",
							})),
						},
					},
				} as never;
			},
		},
	);
}

function runIdOf(result: { recordPath: string }): string {
	return path.basename(result.recordPath);
}

function metaOf(result: { recordPath: string }): Record<string, unknown> {
	return JSON.parse(
		readFileSync(path.join(result.recordPath, "meta.json"), "utf8"),
	) as Record<string, unknown>;
}

const REGRESSION: Regression = {
	file: "src/new.ts",
	line: 4,
	title: "the fix drops a null check",
	evidence: "value can be null here",
};

describe("a three-round chain", () => {
	it("checks only what is open, against the previous verify's head, and carries a not-fixed id to the end", async () => {
		const [, reviewHead, fix1, fix2, fix3] = commits as [
			string,
			string,
			string,
			string,
			string,
		];
		const v1 = await verify(
			REVIEW,
			fix1,
			["F-1", "F-2", "F-3"],
			[
				{
					items: [
						{ id: "F-1", disposition: "resolved" },
						{ id: "F-2", disposition: "still present" },
						{ id: "F-3", disposition: "resolved" },
					],
					regressions: [REGRESSION],
				},
			],
			{ lowAdvisory: ["F-4"] },
		);
		expect(v1.link).toBe(1);
		expect(v1.priorRunId).toBe(REVIEW);
		expect(v1.priorHeadOid).toBe(reviewHead);
		expect(metaOf(v1)).toMatchObject({
			priorRunId: REVIEW,
			previousRunId: REVIEW,
			link: 1,
			baseOid: reviewHead,
			headOid: fix1,
		});
		expect(specs[0]?.baseRef).toBe(reviewHead);
		const firstVote = v1.outcomes[0]?.outcome;
		expect(
			firstVote?.kind === "voted" ? firstVote.result.regressions : [],
		).toMatchObject([{ regressionId: "V1-R1", title: REGRESSION.title }]);

		// Verify 2 chains from verify 1: its diff base is verify 1's head, and
		// it checks only the open set: F-2 (still present) and V1-R1.
		const v2 = await verify(runIdOf(v1), fix2, ["F-2", "V1-R1"], [
			{
				items: [
					{ id: "F-2", disposition: "still present" },
					{ id: "V1-R1", disposition: "resolved" },
				],
			},
		]);
		expect(v2.link).toBe(2);
		expect(v2.priorRunId).toBe(REVIEW);
		expect(v2.previousRunId).toBe(runIdOf(v1));
		expect(v2.priorHeadOid).toBe(fix1);
		expect(specs[1]?.baseRef).toBe(fix1);
		expect(specs[1]?.expectedIds).toEqual(["F-2", "V1-R1"]);
		expect(specs[1]?.cycle).toBe(2);
		expect(specs[1]?.dataAppendix).toContain(
			"V1-R1 [regression] the fix drops a null check (src/new.ts:4)",
		);
		expect(metaOf(v2)).toMatchObject({
			previousRunId: runIdOf(v1),
			link: 2,
		});

		const v3 = await verify(runIdOf(v2), fix3, ["F-2"], [
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		]);
		expect(v3.link).toBe(3);
		expect(specs[2]?.baseRef).toBe(fix2);
		expect(specs[2]?.expectedIds).toEqual(["F-2"]);

		const links = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY);
		expect(links.map((row) => row.runId)).toEqual(
			[v1, v2, v3].map(runIdOf),
		);
		const state = chainState(FINDINGS, links);
		expect(state.open).toEqual([]);
		const resolvedIn = Object.fromEntries(
			[...state.items.values()].map((item) => [
				item.id,
				item.state.status === "resolved"
					? item.state.link
					: item.state.status,
			]),
		);
		// The round that resolved it in the chain, not a vote across rounds.
		expect(resolvedIn).toEqual({
			"F-1": 1,
			"F-2": 3,
			"F-3": 1,
			"F-4": "low",
			"V1-R1": 2,
		});
	});

	it("numbers regressions across the verify's seats, V<link>-R<n>", async () => {
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[
				{
					items: [{ id: "F-1", disposition: "resolved" }],
					regressions: [REGRESSION],
				},
				{
					items: [{ id: "F-1", disposition: "resolved" }],
					regressions: [REGRESSION, { ...REGRESSION, title: "another" }],
				},
			],
			{ seats: ["terra", "glm"] },
		);
		const ids = v1.outcomes.flatMap((row) =>
			row.outcome.kind === "voted"
				? row.outcome.result.regressions.map((reg) => reg.regressionId)
				: [],
		);
		expect(ids).toEqual(["V1-R1", "V1-R2", "V1-R3"]);
		const state = chainState(
			FINDINGS,
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY),
		);
		expect(state.open).toEqual(["V1-R1", "V1-R2", "V1-R3"]);
	});
});

describe("what a chained verify may name", () => {
	async function firstRound() {
		return await verify(
			REVIEW,
			commits[2] as string,
			["F-1", "F-2"],
			[
				{
					items: [
						{ id: "F-1", disposition: "resolved" },
						{ id: "F-2", disposition: "still present" },
					],
				},
			],
		);
	}

	it("refuses an id an earlier round resolved, and records a dismissal so it is not judged again", async () => {
		const v1 = await firstRound();
		await expect(
			verify(runIdOf(v1), commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: F-1 was resolved by verify run "${runIdOf(v1)}"; it is not judged again`,
		);
		const v2 = await verify(runIdOf(v1), commits[3] as string, [], [
			{ items: [] },
		], {
			dismissed: [{ id: "F-2", reason: "out of scope for this PR" }],
		});
		const verification = JSON.parse(
			readFileSync(path.join(v2.recordPath, "verification.json"), "utf8"),
		) as { dismissed: unknown };
		expect(verification.dismissed).toEqual([
			{ id: "F-2", reason: "out of scope for this PR" },
		]);
		const state = chainState(
			FINDINGS,
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY),
		);
		expect(state.items.get("F-2")?.state).toEqual({
			status: "dismissed",
			link: 2,
			reason: "out of scope for this PR",
		});
		expect(state.open).toEqual([]);
		await expect(
			verify(runIdOf(v2), commits[4] as string, ["F-2"], []),
		).rejects.toThrow(
			`Verify refused: F-2 was dismissed in verify run "${runIdOf(v2)}"; it is not judged again`,
		);
	});

	it("refuses a regression listed as low/advisory: it has no severity", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], [
			{
				items: [{ id: "F-1", disposition: "resolved" }],
				regressions: [REGRESSION],
			},
		]);
		await expect(
			verify(runIdOf(v1), commits[3] as string, [], [], {
				lowAdvisory: ["V1-R1"],
			}),
		).rejects.toThrow(
			"Verify refused: V1-R1 is a regression, which has no severity; dismiss it with a reason instead",
		);
	});
});

describe("the undo guard", () => {
	it("tells a chained verify every id an earlier round resolved, and records a regression that undoes one", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1", "F-2"], [
			{
				items: [
					{ id: "F-1", disposition: "resolved" },
					{ id: "F-2", disposition: "still present" },
				],
			},
		]);
		// The next fix reverts F-1's fix while fixing F-2.
		const v2 = await verify(runIdOf(v1), commits[3] as string, ["F-2"], [
			{
				items: [{ id: "F-2", disposition: "resolved" }],
				regressions: [
					{
						file: "src/F-1.ts",
						line: 1,
						title: "the F-2 fix reverts the F-1 guard",
						evidence: "the guard line is gone again",
						undoes: "F-1",
					},
				],
			},
		]);
		expect(specs[1]?.undoableIds).toEqual(["F-1"]);
		expect(specs[1]?.scopingNote).toContain(
			"Earlier rounds marked these ids resolved: F-1.",
		);
		expect(specs[1]?.dataAppendix).toContain(
			"- F-1 F-1 title (src/F-1.ts) F-1 fixed here",
		);
		const vote = v2.outcomes[0]?.outcome;
		expect(vote?.kind === "voted" ? vote.result.regressions : []).toMatchObject(
			[{ regressionId: "V2-R1", undoes: "F-1" }],
		);
		const state = chainState(
			FINDINGS,
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY),
		);
		expect(state.items.get("V2-R1")).toMatchObject({
			regression: { link: 2, undoes: "F-1" },
			state: { status: "open", link: 2 },
		});
		expect(state.open).toEqual(["V2-R1"]);
	});

	it("the seat channel takes undoes only for an id an earlier round resolved", () => {
		const row = {
			file: "a.ts",
			line: 1,
			title: "t",
			evidence: "e",
			undoes: "F-9",
		};
		const refused = validateVerification(
			{ items: [], regressions: [row] },
			[],
			2,
			["F-1"],
		);
		expect(refused.ok).toBe(false);
		const taken = validateVerification(
			{ items: [], regressions: [{ ...row, undoes: "F-1" }] },
			[],
			2,
			["F-1"],
		);
		expect(taken.ok && taken.result.regressions[0]?.undoes).toBe("F-1");
		expect(
			validateVerification({ items: [], regressions: [row] }, [], 1).ok,
		).toBe(false);
	});
});

/** A signed verify record of `review`, written by hand. */
function writeLink(
	runId: string,
	review: string,
	meta: Record<string, unknown>,
	options: { signed?: boolean } = {},
): string {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId,
			kind: "verify",
			priorRunId: review,
			headOid: commits[2],
			...meta,
		}),
	);
	writeFileSync(
		path.join(recordPath, "verification.json"),
		JSON.stringify({ priorRunId: review, keptFindingIds: [], outcomes: [] }),
	);
	if (options.signed !== false) {
		signVerifyRecord(recordPath);
	}
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	return runId;
}

describe("the chain refuses what is not one line of signed links", () => {
	it("refuses verifying the review again once it has a verify, naming the latest", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], [
			{ items: [{ id: "F-1", disposition: "still present" }] },
		]);
		await expect(
			verify(REVIEW, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: review "${REVIEW}" has been verified already; verify against the latest verify, "${runIdOf(v1)}"`,
		);
	});

	it("refuses a stale prior: a verify that is not the latest, naming the latest", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], [
			{ items: [{ id: "F-1", disposition: "still present" }] },
		]);
		const v2 = await verify(runIdOf(v1), commits[3] as string, ["F-1"], [
			{ items: [{ id: "F-1", disposition: "still present" }] },
		]);
		await expect(
			verify(runIdOf(v1), commits[4] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${runIdOf(v1)}" is not the latest verify of review "${REVIEW}"; verify against the latest verify, "${runIdOf(v2)}"`,
		);
	});

	it("refuses a fork: two links chained from one record", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], [
			{ items: [{ id: "F-1", disposition: "still present" }] },
		]);
		const v2 = await verify(runIdOf(v1), commits[3] as string, ["F-1"], [
			{ items: [{ id: "F-1", disposition: "still present" }] },
		]);
		// A second verify that chained from verify 1 at the same time.
		const twin = `${runIdOf(v2)}-twin`;
		cpSync(v2.recordPath, path.join(path.dirname(v2.recordPath), twin), {
			recursive: true,
		});
		writeLink(twin, REVIEW, { previousRunId: runIdOf(v1), link: 2 });
		expect(() => loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toThrow(
			`forks at "${runIdOf(v1)}"`,
		);
		await expect(
			verify(runIdOf(v2), commits[4] as string, ["F-1"], []),
		).rejects.toThrow("run a new review");
	});

	it("refuses an unsigned link as the prior", async () => {
		writeLink("2026-11-15T11-00-00-000Z-planted", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
		}, { signed: false });
		expect(() =>
			loadChainPrior(
				repo,
				"2026-11-15T11-00-00-000Z-planted",
				TEST_RECORD_KEY,
			),
		).toThrow(
			/Verify refused: verify run "2026-11-15T11-00-00-000Z-planted" is not signed by this owner's record key .*; run a new review/,
		);
		// And it is no link of the chain: the review is still unverified.
		expect(loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toEqual([]);
	});

	it("refuses a gap: a link whose previous record is unsigned or missing", async () => {
		writeLink("2026-11-15T11-00-00-000Z-v1", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
		}, { signed: false });
		writeLink("2026-11-15T12-00-00-000Z-v2", REVIEW, {
			previousRunId: "2026-11-15T11-00-00-000Z-v1",
			link: 2,
		});
		expect(() => loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toThrow(
			`has a gap: verify "2026-11-15T12-00-00-000Z-v2" chains from "2026-11-15T11-00-00-000Z-v1"`,
		);
	});

	it("refuses a foreign link: one chained from a verify of another review", async () => {
		const other = "2026-11-15T09-00-00-000Z-other-review";
		writeReview(repo, other, commits[0] as string, commits[1] as string);
		writeLink("2026-11-15T11-00-00-000Z-of-other", other, {
			previousRunId: other,
			link: 1,
		});
		writeLink("2026-11-15T12-00-00-000Z-mixed", REVIEW, {
			previousRunId: "2026-11-15T11-00-00-000Z-of-other",
			link: 2,
		});
		expect(() => loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toThrow(
			"has a gap",
		);
		// The other review's chain is untouched by it.
		expect(
			loadVerifyChain(repo, other, TEST_RECORD_KEY).map((row) => row.runId),
		).toEqual(["2026-11-15T11-00-00-000Z-of-other"]);
	});

	it("takes verifies written before chaining: the newest is the first link, older ones are superseded", async () => {
		writeLink("2026-11-15T11-00-00-000Z-old-a", REVIEW, {});
		writeLink("2026-11-15T12-00-00-000Z-old-b", REVIEW, {
			headOid: commits[3],
		});
		const links = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY);
		expect(links.map((row) => [row.runId, row.link, row.legacy])).toEqual([
			["2026-11-15T12-00-00-000Z-old-b", 1, true],
		]);
		await expect(
			verify("2026-11-15T11-00-00-000Z-old-a", commits[4] as string, [], []),
		).rejects.toThrow(
			'verify against the latest verify, "2026-11-15T12-00-00-000Z-old-b"',
		);
		const next = await verify(
			"2026-11-15T12-00-00-000Z-old-b",
			commits[4] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "resolved" }] }],
		);
		expect(next.link).toBe(2);
		expect(next.priorHeadOid).toBe(commits[3]);
	});
});
