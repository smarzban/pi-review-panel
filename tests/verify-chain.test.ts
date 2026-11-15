import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commentAction } from "../src/actions/actions.js";
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
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify(FINDINGS),
	);
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
	answers: Array<{ items: Item[]; regressions?: Regression[]; lost?: boolean }>,
	extra: {
		dismissed?: Array<{ id: string; reason: string }>;
		lowAdvisory?: string[];
		seats?: string[];
	} = {},
	hooks: { onSeat?: () => Promise<void>; abortSignal?: AbortSignal } = {},
) {
	let call = 0;
	// The first verify places every finding: unless the test says, the
	// highs and mediums it does not keep are dismissed.
	const placed =
		prior === REVIEW && extra.dismissed === undefined
			? {
					dismissed: FINDINGS.filter(
						(row) => row.finding.severity !== "low" && !kept.includes(row.id),
					).map((row) => ({ id: row.id, reason: "not in this test" })),
				}
			: {};
	return await runVerify(
		{
			repoDir: repo,
			config,
			priorRunId: prior,
			headRevision: head,
			keptFindingIds: kept,
			...placed,
			...extra,
		},
		{
			recordKey: TEST_RECORD_KEY,
			...(hooks.abortSignal === undefined
				? {}
				: { abortSignal: hooks.abortSignal }),
			pinSnapshot: () => ({
				worktreePath: repo,
				release: () => ({ ok: true }),
			}),
			runAdvisorySeat: async (spec) => {
				specs.push(spec as SeatSpec);
				await hooks.onSeat?.();
				const answer = answers[call] ?? answers[0];
				call += 1;
				if (answer?.lost === true) {
					return {
						outcome: {
							kind: "failure",
							class: "provider-error",
							reason: "provider down",
						},
					} as never;
				}
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
		const v2 = await verify(
			runIdOf(v1),
			fix2,
			["F-2", "V1-R1"],
			[
				{
					items: [
						{ id: "F-2", disposition: "still present" },
						{ id: "V1-R1", disposition: "resolved" },
					],
				},
			],
		);
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

		const v3 = await verify(
			runIdOf(v2),
			fix3,
			["F-2"],
			[{ items: [{ id: "F-2", disposition: "resolved" }] }],
		);
		expect(v3.link).toBe(3);
		expect(specs[2]?.baseRef).toBe(fix2);
		expect(specs[2]?.expectedIds).toEqual(["F-2"]);

		const links = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY);
		expect(links.map((row) => row.runId)).toEqual([v1, v2, v3].map(runIdOf));
		const state = chainState(FINDINGS, links);
		expect(state.open).toEqual([]);
		const resolvedIn = Object.fromEntries(
			[...state.items.values()].map((item) => [
				item.id,
				item.state.status === "resolved" ? item.state.link : item.state.status,
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

describe("a round that lost a verify seat", () => {
	it("resolves nothing: its ids stay open until a round with no lost seat confirms them (S-5)", async () => {
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1", "F-2"],
			[
				{
					items: [
						{ id: "F-1", disposition: "resolved" },
						{ id: "F-2", disposition: "resolved" },
					],
				},
				{ items: [], lost: true },
			],
			{ seats: ["terra", "glm"] },
		);
		let state = chainState(
			FINDINGS,
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY),
		);
		expect(state.open).toEqual(["F-1", "F-2"]);
		// They can be checked again, and a whole round confirms them.
		await verify(
			runIdOf(v1),
			commits[3] as string,
			["F-1", "F-2"],
			[
				{
					items: [
						{ id: "F-1", disposition: "resolved" },
						{ id: "F-2", disposition: "resolved" },
					],
				},
			],
		);
		state = chainState(
			FINDINGS,
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY),
		);
		expect(state.open).toEqual([]);
		expect(state.items.get("F-1")?.state).toMatchObject({
			status: "resolved",
			link: 2,
		});
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
		const v2 = await verify(
			runIdOf(v1),
			commits[3] as string,
			[],
			[{ items: [] }],
			{
				dismissed: [{ id: "F-2", reason: "out of scope for this PR" }],
			},
		);
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
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[
				{
					items: [{ id: "F-1", disposition: "resolved" }],
					regressions: [REGRESSION],
				},
			],
		);
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
		const v1 = await verify(
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
		// The next fix reverts F-1's fix while fixing F-2.
		const v2 = await verify(
			runIdOf(v1),
			commits[3] as string,
			["F-2"],
			[
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
			],
		);
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

describe("no forks: a verify claims the link it chains from (S-2)", () => {
	const reviewDir = () => path.join(repo, ".review-panel", "runs", REVIEW);
	const claimFile = (prior: string, generation: number) =>
		path.join(reviewDir(), `chain-${prior}.claim-${generation}`);
	const chainClaims = () =>
		readdirSync(reviewDir()).filter((name) => name.startsWith("chain-"));
	const held = (prior: string, generation: number) =>
		(
			JSON.parse(readFileSync(claimFile(prior, generation), "utf8")) as {
				verifyRunId: string;
			}
		).verifyRunId;
	const STILL = [{ items: [{ id: "F-1", disposition: "still present" }] }] as [
		{ items: Item[] },
	];

	it("a second verify from the same tip is refused, naming the running one, before any seat runs; then the finished one", async () => {
		let refusal: unknown;
		let running = "";
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			STILL,
			{},
			{
				onSeat: async () => {
					if (specs.length > 1) {
						return;
					}
					running = held(REVIEW, 1);
					await verify(REVIEW, commits[3] as string, ["F-1"], STILL).catch(
						(error: unknown) => {
							refusal = error;
						},
					);
				},
			},
		);
		expect(running).toBe(runIdOf(v1));
		expect(String(refusal)).toContain(
			`Verify refused: verify "${runIdOf(v1)}" is already running from "${REVIEW}"`,
		);
		expect(specs).toHaveLength(1);
		// Given back once the verify is signed: the chain itself names it now.
		expect(chainClaims()).toEqual([]);
		await expect(
			verify(REVIEW, commits[3] as string, ["F-1"], STILL),
		).rejects.toThrow(`verify against the latest verify, "${runIdOf(v1)}"`);
	});

	it("a later link is claimed the same way: from the previous verify, not the review", async () => {
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], STILL);
		let claimed: string[] = [];
		await verify(
			runIdOf(v1),
			commits[3] as string,
			["F-1"],
			STILL,
			{},
			{
				onSeat: async () => {
					claimed = chainClaims();
				},
			},
		);
		expect(claimed).toEqual([`chain-${runIdOf(v1)}.claim-1`]);
	});

	it("a stale claim is skipped and left where it is, so the chain is never dead", async () => {
		writeFileSync(
			claimFile(REVIEW, 1),
			`${JSON.stringify({
				verifyRunId: "2026-11-15T10-30-00-000Z-crashed",
				pid: 1,
				host: "elsewhere",
				claimedAt: Date.now() - 66_000,
			})}\n`,
		);
		let claimed: string[] = [];
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			STILL,
			{},
			{
				onSeat: async () => {
					claimed = chainClaims();
				},
			},
		);
		expect(claimed).toEqual([
			`chain-${REVIEW}.claim-1`,
			`chain-${REVIEW}.claim-2`,
		]);
		expect(held(REVIEW, 1)).toBe("2026-11-15T10-30-00-000Z-crashed");
		expect(chainClaims()).toEqual([`chain-${REVIEW}.claim-1`]);
		expect(loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toHaveLength(1);
		expect(runIdOf(v1)).not.toBe("");
	});

	it("a live claim names the file to delete when no verify is running", async () => {
		writeFileSync(
			claimFile(REVIEW, 1),
			`${JSON.stringify({
				verifyRunId: "2026-11-15T10-30-00-000Z-elsewhere",
				pid: 1,
				host: "elsewhere",
				claimedAt: Date.now(),
			})}\n`,
		);
		await expect(
			verify(REVIEW, commits[2] as string, ["F-1"], STILL),
		).rejects.toThrow(
			`Verify refused: verify "2026-11-15T10-30-00-000Z-elsewhere" is already running from "${REVIEW}"; verify against it once it finishes (if no verify is running, delete chain-${REVIEW}.claim-1 from the review's run record)`,
		);
		expect(specs).toHaveLength(0);
		// The refused verify leaves no run folder behind.
		expect(readdirSync(path.join(repo, ".review-panel", "runs"))).toEqual([
			REVIEW,
		]);
	});

	it("the claim stays fresh while the verify runs, however long its seats take", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		try {
			let refusal: unknown;
			await verify(
				REVIEW,
				commits[2] as string,
				["F-1"],
				STILL,
				{},
				{
					onSeat: async () => {
						if (specs.length > 1) {
							return;
						}
						// Ten minutes in one seat: far past the 65 s staleness rule.
						vi.advanceTimersByTime(600_000);
						await verify(REVIEW, commits[3] as string, ["F-1"], STILL).catch(
							(error: unknown) => {
								refusal = error;
							},
						);
					},
				},
			);
			expect(String(refusal)).toContain("is already running from");
			expect(specs).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a verify that stops gives its claim back, so the round can be run again", async () => {
		const controller = new AbortController();
		await expect(
			verify(
				REVIEW,
				commits[2] as string,
				["F-1"],
				STILL,
				{},
				{
					abortSignal: controller.signal,
					onSeat: async () => {
						controller.abort();
					},
				},
			),
		).rejects.toThrow("verify cancelled");
		expect(existsSync(claimFile(REVIEW, 1))).toBe(false);
		const v1 = await verify(REVIEW, commits[2] as string, ["F-1"], STILL);
		expect(loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)[0]?.runId).toBe(
			runIdOf(v1),
		);
	});

	it("comment is never blocked by a chain claim: it reads only signed records", async () => {
		await verify(REVIEW, commits[2] as string, ["F-1"], STILL);
		const v1 = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)[0]?.runId ?? "";
		writeFileSync(
			claimFile(v1, 1),
			`${JSON.stringify({
				verifyRunId: "2026-11-15T12-00-00-000Z-running",
				pid: 1,
				host: "elsewhere",
				claimedAt: Date.now(),
			})}\n`,
		);
		const reply = await commentAction(
			{
				repoDir: repo,
				ownerApproved: true,
				priorRunId: REVIEW,
				dismissed: [],
				lowAdvisory: [],
			},
			{
				deps: {
					env: {},
					home: root,
					diagnose: async () => ({ ready: true, rows: [] }),
					loadConfig: () => config,
					recordKey: () => TEST_RECORD_KEY,
					checkRecordKey: () => undefined,
					postComment: () => ({
						action: "created" as const,
						commentId: 1,
						pr: 12,
						url: "https://github.com/o/r/pull/12#issuecomment-1",
					}),
				},
			},
		);
		expect(reply.content[0]?.text ?? "").not.toContain("refused");
	});
});

describe("the chain refuses what is not one line of signed links", () => {
	it("refuses a link out of place: the first verify of a review is link 1 (F-5)", async () => {
		const out = writeLink("2026-11-15T11-00-00-000Z-out", REVIEW, {
			previousRunId: REVIEW,
			link: 2,
		});
		expect(() => loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toThrow(
			`has verify "${out}" out of place (link 2, expected 1)`,
		);
		await expect(
			verify(out, commits[3] as string, ["F-1"], []),
		).rejects.toThrow("run a new review");
	});

	it("refuses a signed verify that names no review (F-5)", async () => {
		const orphan = writeLink("2026-11-15T11-00-00-000Z-orphan", "", {
			previousRunId: REVIEW,
			link: 1,
		});
		await expect(
			verify(orphan, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${orphan}" names no review; run a new review`,
		);
	});

	it("refuses a signed verify that is no link of the review it names (F-5)", async () => {
		const stray = writeLink("2026-11-15T11-00-00-000Z-stray", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
		});
		// Its signed verification names another review, so it is no link.
		const recordPath = path.join(repo, ".review-panel", "runs", stray);
		writeFileSync(
			path.join(recordPath, "verification.json"),
			JSON.stringify({ priorRunId: "other", keptFindingIds: [], outcomes: [] }),
		);
		signVerifyRecord(recordPath);
		await expect(
			verify(stray, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${stray}" is not a link of review "${REVIEW}"'s verify chain`,
		);
	});

	it("refuses an incomplete verify as the prior (F-5)", async () => {
		const half = writeLink("2026-11-15T11-00-00-000Z-half", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
		});
		rmSync(path.join(repo, ".review-panel", "runs", half, COMPLETE_MARKER));
		await expect(
			verify(half, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(`Verify refused: verify run "${half}" is not complete`);
	});

	it("refuses a prior whose head is not a commit here, or not a commit id (F-5)", async () => {
		const gone = writeLink("2026-11-15T11-00-00-000Z-gone", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
			headOid: "f".repeat(40),
		});
		await expect(
			verify(gone, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${gone}" names head ${"f".repeat(40)}, which is not a commit in this repository; run a new review here`,
		);
		rmSync(path.join(repo, ".review-panel", "runs", gone), {
			recursive: true,
		});
		const junk = writeLink("2026-11-15T11-00-00-000Z-junk", REVIEW, {
			previousRunId: REVIEW,
			link: 1,
			headOid: "HEAD",
		});
		await expect(
			verify(junk, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${junk}" names head (not a commit id), which is not a commit in this repository`,
		);
	});

	it("refuses a final check that is not one: from the review, off the latest head, with kept ids, or with nothing resolved (F-5, S-6)", async () => {
		const final = (prior: string, head: string, kept: string[] = []) =>
			runVerify(
				{
					repoDir: repo,
					config,
					priorRunId: prior,
					headRevision: head,
					keptFindingIds: kept,
					final: true,
				},
				{
					recordKey: TEST_RECORD_KEY,
					runAdvisorySeat: async () => {
						throw new Error("no seat runs for a refused final check");
					},
				},
			);
		await expect(final(REVIEW, commits[1] as string)).rejects.toThrow(
			"Verify refused: the final check runs from a verify; this review has none",
		);
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
		await expect(final(runIdOf(v1), commits[3] as string)).rejects.toThrow(
			`Verify refused: the final check runs at the latest verify's head, ${commits[2]}`,
		);
		await expect(
			final(runIdOf(v1), commits[2] as string, ["F-1"]),
		).rejects.toThrow("Verify refused: the final check takes no kept ids");
		await expect(final(runIdOf(v1), commits[2] as string)).rejects.toThrow(
			"Verify refused: no round resolved anything, so the final check has nothing to check",
		);
		expect(specs).toHaveLength(1);
	});

	it("refuses verifying the review again once it has a verify, naming the latest", async () => {
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
		await expect(
			verify(REVIEW, commits[3] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: review "${REVIEW}" has been verified already; verify against the latest verify, "${runIdOf(v1)}"`,
		);
	});

	it("refuses a stale prior: a verify that is not the latest, naming the latest", async () => {
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
		const v2 = await verify(
			runIdOf(v1),
			commits[3] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
		await expect(
			verify(runIdOf(v1), commits[4] as string, ["F-1"], []),
		).rejects.toThrow(
			`Verify refused: verify run "${runIdOf(v1)}" is not the latest verify of review "${REVIEW}"; verify against the latest verify, "${runIdOf(v2)}"`,
		);
	});

	it("refuses a fork: two links chained from one record", async () => {
		const v1 = await verify(
			REVIEW,
			commits[2] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
		const v2 = await verify(
			runIdOf(v1),
			commits[3] as string,
			["F-1"],
			[{ items: [{ id: "F-1", disposition: "still present" }] }],
		);
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
		writeLink(
			"2026-11-15T11-00-00-000Z-planted",
			REVIEW,
			{
				previousRunId: REVIEW,
				link: 1,
			},
			{ signed: false },
		);
		expect(() =>
			loadChainPrior(repo, "2026-11-15T11-00-00-000Z-planted", TEST_RECORD_KEY),
		).toThrow(
			/Verify refused: verify run "2026-11-15T11-00-00-000Z-planted" is not signed by this owner's record key .*; run a new review/,
		);
		// And it is no link of the chain: the review is still unverified.
		expect(loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toEqual([]);
	});

	it("refuses a gap: a link whose previous record is unsigned or missing", async () => {
		writeLink(
			"2026-11-15T11-00-00-000Z-v1",
			REVIEW,
			{
				previousRunId: REVIEW,
				link: 1,
			},
			{ signed: false },
		);
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

	it("refuses a review whose verifies were written before verify rounds chained: verify and comment say to run a new review", async () => {
		writeLink("2026-11-15T11-00-00-000Z-old-a", REVIEW, {});
		const refusal = `review "${REVIEW}" has verify "2026-11-15T11-00-00-000Z-old-a", written before verify rounds chained; run a new review`;
		expect(() => loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toThrow(
			refusal,
		);
		await expect(
			verify("2026-11-15T11-00-00-000Z-old-a", commits[4] as string, [], []),
		).rejects.toThrow(refusal);
		await expect(
			verify(REVIEW, commits[4] as string, ["F-1"], []),
		).rejects.toThrow(refusal);
		await expect(
			commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: REVIEW,
					dismissed: [],
					lowAdvisory: [],
				},
				{
					deps: {
						env: {},
						home: "/tmp/verify-chain-home",
						recordKey: () => TEST_RECORD_KEY,
						postComment: () => {
							throw new Error("must not post");
						},
					},
				},
			),
		).rejects.toThrow(`comment refused: ${refusal}`);
	});
});
