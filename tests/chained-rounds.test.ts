import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ActionDependencies,
	type ActionResult,
	commentAction,
	parseVerifyArguments,
	verifyAction,
} from "../src/actions/actions.js";
import { coerceCallArguments } from "../src/actions/call.js";
import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { runVerify } from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import type { PostCloseoutInput } from "../src/tool/closeout-post.js";
import type { RoundGhRunner } from "../src/tool/round-post.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * The verify flow as rounds on one PR: each verify chains from the one
 * before, checks only what is still open, and posts a short delta. The
 * close-out card is posted once, only when asked: `verify --close-out` when
 * nothing is left open, or `comment` when the owner stops the rounds.
 * Nothing here reaches GitHub: gh is a script.
 */

const REPO_SLUG = "smarzban/demo";
const REVIEW = "2026-11-15T10-00-00-000Z-main-review";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

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
		finding: { file: "src/cache.ts", line: 3, severity, title, evidence: "e" },
	};
}

const FINDINGS = [
	finding("F-1", "high", "cache key misses the tenant"),
	finding("F-2", "high", "token compared with ==="),
	finding("F-3", "medium", "retry loop never backs off"),
	finding("F-4", "low", "helper name is vague"),
	finding("F-5", "medium", "log line prints the request body"),
];

const config: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

type Item = { id: string; disposition: "resolved" | "still present" };
type Regression = {
	file: string;
	line: number;
	title: string;
	evidence: string;
	undoes?: string;
};
type Answer = { items: Item[]; regressions?: Regression[] };

let root: string;
let repo: string;
let commits: string[];
let specs: SeatSpec[];
let answers: Answer[];
let calls: Array<{ args: readonly string[]; input?: string }>;
let comments: Array<{
	id: number;
	html_url: string;
	body: string;
	user: { login: string };
}>;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "chained-rounds-"));
	repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "rounds@example.test"]);
	git(repo, ["config", "user.name", "Rounds Test"]);
	commits = [];
	for (const name of ["base", "head", "fix1", "fix2", "fix3", "fix4"]) {
		writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", name, "--quiet"]);
		commits.push(git(repo, ["rev-parse", "HEAD"]));
	}
	repo = realpathSync(repo);
	const recordPath = path.join(repo, ".review-panel", "runs", REVIEW);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId: REVIEW,
			baseRef: "main",
			baseOid: commits[0],
			headOid: commits[1],
		}),
	);
	writeFileSync(
		path.join(recordPath, "panel.json"),
		JSON.stringify({
			runId: REVIEW,
			baseRef: "main",
			seats: [
				{
					rosterId: "terra",
					lens: "holistic",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
			],
		}),
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify(FINDINGS),
	);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
	specs = [];
	answers = [];
	calls = [];
	comments = [];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** gh as a script: PR 12 is open at whatever head is asked about. */
const runGh: RoundGhRunner = (args, options) => {
	calls.push({
		args: [...args],
		...(options?.input === undefined ? {} : { input: options.input }),
	});
	const joined = args.join(" ");
	if (args[0] === "api" && args[1] === "user") {
		return "saeed\n";
	}
	if (args[0] === "repo" && args[1] === "view") {
		return `${REPO_SLUG}\n`;
	}
	const head = /commits\/([0-9a-f]+)\/pulls/.exec(joined);
	if (head !== null) {
		return JSON.stringify([
			{ number: 12, state: "open", head: { sha: head[1] } },
		]);
	}
	if (/issues\/12\/comments/.test(joined) && joined.includes("POST")) {
		const id = 100 + comments.length + 1;
		const body = (JSON.parse(options?.input ?? "{}") as { body: string }).body;
		const html_url = `https://github.com/${REPO_SLUG}/pull/12#issuecomment-${id}`;
		comments.push({ id, html_url, body, user: { login: "saeed" } });
		return JSON.stringify({ id, html_url });
	}
	if (/issues\/12\/comments/.test(joined)) {
		return JSON.stringify(comments);
	}
	throw new Error(`unexpected gh ${joined}`);
};

function deps(): ActionDependencies {
	return {
		env: {},
		home: "/tmp/chained-rounds-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh,
		// The real verify, with each seat's answer scripted.
		runVerify: (input, options) =>
			runVerify(input, {
				...options,
				pinSnapshot: () => ({
					worktreePath: repo,
					release: () => ({ ok: true }),
				}),
				runAdvisorySeat: async (spec) => {
					specs.push(spec as SeatSpec);
					const answer = answers.shift() ?? { items: [] };
					return {
						outcome: {
							kind: "verification",
							result: {
								items: answer.items.map((item) =>
									item.disposition === "resolved"
										? {
												...item,
												evidence: {
													file: "src/cache.ts",
													explanation: `${item.id} is fixed at line 3`,
												},
											}
										: item,
								),
								regressions: (answer.regressions ?? []).map((row) => ({
									...row,
									regressionId: "regression-1-1",
								})),
							},
						},
					} as never;
				},
			}),
	};
}

function textOf(result: ActionResult): string {
	return result.content[0]?.text ?? "";
}

/** The record id of the verify a reply reports. */
function recordOf(reply: string): string {
	const found = /^Record: `(.+)`$/mu.exec(reply);
	expect(found).not.toBeNull();
	return path.basename(found?.[1] ?? "");
}

function posted(): string[] {
	return comments.map((row) => row.body);
}

function closeouts(): string[] {
	return posted().filter((body) =>
		body.startsWith("## Review panel · close-out"),
	);
}

async function verify(args: Record<string, unknown>, answer: Answer) {
	answers.push(answer);
	const reply = textOf(
		await verifyAction(
			{ repoDir: repo, ...(args as { priorRunId: string; head: string }) },
			{ deps: deps() },
		),
	);
	return { reply, runId: recordOf(reply), body: posted().at(-1) ?? "" };
}

const NULL_CHECK: Regression = {
	file: "src/cache.ts",
	line: 9,
	title: "the new key builder drops the null check",
	evidence: "tenant can be undefined here",
};

/** Verify 1 at fix1: F-1 and F-3 resolved, F-2 and F-5 not, one regression. */
async function round1() {
	return await verify(
		{
			priorRunId: REVIEW,
			head: commits[2],
			keptFindingIds: ["F-1", "F-2", "F-3", "F-5"],
			lowAdvisory: ["F-4"],
		},
		{
			items: [
				{ id: "F-1", disposition: "resolved" },
				{ id: "F-2", disposition: "still present" },
				{ id: "F-3", disposition: "resolved" },
				{ id: "F-5", disposition: "still present" },
			],
			regressions: [NULL_CHECK],
		},
	);
}

/** Verify 2 at fix2: chains from verify 1, F-5 dismissed, F-2 still present. */
async function round2(v1: string, extra: Record<string, unknown> = {}) {
	return await verify(
		{
			priorRunId: v1,
			head: commits[3],
			dismissed: [{ id: "F-5", reason: "the body is redacted upstream" }],
			...extra,
		},
		{
			items: [
				{ id: "F-2", disposition: "still present" },
				{ id: "V1-R1", disposition: "resolved" },
			],
		},
	);
}

describe("three chained verify rounds on one PR", () => {
	it("each round checks only what is open and posts a delta; the close-out posts once, at the end, when asked", async () => {
		const v1 = await round1();
		expect(v1.body.split("\n").slice(0, 6)).toEqual([
			"## Review panel · verify 1",
			`\`${commits[1]?.slice(0, 7)}\` → \`${commits[2]?.slice(0, 7)}\``,
			"1/1 voted · F-1 resolved, F-2 still present, F-3 resolved, F-5 still present · 1 regression",
			"**Seats:** fix-verification (terra)",
			"**Open after this round:** F-2, F-5, V1-R1",
			"",
		]);
		expect(v1.body).toContain(
			"- **V1-R1** the new key builder drops the null check (`src/cache.ts:9`)",
		);

		// Verify 2 names no kept ids: it checks the open set, less F-5,
		// which the caller dismisses now, from verify 1's head.
		const v2 = await round2(v1.runId);
		expect(specs[1]?.expectedIds).toEqual(["F-2", "V1-R1"]);
		expect(specs[1]?.baseRef).toBe(commits[2]);
		expect(v2.body.split("\n").slice(0, 5)).toEqual([
			"## Review panel · verify 2",
			`\`${commits[2]?.slice(0, 7)}\` → \`${commits[3]?.slice(0, 7)}\``,
			"1/1 voted · F-2 still present, V1-R1 resolved · no regressions",
			"**Seats:** fix-verification (terra)",
			"**Open after this round:** F-2",
		]);
		expect(v2.body).toContain(
			"- **F-5** — log line prints the request body — the body is redacted upstream",
		);
		// Nothing mid-way posts a close-out.
		expect(closeouts()).toEqual([]);
		expect(v2.reply).not.toContain("PR close-out");

		const v3 = await verify(
			{ priorRunId: v2.runId, head: commits[4], closeOut: true },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		expect(specs[2]?.expectedIds).toEqual(["F-2"]);
		expect(v3.reply).toMatch(/^PR close-out: posted to #12/mu);
		expect(closeouts()).toHaveLength(1);
		const card = closeouts()[0] as string;
		const list = card.split("\n").filter((line) => line.startsWith("- "));
		expect(list).toEqual([
			"- **F-1 [high]** cache key misses the tenant · resolved in verify 1",
			"- **F-2 [high]** token compared with === · resolved in verify 3",
			"- **F-3 [medium]** retry loop never backs off · resolved in verify 1",
			"- **V1-R1 [regression]** the new key builder drops the null check · resolved in verify 2",
			"- **F-5** log line prints the request body — the body is redacted upstream",
			"- **F-4** helper name is vague",
		]);
		expect(card).toContain(
			"**5 findings** (2 high, 2 medium, 1 low) · **4 resolved** in 3 verify rounds · 1 dismissed · 1 left as low/advisory",
		);
		expect(card).not.toMatch(/fixed|ready to merge/iu);
		expect(card.split("\n").at(-1)).toBe(
			`<!-- review-panel review=${REVIEW} verify=${v3.runId} -->`,
		);
	});

	it("an id resolved in an earlier round is not judged again", async () => {
		const v1 = await round1();
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: v1.runId,
					head: commits[3] as string,
					keptFindingIds: ["F-1"],
				},
				{ deps: deps() },
			),
		).rejects.toThrow(
			`Verify refused: F-1 was resolved by verify run "${v1.runId}"; it is not judged again`,
		);
	});

	it("the first verify of a review still needs its kept ids", async () => {
		await expect(
			verifyAction(
				{ repoDir: repo, priorRunId: REVIEW, head: commits[2] as string },
				{ deps: deps() },
			),
		).rejects.toThrow(
			'Verify refused: keptFindingIds is required for the first verify of a review (pass "" for none)',
		);
	});

	it("verifying against an earlier verify, or the review again, is refused with the latest named", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		await expect(
			verifyAction(
				{ repoDir: repo, priorRunId: v1.runId, head: commits[4] as string },
				{ deps: deps() },
			),
		).rejects.toThrow(`verify against the latest verify, "${v2.runId}"`);
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW,
					head: commits[4] as string,
					keptFindingIds: ["F-2"],
				},
				{ deps: deps() },
			),
		).rejects.toThrow(`verify against the latest verify, "${v2.runId}"`);
	});
});

describe("--close-out", () => {
	it("with ids still open: posts the verify comment, and says why the card is not posted", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId, { closeOut: true });
		expect(v2.reply).toContain(
			"PR close-out: not posted (F-2 is still present)",
		);
		expect(closeouts()).toEqual([]);
	});

	it("with an older id still open that this round did not check: the card is not posted", async () => {
		const v1 = await round1();
		const v2 = await verify(
			{
				priorRunId: v1.runId,
				head: commits[3],
				keptFindingIds: ["V1-R1"],
				dismissed: [{ id: "F-5", reason: "the body is redacted upstream" }],
				closeOut: true,
			},
			{ items: [{ id: "V1-R1", disposition: "resolved" }] },
		);
		expect(v2.reply).toContain("PR close-out: not posted (still open: F-2)");
		expect(closeouts()).toEqual([]);
	});

	it("without it, a verify that leaves nothing open posts no card and says how to ask for one", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		const v3 = await verify(
			{ priorRunId: v2.runId, head: commits[4] },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		expect(closeouts()).toEqual([]);
		expect(v3.reply).toContain(
			"PR close-out: not posted (not asked for; nothing is open, so pass --close-out on a verify, or post it with comment once the owner says the rounds are done)",
		);
	});

	it("without it, says nothing is open only when the card could post: a medium no round kept is open", async () => {
		// Verify 1 keeps everything but F-5, a medium, and resolves it all.
		const v1 = await verify(
			{
				priorRunId: REVIEW,
				head: commits[2],
				keptFindingIds: ["F-1", "F-2", "F-3"],
				lowAdvisory: ["F-4"],
			},
			{
				items: [
					{ id: "F-1", disposition: "resolved" },
					{ id: "F-2", disposition: "resolved" },
					{ id: "F-3", disposition: "resolved" },
				],
			},
		);
		expect(v1.reply).not.toContain("PR close-out");
		const v2 = await verify(
			{ priorRunId: v1.runId, head: commits[3], closeOut: true },
			{ items: [] },
		);
		expect(v2.reply).toContain("PR close-out: not posted (still open: F-5)");
	});

	it("is taken by the parser and by a call object", () => {
		expect(
			parseVerifyArguments(
				coerceCallArguments({
					priorRunId: "v-1",
					head: "HEAD",
					closeOut: "true",
				}),
			),
		).toEqual({ priorRunId: "v-1", head: "HEAD", closeOut: true });
		expect(() =>
			parseVerifyArguments({ priorRunId: "v", head: "H", closeOut: "yes" }),
		).toThrow("closeOut must be true or false");
	});
});

describe("the undo guard on a PR", () => {
	it("a later change that reverts an earlier fix is a regression naming that id", async () => {
		const v1 = await round1();
		const v2 = await verify(
			{
				priorRunId: v1.runId,
				head: commits[3],
				dismissed: [{ id: "F-5", reason: "the body is redacted upstream" }],
			},
			{
				items: [
					{ id: "F-2", disposition: "resolved" },
					{ id: "V1-R1", disposition: "resolved" },
				],
				regressions: [
					{
						file: "src/cache.ts",
						line: 3,
						title: "the key is built without the tenant again",
						evidence: "the F-2 change restored the old key builder",
						undoes: "F-1",
					},
				],
			},
		);
		expect(specs[1]?.undoableIds).toEqual(["F-1", "F-3"]);
		expect(v2.body).toContain(
			"- **V2-R1** the key is built without the tenant again (`src/cache.ts:3`) · undoes `F-1`",
		);
		expect(v2.body).toContain("**Open after this round:** V2-R1");
	});
});

describe("comment when the owner stops the rounds", () => {
	async function stop(extra: Record<string, unknown> = {}) {
		const bodies: string[] = [];
		const heads: string[] = [];
		await commentAction(
			{
				repoDir: repo,
				ownerApproved: true,
				priorRunId: REVIEW,
				dismissed: [],
				lowAdvisory: [],
				...extra,
			},
			{
				deps: {
					...deps(),
					postComment: (input: PostCloseoutInput) => {
						bodies.push(input.body);
						heads.push(input.headOid);
						return {
							action: "created" as const,
							commentId: 1,
							pr: 12,
							url: `https://github.com/${REPO_SLUG}/pull/12#issuecomment-1`,
						};
					},
				},
			},
		);
		return { body: bodies[0] ?? "", head: heads[0] };
	}

	it("lists what is still open, from the latest verify, never as fixed", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		const { body, head } = await stop();
		expect(head).toBe(commits[3]);
		const lines = body.split("\n");
		expect(lines).toContain(
			"**5 findings** (2 high, 2 medium, 1 low) · **3 resolved** in 2 verify rounds · **1 open** · 1 dismissed · 1 left as low/advisory",
		);
		const open = lines.indexOf("### Open (not resolved)");
		expect(open).toBeGreaterThan(0);
		expect(lines[open + 1]).toBe("- **F-2 [high]** token compared with ===");
		expect(lines).toContain(
			"- **V1-R1 [regression]** the new key builder drops the null check · resolved in verify 2",
		);
		expect(body).not.toMatch(/fixed|ready to merge/iu);
		expect(lines.at(-1)).toBe(
			`<!-- review-panel review=${REVIEW} verify=${v2.runId} -->`,
		);
	});

	it("lists a finding no verify kept as open, not verified", async () => {
		const { body } = await stop({ lowAdvisory: ["F-4"] });
		expect(body).toContain(
			"- **F-1 [high]** cache key misses the tenant · not verified",
		);
		expect(body).toContain("**4 open**");
	});

	it("takes the owner's judgment on top of the chain: an open id dismissed now is dismissed, not open", async () => {
		const v1 = await round1();
		await round2(v1.runId);
		const { body } = await stop({
			dismissed: [{ id: "F-2", reason: "the owner accepts the risk" }],
		});
		expect(body).not.toContain("### Open");
		expect(body).toContain(
			"- **F-2** token compared with === — the owner accepts the risk",
		);
		// F-5 keeps the reason verify 2 recorded.
		expect(body).toContain(
			"- **F-5** log line prints the request body — the body is redacted upstream",
		);
	});

	it("refuses to dismiss an id a round resolved", async () => {
		const v1 = await round1();
		await expect(
			stop({ dismissed: [{ id: "F-1", reason: "no" }] }),
		).rejects.toThrow(
			"comment refused: F-1 was resolved in a verify round; it cannot also be kept out",
		);
		expect(v1.runId).not.toBe("");
	});

	it("refuses a verify that is not the latest, naming the latest", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		await expect(stop({ verifyRunId: v1.runId })).rejects.toThrow(
			`comment refused: verify run "${v1.runId}" is not the latest verify of review "${REVIEW}"; pass the latest, "${v2.runId}"`,
		);
	});
});
