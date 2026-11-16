import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
import { parseCommand } from "../src/cli/args.js";
import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { runVerify } from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import { loadVerifyChain } from "../src/run/verify-chain.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import {
	findCloseoutPr,
	type PostCloseoutInput,
} from "../src/tool/closeout-post.js";
import type { RoundGhRunner } from "../src/tool/round-post.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * The verify flow as rounds on one PR: each verify chains from the one
 * before, checks only what is still open, and posts a short delta. The
 * close-out card is posted once nothing is open: `verify --close-out`, or
 * `comment` after a verify that left nothing open without it, or when the
 * owner stops the rounds with ids still open.
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

const BASE_CONFIG: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};
let config: Config = BASE_CONFIG;

type Item = { id: string; disposition: "resolved" | "still present" };
type Regression = {
	file: string;
	line: number;
	title: string;
	evidence: string;
	undoes?: string;
};
type Answer = { items: Item[]; regressions?: Regression[]; lost?: boolean };

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
	config = BASE_CONFIG;
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
	writeReview(REVIEW, FINDINGS);
	specs = [];
	answers = [];
	calls = [];
	comments = [];
});

/** A signed, complete review record at commits[1]. */
function writeReview(runId: string, findings: StampedFinding[]): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId: runId,
			baseRef: "main",
			baseOid: commits[0],
			headOid: commits[1],
		}),
	);
	writeFileSync(
		path.join(recordPath, "panel.json"),
		JSON.stringify({
			runId: runId,
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
		JSON.stringify(findings),
	);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
}

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
		// The PR lookup comment makes before its final check, through the
		// same gh script.
		findCloseoutPr: (input: Parameters<typeof findCloseoutPr>[0]) =>
			findCloseoutPr({ ...input, runGh: runGh as never }),
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
					if (answer.lost === true) {
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

/** The manual card, as `comment` would post it. */
async function stopWith(extra: Record<string, unknown>) {
	const bodies: string[] = [];
	const reply = await commentAction(
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
	return { body: bodies[0] ?? "", reply: textOf(reply) };
}

/** The run id a reply names as the latest verify: the final check it ran. */
function latestOf(reply: string): string {
	return /^Latest verify: `([^`]+)`/mu.exec(reply)?.[1] ?? "";
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
		// The final check ran from verify 3; the card is for it.
		expect(card).toContain(
			"**Final check:** verify 4, from the reviewed head to the final head",
		);
		expect(card.split("\n").at(-1)).toBe(
			`<!-- review-panel review=${REVIEW} verify=${latestOf(v3.reply)} -->`,
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

	it("the first verify places every finding: a high or medium left out is refused before any seat runs, a low left out is advisory", async () => {
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW,
					head: commits[2] as string,
					keptFindingIds: ["F-1"],
					dismissed: [{ id: "F-3", reason: "by design" }],
				},
				{ deps: deps() },
			),
		).rejects.toThrow(
			"Verify refused: the first verify places every finding: F-2, F-5 are not kept, dismissed or left as low/advisory",
		);
		expect(specs).toEqual([]);
		const v1 = await verify(
			{
				priorRunId: REVIEW,
				head: commits[2],
				keptFindingIds: ["F-1", "F-2", "F-3", "F-5"],
			},
			{
				items: [
					{ id: "F-1", disposition: "resolved" },
					{ id: "F-2", disposition: "resolved" },
					{ id: "F-3", disposition: "resolved" },
					{ id: "F-5", disposition: "resolved" },
				],
			},
		);
		expect(v1.body).toContain(
			"### Low / advisory (not kept)\n- **F-4** — helper name is vague",
		);
		const verification = JSON.parse(
			readFileSync(
				path.join(repo, ".review-panel", "runs", v1.runId, "verification.json"),
				"utf8",
			),
		) as { lowAdvisory: string[] };
		expect(verification.lowAdvisory).toEqual(["F-4"]);
		expect(v1.body).toContain("**Open after this round:** none");
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

describe("one number per round (S-4)", () => {
	it("a round that did not post keeps its number: the next heading, its V-ids and the card all use the chain link", async () => {
		const v1 = await verify(
			{
				priorRunId: REVIEW,
				head: commits[2],
				keptFindingIds: ["F-1", "F-2", "F-3", "F-5"],
				lowAdvisory: ["F-4"],
				prComment: false,
			},
			{
				items: [
					{ id: "F-1", disposition: "resolved" },
					{ id: "F-2", disposition: "still present" },
					{ id: "F-3", disposition: "resolved" },
					{ id: "F-5", disposition: "resolved" },
				],
			},
		);
		expect(posted()).toEqual([]);
		const v2 = await verify(
			{ priorRunId: v1.runId, head: commits[3] },
			{
				items: [{ id: "F-2", disposition: "still present" }],
				regressions: [NULL_CHECK],
			},
		);
		expect(v2.body.split("\n")[0]).toBe("## Review panel · verify 2");
		expect(v2.body).toContain("- **V2-R1** the new key builder");
		const { body } = await stopWith({});
		expect(body).toContain(
			"- **F-1 [high]** cache key misses the tenant · resolved in verify 1",
		);
	});
});

const CLEAN = "2026-11-15T10-00-00-000Z-main-clean";
describe("a review with no findings (T510)", () => {
	beforeEach(() => {
		writeReview(CLEAN, []);
	});

	it("the first verify needs no kept ids", async () => {
		const v1 = await verify(
			{ priorRunId: CLEAN, head: commits[2] },
			{ items: [] },
		);
		expect(path.basename(v1.runId)).toMatch(/verify/u);
		expect(specs).toHaveLength(1);
		expect(specs[0]?.model).toBe("gpt-5.6-terra");
	});

	it("comment refuses the card while no verify has followed, before any seat or post", async () => {
		await expect(
			commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: CLEAN,
					dismissed: [],
					lowAdvisory: [],
				},
				{ deps: deps() },
			),
		).rejects.toThrow(
			`comment refused: review "${CLEAN}" had no findings and no verify followed it, so there is no close-out card to post`,
		);
		expect(specs).toEqual([]);
		expect(comments).toEqual([]);
	});

	it("once a verify follows, --close-out posts the card for its rounds", async () => {
		const v1 = await verify(
			{ priorRunId: CLEAN, head: commits[2], closeOut: true },
			{ items: [] },
		);
		expect(v1.reply).toContain("PR close-out: posted to #12");
		expect(closeouts()).toHaveLength(1);
	});

	it("once a verify follows, comment posts the card", async () => {
		await verify({ priorRunId: CLEAN, head: commits[2] }, { items: [] });
		const card = await stopWith({ priorRunId: CLEAN });
		expect(card.body).toMatch(/^## Review panel\n/u);
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

	it("without it, a verify that leaves nothing open posts no card, names the command that posts it now and says to pass --close-out next time", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		const v3 = await verify(
			{ priorRunId: v2.runId, head: commits[4] },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		expect(closeouts()).toEqual([]);
		expect(v3.reply).toContain(
			`PR close-out: not posted (not asked for; nothing is open: post it now at this head with \`review-panel comment --prior-run-id ${REVIEW} --owner-approved\`, and pass \`--close-out\` on the last verify next time)`,
		);
		expect(v3.reply).not.toContain("once the owner says");
		// The hinted step works as written (R-6).
		const hinted = /`(review-panel comment [^`]+)`/u.exec(v3.reply)?.[1] ?? "";
		const command = parseCommand(hinted.split(" ").slice(1));
		expect(command.kind).toBe("action");
		const args = (command as { args: Record<string, unknown> }).args;
		const card = await stopWith(args);
		expect(card.body).toMatch(/^## Review panel\n/u);
		expect(card.body).toContain("resolved in verify 3");
	});

	it("without it, under an owner config that asks for approval first, the hint posts the card only after the owner's yes", async () => {
		config = {
			...BASE_CONFIG,
			defaults: { ...BASE_CONFIG.defaults, prComment: "ownerApproved" },
		};
		const v1 = await round1();
		expect(v1.reply).toContain(
			"PR comment: not posted (the owner config asks for approval first)",
		);
		const v2 = await round2(v1.runId, { ownerApproved: true });
		const v3 = await verify(
			{ priorRunId: v2.runId, head: commits[4], ownerApproved: true },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		expect(closeouts()).toEqual([]);
		expect(v3.reply).toContain(
			`PR close-out: not posted (not asked for; nothing is open: the owner config asks for approval first, so after the owner's yes post it at this head with \`review-panel comment --prior-run-id ${REVIEW} --owner-approved\`, and pass \`--close-out\` on the last verify next time)`,
		);
		expect(v3.reply).not.toContain("post it now");
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

describe("a verify that lost a seat", () => {
	it("says on its Open line that it resolved nothing (S-5)", async () => {
		answers.push(
			{ items: [{ id: "F-1", disposition: "resolved" }] },
			{ items: [], lost: true },
		);
		const reply = textOf(
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW,
					head: commits[2] as string,
					keptFindingIds: ["F-1"],
					dismissed: ["F-2", "F-3", "F-5"].map((id) => ({
						id,
						reason: "not in this test",
					})),
				},
				{
					deps: {
						...deps(),
						loadConfig: () => ({
							...config,
							roster: [
								...config.roster,
								{ id: "glm", provider: "ollama", model: "glm-5.2" },
							],
							defaults: { seats: ["terra"], verifySeats: ["terra", "glm"] },
						}),
					},
				},
			),
		);
		expect(reply).toContain("PR comment: posted to #12");
		expect(posted().at(-1)).toContain(
			"**Open after this round:** F-1 · a verify seat was lost, so this round resolved nothing",
		);
	});
});

describe("the final check before the card (S-6)", () => {
	/**
	 * Verify 3 at fix3, from verify 2, with --close-out: F-2 resolved,
	 * nothing left open; then `check` is the final check's answer.
	 */
	async function lastRound(check: Answer, extra: Record<string, unknown> = {}) {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		answers.push({ items: [{ id: "F-2", disposition: "resolved" }] }, check);
		const reply = textOf(
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: v2.runId,
					head: commits[4] as string,
					closeOut: true,
					...extra,
				},
				{ deps: deps() },
			),
		);
		return { reply, runId: recordOf(reply) };
	}
	const UNDONE: Regression = {
		file: "src/cache.ts",
		line: 3,
		title: "the fix2 rename drops the tenant from the key again",
		evidence: "key is built without tenant",
		undoes: "F-1",
	};

	it("--close-out checks the review head to the final head once, with one seat, before the card; when it finds nothing the card posts", async () => {
		const v3 = await lastRound({ items: [] });
		const check = specs[3];
		expect(specs).toHaveLength(4);
		expect(check?.baseRef).toBe(commits[1]);
		expect(check?.expectedIds).toEqual([]);
		expect([...(check?.undoableIds ?? [])].sort()).toEqual([
			"F-1",
			"F-2",
			"F-3",
			"V1-R1",
		]);
		expect(check?.cycle).toBe(4);
		expect(check?.scopingNote).toContain(
			`Final check of the whole change: ${commits[1]}...${commits[4]}`,
		);
		// A clean final check posts no round of its own: the card names it.
		const headings = posted().map((body) => body.split("\n")[0]);
		expect(headings).toEqual([
			"## Review panel · verify 1",
			"## Review panel · verify 2",
			"## Review panel · verify 3",
			"## Review panel · close-out",
		]);
		const final = latestOf(v3.reply);
		expect(final).not.toBe("");
		expect(final).not.toBe(v3.runId);
		const card = closeouts()[0] as string;
		expect(card).toContain(
			"**Final check:** verify 4, from the reviewed head to the final head",
		);
		expect(card).toContain(
			"- **F-1 [high]** cache key misses the tenant · resolved in verify 1",
		);
		expect(card.split("\n").at(-1)).toBe(
			`<!-- review-panel review=${REVIEW} verify=${final} -->`,
		);
	});

	it("a fix that no longer holds blocks the card, and is posted as a regression with an id; the next verify checks it", async () => {
		const v3 = await lastRound({ items: [], regressions: [UNDONE] });
		expect(closeouts()).toEqual([]);
		const check = posted().at(-1) as string;
		expect(check.split("\n").slice(0, 5)).toEqual([
			"## Review panel · verify 4",
			`\`${commits[1]?.slice(0, 7)}\` → \`${commits[4]?.slice(0, 7)}\``,
			"1/1 voted · no kept ids · 1 regression",
			"**Seats:** fix-verification (terra)",
			"**Final check:** the whole change, from the reviewed head, for fixes that no longer hold or conflict",
		]);
		expect(check).toContain("**Open after this round:** V4-R1");
		expect(check).toContain("V4-R1");
		expect(check).toContain("undoes");
		expect(v3.reply).toContain("PR close-out: not posted (1 regression)");
		const final = latestOf(v3.reply);
		const v5 = await verify(
			{ priorRunId: final, head: commits[5] },
			{ items: [{ id: "V4-R1", disposition: "resolved" }] },
		);
		expect(specs.at(-1)?.expectedIds).toEqual(["V4-R1"]);
		expect(specs.at(-1)?.baseRef).toBe(commits[4]);
		expect(v5.body.split("\n")[0]).toBe("## Review panel · verify 5");
	});

	it("a lost seat blocks the card, and the reply names comment, which checks again and posts it", async () => {
		const v3 = await lastRound({ items: [], lost: true });
		expect(closeouts()).toEqual([]);
		expect(v3.reply).toContain(
			"PR close-out: not posted (lost verify coverage: terra/fix-verification)",
		);
		const hinted =
			/`(review-panel comment [^`]+)`/u.exec(
				v3.reply.split("\n").find((line) => line.startsWith("Final check:")) ??
					"",
			)?.[1] ?? "";
		expect(hinted).toBe(
			`review-panel comment --prior-run-id ${REVIEW} --owner-approved`,
		);
		const command = parseCommand(hinted.split(" ").slice(1));
		answers.push({ items: [] });
		const card = await stopWith(
			(command as { args: Record<string, unknown> }).args,
		);
		expect(specs).toHaveLength(5);
		expect(specs[4]?.baseRef).toBe(commits[1]);
		expect(card.body).toContain(
			"**Final check:** verify 5, from the reviewed head to the final head",
		);
		expect(card.body).not.toContain("### Open");
	});

	it("the seat is the owner's first verify seat, never one the caller names", async () => {
		const owner = (): Config => ({
			roster: [
				...config.roster,
				{ id: "glm", provider: "ollama", model: "glm-5.2" },
			],
			defaults: { seats: ["terra"], verifySeats: ["glm", "terra"] },
		});
		answers.push(
			{
				items: [
					{ id: "F-1", disposition: "resolved" },
					{ id: "F-2", disposition: "resolved" },
					{ id: "F-3", disposition: "resolved" },
					{ id: "F-5", disposition: "resolved" },
				],
			},
			{ items: [] },
		);
		await verifyAction(
			{
				repoDir: repo,
				priorRunId: REVIEW,
				head: commits[2] as string,
				keptFindingIds: ["F-1", "F-2", "F-3", "F-5"],
				seats: ["terra"],
				closeOut: true,
			},
			{ deps: { ...deps(), loadConfig: owner } },
		);
		expect(specs.map((spec) => spec.model)).toEqual([
			"gpt-5.6-terra",
			"glm-5.2",
		]);
		expect(closeouts()).toHaveLength(1);
	});

	it("is not run when nothing was resolved, or when the tip already is a final check with no lost seat", async () => {
		// No verify: nothing resolved, so comment runs no seat.
		await stopWith({
			dismissed: ["F-1", "F-2", "F-3", "F-5"].map((id) => ({
				id,
				reason: "by design",
			})),
		});
		expect(specs).toHaveLength(0);
		// After a --close-out that ran it, comment runs no seat again.
		await lastRound({ items: [] });
		expect(specs).toHaveLength(4);
		const card = await stopWith({});
		expect(specs).toHaveLength(4);
		expect(card.body).toContain("**Final check:** verify 4");
	});

	it("comment runs it when the owner stops with ids open: what it finds is open on the card, and the card still posts", async () => {
		const v1 = await round1();
		answers.push({ items: [], regressions: [UNDONE] });
		const card = await stopWith({});
		expect(specs).toHaveLength(2);
		expect(specs[1]?.baseRef).toBe(commits[1]);
		expect([...(specs[1]?.undoableIds ?? [])].sort()).toEqual(["F-1", "F-3"]);
		const lines = card.body.split("\n");
		const open = lines.indexOf("### Open (not resolved)");
		expect(lines.slice(open + 1, open + 5)).toEqual([
			"- **F-2 [high]** token compared with ===",
			"- **F-5 [medium]** log line prints the request body",
			"- **V1-R1 [regression]** the new key builder drops the null check",
			"- **V2-R1 [regression]** the fix2 rename drops the tenant from the key again (undoes `F-1`)",
		]);
		expect(card.body).toContain("**Final check:** verify 2");
		expect(v1.runId).not.toBe("");
	});

	it("comment, when nothing was open, refuses a card the final check found something in, naming it and the latest verify; run again, it lists it as open", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		await verify(
			{ priorRunId: v2.runId, head: commits[4] },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		answers.push({ items: [], regressions: [UNDONE] });
		let refusal = "";
		await stopWith({}).catch((error: unknown) => {
			refusal = String(error);
		});
		const final = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY).at(-1);
		expect(final?.final).toBe(true);
		expect(refusal).toContain(
			`comment refused: the final check, verify 4, reported V4-R1; verify a fix against the latest verify, "${final?.runId}", or run comment again to post the card with it open`,
		);
		const card = await stopWith({});
		expect(specs).toHaveLength(4);
		expect(card.body).toContain("### Open (not resolved)");
		expect(card.body).toContain("V4-R1");
	});

	it("comment, when nothing was open, refuses after a lost final-check seat, and run again it checks again", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		await verify(
			{ priorRunId: v2.runId, head: commits[4] },
			{ items: [{ id: "F-2", disposition: "resolved" }] },
		);
		answers.push({ items: [], lost: true });
		await expect(stopWith({})).rejects.toThrow(
			"comment refused: the final check, verify 4, lost its seat, so nothing was checked; run comment again to check again",
		);
		answers.push({ items: [] });
		const card = await stopWith({});
		expect(specs).toHaveLength(5);
		expect(card.body).toContain(
			"**Final check:** verify 5, from the reviewed head to the final head",
		);
	});

	it("comment with ids open and a lost final-check seat posts the card, saying nothing was checked", async () => {
		await round1();
		answers.push({ items: [], lost: true });
		const card = await stopWith({});
		expect(card.body).toContain(
			"**Final check:** verify 2 lost its seat, so nothing was checked",
		);
		expect(card.body).toContain("terra/fix-verification (verify)");
		expect(card.body).not.toContain("from the reviewed head to the final head");
	});

	it("comment finds the PR before the final check: with no PR to post to, no seat runs and no chain link is written (L-1)", async () => {
		const v1 = await round1();
		const noPr: RoundGhRunner = (args, options) =>
			/commits\/[0-9a-f]+\/pulls/.test(args.join(" "))
				? "[]"
				: runGh(args, options);
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
						...deps(),
						findCloseoutPr: (input: Parameters<typeof findCloseoutPr>[0]) =>
							findCloseoutPr({ ...input, runGh: noPr as never }),
						postComment: () => {
							throw new Error("nothing is posted");
						},
					},
				},
			),
		).rejects.toThrow("comment refused: no open PR has this head");
		expect(specs).toHaveLength(1);
		expect(
			loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY).map((row) => row.runId),
		).toEqual([v1.runId]);
	});

	it("comment names the final check as the latest verify when the post fails after the check", async () => {
		await round1();
		answers.push({ items: [] });
		let refusal = "";
		await commentAction(
			{
				repoDir: repo,
				ownerApproved: true,
				priorRunId: REVIEW,
				dismissed: [],
				lowAdvisory: [],
			},
			{
				deps: {
					...deps(),
					postComment: () => {
						throw new Error("comment refused: PR #7 is closed");
					},
				},
			},
		).catch((error: unknown) => {
			refusal = String(error);
		});
		const final = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY).at(-1);
		expect(final?.final).toBe(true);
		expect(refusal).toContain(
			`comment refused: PR #7 is closed; the final check is recorded: the latest verify is now "${final?.runId}"`,
		);
	});

	it("comment refuses before any seat runs what it would refuse anyway, and says why while a verify runs from the tip", async () => {
		const v1 = await round1();
		await expect(
			stopWith({ dismissed: [{ id: "F-1", reason: "no" }] }),
		).rejects.toThrow("comment refused: F-1 was resolved in a verify round");
		expect(specs).toHaveLength(1);
		writeFileSync(
			path.join(
				repo,
				".review-panel",
				"runs",
				REVIEW,
				`chain-${v1.runId}.claim-1`,
			),
			`${JSON.stringify({
				verifyRunId: "2026-11-15T12-00-00-000Z-running",
				pid: 1,
				host: "elsewhere",
				claimedAt: Date.now(),
			})}\n`,
		);
		await expect(stopWith({})).rejects.toThrow(
			`comment refused: verify "2026-11-15T12-00-00-000Z-running" is already running from "${v1.runId}"; verify against it once it finishes`,
		);
		expect(specs).toHaveLength(1);
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
		const reply = await commentAction(
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
		return { body: bodies[0] ?? "", head: heads[0], reply: textOf(reply) };
	}

	it("lists what is still open, from the latest verify, never as fixed", async () => {
		const v1 = await round1();
		const v2 = await round2(v1.runId);
		const { body, head, reply } = await stop();
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
		// The final check comment ran from verify 2 is the card's verify.
		const final = latestOf(reply);
		expect(final).not.toBe(v2.runId);
		expect(lines).toContain(
			"**Final check:** verify 3, from the reviewed head to the final head",
		);
		expect(lines.at(-1)).toBe(
			`<!-- review-panel review=${REVIEW} verify=${final} -->`,
		);
	});

	it("with no verify, refuses a high or medium nobody placed, naming them", async () => {
		await expect(
			stop({ dismissed: [{ id: "F-1", reason: "by design" }] }),
		).rejects.toThrow(
			"comment refused: F-2, F-3, F-5 were never verified: verify them, or dismiss each with a reason",
		);
	});

	it("the card's Open section and each verify's Open line name the same ids", async () => {
		const openLine = (body: string) =>
			/^\*\*Open after this round:\*\* (.*)$/mu.exec(body)?.[1] ?? "";
		const openSection = (body: string) => {
			const lines = body.split("\n");
			const at = lines.indexOf("### Open (not resolved)");
			if (at === -1) {
				return "none";
			}
			const rows: string[] = [];
			for (const line of lines.slice(at + 1)) {
				const id = /^- \*\*([^ *]+)/u.exec(line)?.[1];
				if (id === undefined) {
					break;
				}
				rows.push(id);
			}
			return rows.sort().join(", ");
		};
		const sorted = (line: string) => line.split(", ").sort().join(", ");
		const v1 = await round1();
		const first = await stop();
		expect(openSection(first.body)).toBe(sorted(openLine(v1.body)));
		// The next verify chains from the final check comment ran.
		const v2 = await round2(latestOf(first.reply));
		expect(openSection((await stop()).body)).toBe(sorted(openLine(v2.body)));
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

	it("refuses judgment on an id a round already dismissed or left as low/advisory: only open ids (R-7)", async () => {
		const v1 = await round1();
		await round2(v1.runId);
		await expect(
			stop({ dismissed: [{ id: "F-5", reason: "a new reason" }] }),
		).rejects.toThrow(
			"comment refused: F-5 was dismissed in verify 2; name only ids still open",
		);
		await expect(stop({ lowAdvisory: ["F-4"] })).rejects.toThrow(
			"comment refused: F-4 was left as low/advisory in verify 1; name only ids still open",
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
