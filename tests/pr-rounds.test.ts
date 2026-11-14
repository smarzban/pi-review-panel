import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type ActionDependencies,
	type ActionResult,
	parseReviewArguments,
	parseVerifyArguments,
	reviewAction,
	verifyAction,
} from "../src/actions/actions.js";
import type { Config } from "../src/config/schema.js";
import { validateConfig } from "../src/config/schema.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type { RunVerifyResult } from "../src/run/run-verify.js";
import type { PlannedSeat, StampedFinding } from "../src/run/types.js";
import { parseJsonPages } from "../src/tool/closeout-post.js";
import { postedCode, postedText } from "../src/tool/posted-text.js";
import { createReviewPanelTool } from "../src/tool/review-panel.js";
import {
	assertVerifyJudgment,
	CLOSEOUT_POSTED_MARKER,
	defaultRunGh,
	type RoundGhRunner as GhRunner,
	GITHUB_COMMENT_LIMIT,
	githubSafe,
	ROUND_DEADLINE_MS,
	ROUND_POSTED_MARKER,
} from "../src/tool/round-post.js";
import { TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * Each review and verify round posts to the open PR whose head is the run's
 * head, by default, through the injected gh runner. Nothing here reaches
 * GitHub: the runner is a script, and a failing `gh` stands first on PATH.
 */

const REPO_SLUG = "smarzban/demo";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withRepository(
	test: (repo: string, headOid: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "rounds-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "rounds@example.test"]);
	git(repo, ["config", "user.name", "Rounds Test"]);
	writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	writeFileSync(path.join(repo, "head.txt"), "head\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "head", "--quiet"]);
	const real = realpathSync(repo);
	return test(real, git(real, ["rev-parse", "HEAD"])).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

function configWith(prComment?: "auto" | "ownerApproved"): Config {
	return {
		roster: [
			{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
		],
		defaults: {
			seats: ["terra", "claude"],
			...(prComment === undefined ? {} : { prComment }),
		},
	};
}

type GhCall = { args: readonly string[]; input?: string; cwd?: string };

type GhScript = {
	/** PRs the commits/<oid>/pulls endpoint returns. */
	pulls?: unknown[];
	/** Comments already on the PR. */
	comments?: unknown[];
	/** Throw this from every call. */
	fail?: Error;
	login?: string;
	/** Raw stdout for the comment listing, such as several pages. */
	commentsRaw?: string;
	/** What `repos/<repo>/pulls/<n>` answers, by PR number; absent is a 404. */
	prs?: Record<number, unknown>;
	/** Throw this from the Nth POST (1-based). */
	failPost?: { at: number; error: Error };
	/** The html_url a new comment answers with. */
	htmlUrl?: string;
	/** Answer each call after this many milliseconds. */
	delayMs?: number;
};

function fakeGh(script: GhScript = {}): { calls: GhCall[]; runGh: GhRunner } {
	const calls: GhCall[] = [];
	let nextId = 100;
	let postCount = 0;
	const answer = (
		args: readonly string[],
		options?: { cwd?: string; input?: string },
	) => {
		calls.push({
			args: [...args],
			...(options?.input === undefined ? {} : { input: options.input }),
			...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
		});
		if (script.fail !== undefined) {
			throw script.fail;
		}
		const joined = args.join(" ");
		if (args[0] === "api" && args[1] === "user") {
			return `${script.login ?? "saeed"}\n`;
		}
		if (args[0] === "repo" && args[1] === "view") {
			return `${REPO_SLUG}\n`;
		}
		if (/commits\/[0-9a-f]+\/pulls/.test(joined)) {
			return JSON.stringify(script.pulls ?? []);
		}
		const onePr = /repos\/[\w.-]+\/[\w.-]+\/pulls\/(\d+)$/.exec(joined);
		if (onePr !== null) {
			const row = script.prs?.[Number(onePr[1])];
			if (row === undefined) {
				throw Object.assign(new Error("Command failed: gh api"), {
					stderr: "gh: Not Found (HTTP 404)\n",
				});
			}
			return JSON.stringify(row);
		}
		if (/issues\/\d+\/comments/.test(joined) && joined.includes("POST")) {
			postCount += 1;
			if (script.failPost !== undefined && script.failPost.at === postCount) {
				throw script.failPost.error;
			}
			nextId += 1;
			const pr = /issues\/(\d+)\//.exec(joined)?.[1];
			return JSON.stringify({
				id: nextId,
				html_url:
					script.htmlUrl ??
					`https://github.com/${REPO_SLUG}/pull/${pr}#issuecomment-${nextId}`,
			});
		}
		if (/issues\/\d+\/comments/.test(joined)) {
			return script.commentsRaw ?? JSON.stringify(script.comments ?? []);
		}
		throw new Error(`unexpected gh ${joined}`);
	};
	const delay = script.delayMs;
	const runGh: GhRunner =
		delay === undefined
			? answer
			: (args, options) =>
					new Promise<string>((resolve, reject) => {
						setTimeout(() => {
							try {
								resolve(answer(args, options));
							} catch (error) {
								reject(error);
							}
						}, delay);
					});
	return { calls, runGh };
}

function openPr(number: number, sha: string) {
	return { number, state: "open", head: { sha } };
}

function posts(calls: GhCall[]): GhCall[] {
	return calls.filter((call) => call.args.includes("POST"));
}

function bodyOf(call: GhCall | undefined): string {
	expect(call?.input).toBeDefined();
	return (JSON.parse(call?.input ?? "{}") as { body: string }).body;
}

function textOf(result: ActionResult): string {
	expect(result.content).toHaveLength(1);
	return result.content[0]?.text ?? "";
}

function deps(
	runGh: GhRunner,
	overrides: ActionDependencies = {},
	config: Config = configWith(),
): ActionDependencies {
	return {
		env: {},
		home: "/tmp/rounds-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh,
		...overrides,
	};
}

type Row = {
	id: string;
	severity: "high" | "medium" | "low";
	title?: string;
	file?: string;
	evidence?: string;
};

function stamped(row: Row): StampedFinding {
	return {
		id: row.id,
		seat: {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "holistic",
		},
		finding: {
			file: row.file ?? "src/a.ts",
			line: 3,
			severity: row.severity,
			title: row.title ?? `${row.id} title`,
			evidence: row.evidence ?? `${row.id} evidence`,
		},
	} as StampedFinding;
}

/** A fake runReview that writes findings.json the way a real run does. */
function reviewRun(repo: string, runId: string, rows: Row[]) {
	return async (runConfig: { seats: PlannedSeat[] }) => {
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		mkdirSync(recordPath, { recursive: true });
		writeFileSync(
			path.join(recordPath, "findings.json"),
			JSON.stringify(rows.map(stamped)),
		);
		return {
			recordPath,
			outcomes: runConfig.seats.map((seat) => ({
				seat,
				outcome: {
					kind: "voted" as const,
					findings: rows.map((row) => stamped(row).finding),
				},
			})),
		} as unknown as RunReviewResult;
	};
}

/** A complete review record on disk, as verify and the close-out read it. */
function writeReviewRecord(repo: string, runId: string, rows: Row[]): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "panel.json"),
		JSON.stringify({
			runId,
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
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId,
			baseRef: "main",
			baseOid: "a".repeat(40),
			headOid: "b".repeat(40),
		}),
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify(rows.map(stamped)),
	);
	writeFileSync(
		path.join(recordPath, "execution.json"),
		JSON.stringify({ cancelled: false, lostCoverage: [], outcomes: [] }),
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

/** A complete earlier verify record for `priorRunId`. */
function writeVerifyRecord(
	repo: string,
	runId: string,
	priorRunId: string,
	options: { posted?: boolean; kind?: string } = {},
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({ runId, kind: options.kind ?? "verify", priorRunId }),
	);
	writeFileSync(
		path.join(recordPath, "verification.json"),
		JSON.stringify({ priorRunId, keptFindingIds: [], outcomes: [] }),
	);
	if (options.posted !== false) {
		// An earlier verify whose comment reached the PR.
		writeFileSync(
			path.join(recordPath, ROUND_POSTED_MARKER),
			JSON.stringify({ pr: 12 }),
		);
	}
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

type Item = {
	id: string;
	disposition: "resolved" | "still present" | "inconclusive";
	evidence?: { file: string; explanation: string };
};

function verifyRun(
	repo: string,
	runId: string,
	priorRunId: string,
	kept: Row[],
	items: Item[],
	regressions: Array<{ title: string; file: string; evidence?: string }> = [],
	onCall?: () => void,
) {
	return async (input: { headRevision: string; seats?: string[] }) => {
		onCall?.();
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		mkdirSync(recordPath, { recursive: true });
		const seat: PlannedSeat = {
			rosterId: "terra",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "fix-verification",
			lensPrompt: "",
		};
		return {
			recordPath,
			priorRunId,
			priorHeadOid: "b".repeat(40),
			headOid: input.headRevision,
			kept: kept.map(stamped),
			outcomes: [
				{
					seat,
					outcome: {
						kind: "voted" as const,
						result: {
							items,
							regressions: regressions.map((row, index) => ({
								regressionId: `R-${index + 1}`,
								line: 9,
								evidence: row.evidence ?? "regression evidence",
								...row,
							})),
						},
					},
				},
			],
		} as RunVerifyResult;
	};
}

const REVIEW_ID = "20261113-review";

describe("a review round posts to the PR whose head it reviewed", () => {
	it("posts exactly one new review comment with the run id and no local path", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps(gh.runGh, {
						runReview: reviewRun(repo, "r-1", [
							{ id: "F-1", severity: "high" },
						]),
					}),
				},
			);
			const posted = posts(gh.calls);
			expect(posted).toHaveLength(1);
			expect(posted[0]?.args).toContain(
				`repos/${REPO_SLUG}/issues/12/comments`,
			);
			// The body goes through stdin, never as an argument.
			expect(posted[0]?.args).toContain("--input");
			expect(posted[0]?.args).toContain("-");
			expect(posted[0]?.args.join(" ")).not.toContain("Review panel");
			const body = bodyOf(posted[0]);
			expect(body.split("\n")[0]).toBe("## Review panel · review");
			expect(body).toContain("r-1");
			expect(body).toContain("F-1");
			expect(body).toContain("Seats: holistic (terra, claude)");
			expect(body).not.toContain(repo);
			expect(body).not.toContain("Record:");
			// No call edits or deletes a comment.
			expect(
				gh.calls.filter(
					(call) => call.args.includes("PATCH") || call.args.includes("DELETE"),
				),
			).toEqual([]);
			const reply = textOf(result);
			expect(reply).toContain("Record:");
			expect(reply.split("\n").at(-1)).toBe(
				`PR comment: posted to #12 (https://github.com/${REPO_SLUG}/pull/12#issuecomment-101)`,
			);
		});
	});

	it("looks the PR up by the head commit and keeps only open PRs at that head", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({
				pulls: [
					{ number: 3, state: "closed", head: { sha: head } },
					{ number: 4, state: "open", head: { sha: "c".repeat(40) } },
					openPr(5, head),
				],
			});
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", []) }) },
			);
			expect(
				gh.calls.some((call) =>
					call.args.includes(`repos/${REPO_SLUG}/commits/${head}/pulls`),
				),
			).toBe(true);
			expect(posts(gh.calls)[0]?.args).toContain(
				`repos/${REPO_SLUG}/issues/5/comments`,
			);
		});
	});

	it("posts to an explicit pr after checking it is open at this head, without the head lookup", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [], prs: { 31: openPr(31, head) } });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main", pr: 31 },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", []) }) },
			);
			expect(posts(gh.calls)[0]?.args).toContain(
				`repos/${REPO_SLUG}/issues/31/comments`,
			);
			expect(
				gh.calls.some((call) => call.args.join(" ").includes("/commits/")),
			).toBe(false);
			expect(
				gh.calls.some((call) =>
					call.args.includes(`repos/${REPO_SLUG}/pulls/31`),
				),
			).toBe(true);
			expect(textOf(result)).toContain("PR comment: posted to #31");
		});
	});
});

describe("no post, and one plain line saying why", () => {
	async function reviewWith(
		gh: { calls: GhCall[]; runGh: GhRunner },
		extra: Record<string, unknown> = {},
		config: Config = configWith(),
	): Promise<string> {
		let text = "";
		await withRepository(async (repo) => {
			text = textOf(
				await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main", ...extra },
					{
						deps: deps(
							gh.runGh,
							{ runReview: reviewRun(repo, "r-1", []) },
							config,
						),
					},
				),
			);
		});
		return text;
	}

	it("prComment: false makes no gh call at all", async () => {
		const gh = fakeGh({ pulls: [] });
		const text = await reviewWith(gh, { prComment: false });
		expect(gh.calls).toEqual([]);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (turned off for this run)",
		);
	});

	it("no open PR has this head", async () => {
		const gh = fakeGh({ pulls: [] });
		const text = await reviewWith(gh);
		expect(posts(gh.calls)).toEqual([]);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (no open PR has this head)",
		);
	});

	it("more than one open PR has this head", async () => {
		let headOid = "";
		await withRepository(async (_repo, head) => {
			headOid = head;
		});
		// Same commit content gives a new oid per repo, so match any head.
		const gh = fakeGh();
		const runGh: GhRunner = (args, options) => {
			const joined = args.join(" ");
			const match = /commits\/([0-9a-f]+)\/pulls/.exec(joined);
			if (match !== null) {
				gh.calls.push({ args: [...args] });
				return JSON.stringify([
					openPr(1, match[1] as string),
					openPr(2, match[1] as string),
				]);
			}
			return gh.runGh(args, options);
		};
		expect(headOid).not.toBe("");
		const text = await reviewWith({ calls: gh.calls, runGh });
		expect(posts(gh.calls)).toEqual([]);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (2 open PRs have this head: #1, #2; pass pr to choose one)",
		);
	});

	it("gh is missing", async () => {
		const missing = Object.assign(new Error("spawnSync gh ENOENT"), {
			code: "ENOENT",
		});
		const gh = fakeGh({ fail: missing });
		const text = await reviewWith(gh);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (gh is not installed)",
		);
	});

	it("gh fails or is signed out, and the review still completes", async () => {
		const gh = fakeGh({
			fail: new Error(
				"gh: To get started with GitHub CLI, please run:\n  gh auth login",
			),
		});
		const text = await reviewWith(gh);
		expect(text).toContain("# Review panel");
		const last = text.split("\n").at(-1) ?? "";
		expect(last.startsWith("PR comment: not posted (gh failed: ")).toBe(true);
		expect(last).toContain("gh auth login");
	});

	it("the real gh is never reached from a test: the fake on PATH fails", async () => {
		let text = "";
		await withRepository(async (repo) => {
			const { runGh: _unused, ...rest } = deps(fakeGh().runGh, {
				runReview: reviewRun(repo, "r-1", []),
			});
			text = textOf(
				await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main" },
					{ deps: rest },
				),
			);
		});
		expect(text.split("\n").at(-1)).toContain(
			"fake gh: tests never reach GitHub",
		);
	});
});

describe("the owner config can ask for approval before each post", () => {
	it("accepts auto and ownerApproved, and refuses anything else", () => {
		const base = {
			roster: [{ id: "a", provider: "p", model: "m" }],
			defaults: { seats: ["a"] },
		};
		for (const mode of ["auto", "ownerApproved"]) {
			const result = validateConfig({
				...base,
				defaults: { ...base.defaults, prComment: mode },
			});
			expect(result.ok).toBe(true);
			expect(result.ok && result.config.defaults.prComment).toBe(mode);
		}
		const bad = validateConfig({
			...base,
			defaults: { ...base.defaults, prComment: "always" },
		});
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors[0]?.field).toBe("defaults.prComment");
	});

	it("ownerApproved mode posts nothing without ownerApproved: true", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps(
						gh.runGh,
						{ runReview: reviewRun(repo, "r-1", []) },
						configWith("ownerApproved"),
					),
				},
			);
			expect(gh.calls).toEqual([]);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (the owner config asks for approval first)",
			);
		});
	});

	it("ownerApproved mode posts with ownerApproved: true", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main", ownerApproved: true },
				{
					deps: deps(
						gh.runGh,
						{ runReview: reviewRun(repo, "r-1", []) },
						configWith("ownerApproved"),
					),
				},
			);
			expect(posts(gh.calls)).toHaveLength(1);
		});
	});
});

describe("a verify round posts what was fixed, not fixed and new", () => {
	const ROWS: Row[] = [
		{ id: "F-1", severity: "high" },
		{ id: "F-2", severity: "medium" },
		{ id: "F-3", severity: "medium" },
		{ id: "F-4", severity: "low" },
	];

	it("posts verify N with dispositions, dismissed reasons, low/advisory and regressions", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			writeVerifyRecord(repo, "v-1", REVIEW_ID);
			writeVerifyRecord(repo, "v-0-other", "another-review");
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1", "F-2"],
					dismissed: [{ id: "F-3", reason: "by design, see ADR 4" }],
					lowAdvisory: ["F-4"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-2",
							REVIEW_ID,
							ROWS.slice(0, 2),
							[
								{
									id: "F-1",
									disposition: "resolved",
									evidence: {
										file: "src/a.ts",
										explanation: "the guard now checks null",
									},
								},
								{ id: "F-2", disposition: "still present" },
							],
							[{ title: "new crash on empty input", file: "src/b.ts" }],
						),
					}),
				},
			);
			const posted = posts(gh.calls);
			expect(posted).toHaveLength(1);
			const body = bodyOf(posted[0]);
			expect(body.split("\n")[0]).toBe("## Review panel · verify 2");
			expect(body).toContain("v-2");
			expect(body).toContain(REVIEW_ID);
			expect(body).toMatch(/F-1 resolved .*the guard now checks null/);
			expect(body).toMatch(/F-2 still present/);
			expect(body).toMatch(/F-3 .*by design, see ADR 4/);
			expect(body).toMatch(/### Low \/ advisory \(not kept\)\n- F-4/);
			expect(body).toMatch(/R-1 .*new crash on empty input/);
			expect(body).not.toContain(repo);
			expect(textOf(result)).toContain("PR comment: posted to #12");
			// Not every kept id is resolved: no close-out, and the reply says why.
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (F-2 is still present; 1 regression)",
			);
			expect(posted).toHaveLength(1);
		});
	});

	it("refuses an unknown dismissed id before any seat runs", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			let ran = false;
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
						dismissed: [{ id: "F-9", reason: "dup" }],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRun(repo, "v-1", REVIEW_ID, [], [], [], () => {
								ran = true;
							}),
						}),
					},
				),
			).rejects.toThrow(/F-9/);
			expect(ran).toBe(false);
			expect(gh.calls).toEqual([]);
		});
	});

	it("refuses a high finding listed as low/advisory, and a kept id also dismissed", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const never = async () => {
				throw new Error("no seat may run");
			};
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-2"],
						lowAdvisory: ["F-1"],
					},
					{ deps: deps(fakeGh().runGh, { runVerify: never }) },
				),
			).rejects.toThrow(/F-1 is high/);
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-2"],
						dismissed: [{ id: "F-2", reason: "x" }],
					},
					{ deps: deps(fakeGh().runGh, { runVerify: never }) },
				),
			).rejects.toThrow(/F-2 is listed more than once/);
		});
	});
});

describe("a clean verify also posts the close-out card, once per review", () => {
	const ROWS: Row[] = [
		{ id: "F-1", severity: "high" },
		{ id: "F-2", severity: "medium" },
		{ id: "F-3", severity: "low" },
	];
	const resolvedF1: Item = {
		id: "F-1",
		disposition: "resolved",
		evidence: { file: "src/a.ts", explanation: "fixed" },
	};

	it("posts the verify comment, then a separate close-out card", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
					dismissed: [{ id: "F-2", reason: "out of scope for this PR" }],
					lowAdvisory: ["F-3"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[resolvedF1],
						),
					}),
				},
			);
			const posted = posts(gh.calls);
			expect(posted).toHaveLength(2);
			expect(bodyOf(posted[0]).split("\n")[0]).toBe(
				"## Review panel · verify 1",
			);
			const card = bodyOf(posted[1]);
			expect(card.split("\n")[0]).toBe("## Review panel · close-out");
			expect(card).toContain(
				"3 findings submitted · 1 fixed · 1 dismissed · 1 left as low/advisory",
			);
			expect(card).toContain("out of scope for this PR");
			expect(card).toContain(REVIEW_ID);
			expect(card).not.toMatch(/ready to merge|approved|LGTM/i);
			const text = textOf(result);
			expect(text).toContain("PR comment: posted to #12");
			expect(text.split("\n").at(-1)).toMatch(
				/^PR close-out: posted to #12 \(/,
			);
		});
	});

	it("does not post a second close-out for the same review", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				comments: [
					{
						id: 9,
						user: { login: "saeed" },
						body: `## Review panel · close-out\nReview \`${REVIEW_ID}\``,
					},
				],
			});
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
					dismissed: [{ id: "F-2", reason: "out of scope" }],
					lowAdvisory: ["F-3"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[resolvedF1],
						),
					}),
				},
			);
			expect(posts(gh.calls)).toHaveLength(1);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (a close-out for this review is already on PR #12)",
			);
		});
	});

	it("says why when the card cannot be built, and still posts the verify comment", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
					lowAdvisory: ["F-3"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[resolvedF1],
						),
					}),
				},
			);
			expect(posts(gh.calls)).toHaveLength(1);
			const last = textOf(result).split("\n").at(-1) ?? "";
			expect(last.startsWith("PR close-out: not posted (")).toBe(true);
			expect(last).toContain("F-2");
		});
	});

	it("a regression means no close-out", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
					dismissed: [{ id: "F-2", reason: "out of scope" }],
					lowAdvisory: ["F-3"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[resolvedF1],
							[{ title: "broke it", file: "src/c.ts" }],
						),
					}),
				},
			);
			expect(posts(gh.calls)).toHaveLength(1);
		});
	});
});

describe("posted text is safe", () => {
	const HOSTILE_TITLE =
		"ping @octocat and @org/team \u202Eevil\u202C \u0007bell\u200B fixes #123";
	const HOSTILE_FILE = "src/@admin\u2066x\u2069.ts";

	it("neutralizes mentions and references and strips control, bidi and invisible characters", () => {
		const safe = githubSafe(HOSTILE_TITLE);
		expect(safe).not.toMatch(/@[A-Za-z]/);
		expect(safe).toContain("@\u200Docto");
		expect(safe).not.toMatch(/#\d/);
		expect(safe).not.toMatch(/[\u202E\u202C\u200B]/);
		expect(safe).not.toContain("\u0007");
		// The only invisible character left is the joiner placed after @ or #.
		expect(safe.replace(/[@#]\u200D/g, "")).not.toMatch(/\p{Cf}/u);
		expect(githubSafe("line one\nline two")).not.toContain("\n");
		expect(githubSafe("## Review panel")).not.toMatch(/^##/);
	});

	it("a review comment with hostile seat text and file names", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps(gh.runGh, {
						runReview: reviewRun(repo, "r-1", [
							{
								id: "F-1",
								severity: "high",
								title: HOSTILE_TITLE,
								file: HOSTILE_FILE,
								evidence: "line\n## Review panel\n@everyone <!-- hide -->",
							},
						]),
					}),
				},
			);
			const body = bodyOf(posts(gh.calls)[0]);
			// A code span is inert on GitHub, so the file name keeps its `@`.
			expect(body).toContain("`src/@admin\uFFFDx\uFFFD.ts:3`");
			expect(body.split("\n").map(outsideCodeSpans).join("\n")).not.toMatch(
				/@[A-Za-z]/,
			);
			expect(body).not.toMatch(/(^|[^\u200D])#\d/);
			expect(body).not.toMatch(/[\u202E\u202C\u2066\u2069\u200B]/);
			expect(body).not.toContain("\u0007");
			expect(body.replace(/[@#]\u200D/g, "")).not.toMatch(/\p{Cf}/u);
			expect(body).not.toContain("<!--");
			// Only our own heading line looks like a Review panel heading.
			expect(
				body
					.split("\n")
					.filter((line) => line.trim().startsWith("## Review panel")),
			).toEqual(["## Review panel · review"]);
		});
	});

	it("caps a huge body under GitHub's limit by cutting whole rows and counting them", async () => {
		await withRepository(async (repo, head) => {
			const rows: Row[] = Array.from({ length: 400 }, (_, index) => ({
				id: `F-${index + 1}`,
				severity: "medium" as const,
				title: `t${index} ${"x".repeat(200)}`,
				evidence: "e".repeat(400),
			}));
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", rows) }) },
			);
			const body = bodyOf(posts(gh.calls)[0]);
			expect(body.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
			expect(body.split("\n")[0]).toBe("## Review panel · review");
			const cut = /(\d+) finding\(s\) cut to fit GitHub's comment limit/.exec(
				body,
			);
			expect(cut).not.toBeNull();
			const shown = body.split("\n").filter((line) => /^- F-\d+ /.test(line));
			expect(shown.length + Number(cut?.[1])).toBe(400);
			// Every shown finding row keeps its evidence line: rows are whole.
			const lines = body.split("\n");
			for (const [index, line] of lines.entries()) {
				if (/^- F-\d+ /.test(line)) {
					expect(lines[index + 1]?.startsWith("  ")).toBe(true);
				}
			}
		});
	});
});

describe("the tool and the parsers take the new arguments", () => {
	it("review and verify accept prComment, pr and ownerApproved; verify also dismissed and lowAdvisory", () => {
		expect(
			parseReviewArguments({
				base: "main",
				head: "HEAD",
				prComment: false,
				pr: 4,
				ownerApproved: true,
			}),
		).toMatchObject({ prComment: false, pr: 4, ownerApproved: true });
		expect(
			parseVerifyArguments({
				priorRunId: "r",
				head: "HEAD",
				keptFindingIds: ["F-1"],
				dismissed: [{ id: "F-2", reason: "dup" }],
				lowAdvisory: ["F-3"],
				prComment: true,
			}),
		).toMatchObject({
			dismissed: [{ id: "F-2", reason: "dup" }],
			lowAdvisory: ["F-3"],
			prComment: true,
		});
		expect(() =>
			parseReviewArguments({ base: "main", head: "HEAD", prComment: "no" }),
		).toThrow(/prComment must be true or false/);
		expect(() =>
			parseReviewArguments({ base: "main", head: "HEAD", pr: "abc" }),
		).toThrow(/pr must be a positive integer/);
	});

	it('the tool coerces prComment "false" the way it coerces ownerApproved', () => {
		const tool = createReviewPanelTool();
		expect(
			tool.prepareArguments({
				action: "review",
				prComment: "false",
				ownerApproved: "true",
			}),
		).toMatchObject({ prComment: false, ownerApproved: true });
	});
});

describe("the default runner sends the body to a real gh process on stdin", () => {
	it("posts through a scripted gh first on PATH", async () => {
		const bin = mkdtempSync(path.join(tmpdir(), "rounds-gh-"));
		const log = path.join(bin, "log");
		writeFileSync(
			path.join(bin, "gh"),
			[
				"#!/bin/sh",
				`echo "ARGS $*" >> "${log}"`,
				'case "$*" in',
				'  "api user"*) echo saeed ;;',
				`  "repo view"*) echo ${REPO_SLUG} ;;`,
				'  *"/pulls") printf \'[{"number":12,"state":"open","head":{"sha":"%s"}}]\' "$ROUNDS_HEAD" ;;',
				`  *"--method POST"*) echo "STDIN $(cat)" >> "${log}"; echo '{"id":1,"html_url":"https://example.test/c/1"}' ;;`,
				"  *) exit 1 ;;",
				"esac",
			].join("\n"),
			{ mode: 0o755 },
		);
		const savedPath = process.env.PATH;
		try {
			await withRepository(async (repo, head) => {
				process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
				process.env.ROUNDS_HEAD = head;
				const { runGh: _unused, ...rest } = deps(fakeGh().runGh, {
					runReview: reviewRun(repo, "r-1", [
						{ id: "F-1", severity: "high", title: "uses $(rm -rf) and `x`" },
					]),
				});
				const result = await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main" },
					{ deps: rest },
				);
				expect(textOf(result).split("\n").at(-1)).toBe(
					"PR comment: posted to #12 (https://example.test/c/1)",
				);
			});
			const written = execFileSync("cat", [log], { encoding: "utf8" });
			const argLines = written
				.split("\n")
				.filter((line) => line.startsWith("ARGS"));
			expect(argLines.some((line) => line.includes("issues/12/comments"))).toBe(
				true,
			);
			expect(argLines.join("\n")).not.toContain("Review panel");
			expect(written).toContain('STDIN {"body":"## Review panel · review');
		} finally {
			process.env.PATH = savedPath;
			delete process.env.ROUNDS_HEAD;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("edge cases of the lookup and the run", () => {
	it("an unpushed head (GitHub answers 422) reads as no open PR", async () => {
		await withRepository(async (repo) => {
			const gh = fakeGh();
			const runGh: GhRunner = (args, options) => {
				if (args.join(" ").includes("/pulls")) {
					throw Object.assign(new Error("Command failed: gh api"), {
						stderr: "gh: No commit found for SHA: 0123 (HTTP 422)\n",
					});
				}
				return gh.runGh(args, options);
			};
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(runGh, { runReview: reviewRun(repo, "r-1", []) }) },
			);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (no open PR has this head; GitHub does not have this commit)",
			);
		});
	});

	it("a run that returns after it was interrupted posts nothing", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const controller = new AbortController();
			const run = reviewRun(repo, "r-1", []);
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					signal: controller.signal,
					deps: deps(gh.runGh, {
						runReview: async (config) => {
							controller.abort();
							return run(config);
						},
					}),
				},
			);
			expect(gh.calls).toEqual([]);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (the run was interrupted)",
			);
		});
	});

	it("a clean verify that could not post says so once", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, REVIEW_ID, [{ id: "F-1", severity: "high" }]);
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(fakeGh({ pulls: [] }).runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[{ id: "F-1", severity: "high" }],
							[
								{
									id: "F-1",
									disposition: "resolved",
									evidence: { file: "src/a.ts", explanation: "ok" },
								},
							],
						),
					}),
				},
			);
			const text = textOf(result);
			expect(text).not.toContain("PR close-out");
			expect(text.split("\n").at(-1)).toBe(
				"PR comment: not posted (no open PR has this head)",
			);
		});
	});

	it("escapes & so no HTML entity reaches GitHub", () => {
		const safe = githubSafe("&#64;octocat &lt;x");
		expect(safe).not.toMatch(/(?<!\\)&/);
		expect(safe.startsWith("\\&\\#\u200D64;")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Fix round 1
// ---------------------------------------------------------------------------

type SeatVote =
	| {
			rosterId: string;
			items: Item[];
			regressions?: number;
			/** Title and evidence text of each regression. */
			regressionText?: string;
	  }
	| { rosterId: string; failed: true };

/** A fake runVerify with one outcome per seat; it can write its own record. */
function verifyRunSeats(
	repo: string,
	runId: string,
	priorRunId: string,
	kept: Row[],
	votes: SeatVote[],
	options: { ownRecord?: { posted?: boolean } } = {},
) {
	return async (input: { headRevision: string }) => {
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		mkdirSync(recordPath, { recursive: true });
		if (options.ownRecord !== undefined) {
			writeVerifyRecord(repo, runId, priorRunId, {
				posted: options.ownRecord.posted ?? false,
			});
		}
		return {
			recordPath,
			priorRunId,
			priorHeadOid: "b".repeat(40),
			headOid: input.headRevision,
			kept: kept.map(stamped),
			outcomes: votes.map((vote) => {
				const seat: PlannedSeat = {
					rosterId: vote.rosterId,
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					lens: "fix-verification",
					lensPrompt: "",
				};
				if ("failed" in vote) {
					return {
						seat,
						outcome: { kind: "failed" as const, class: "timeout", reason: "t" },
					};
				}
				return {
					seat,
					outcome: {
						kind: "voted" as const,
						result: {
							items: vote.items,
							regressions: Array.from(
								{ length: vote.regressions ?? 0 },
								(_, index) => ({
									regressionId: `R-${index + 1}`,
									title: vote.regressionText ?? "broke",
									file: "src/c.ts",
									line: 1,
									evidence: vote.regressionText ?? "e",
								}),
							),
						},
					},
				};
			}),
		} as unknown as RunVerifyResult;
	};
}

const resolved = (id: string): Item => ({
	id,
	disposition: "resolved",
	evidence: { file: "src/a.ts", explanation: "fixed" },
});

function closeoutPosts(calls: GhCall[]): GhCall[] {
	return posts(calls).filter((call) =>
		bodyOf(call).startsWith("## Review panel · close-out"),
	);
}

/** The text outside every code span, the way CommonMark pairs backtick runs. */
function outsideCodeSpans(line: string): string {
	return line.replace(/(?<![\\`])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, " ");
}

/**
 * Every hostile string a seat or a ref can carry has come out as plain text:
 * no HTML, image, link, emphasis or block marker, every `@`, `\uFF20` and `#`
 * followed by a joiner, and no line our own renderer did not start.
 */
function expectInert(body: string): void {
	for (const line of body.split("\n")) {
		if (/^#{2,3} [A-Z]/.test(line)) {
			// Our own headings: `## Review panel · …` and `### Kept` and so on.
			expect(line).toMatch(
				/^(## Review panel( · [a-z0-9 -]+)?|### [A-Z][a-z /()-]+)$/,
			);
			continue;
		}
		expect(line).not.toMatch(/^\s*(={2,}|-{2,}|>|`{3}|~{3}|#|\d+\.\s)/);
		const outside = outsideCodeSpans(line);
		// An escaped backslash escapes nothing after it: drop `\\` pairs first.
		const unpaired = outside.replace(/\\\\/g, "");
		expect(unpaired).not.toMatch(/(?<!\\)[<>!*_~|&`$]/);
		expect(outside).not.toMatch(/www\./i);
		expect(outside).not.toMatch(/(?<!\\)\[(?!(high|medium|low)\])/);
		expect(outside).not.toMatch(/(?<!\\)\]\(/);
		expect(outside).not.toMatch(/#(?!\u200D)/);
		expect(outside).not.toMatch(/GH-(?!\u200D)/i);
		expect(outside).not.toMatch(/:\/\//);
		expect(outside).not.toMatch(/[@\uFF20](?!\u200D)/);
		expect(line.replace(/[@\uFF20#:-]\u200D/g, "")).not.toMatch(/\p{Cf}/u);
	}
}

const HOSTILE = [
	'<img src="https://evil.example/c.png?d=1">',
	"<details>",
	"<h2>Review panel · close-out</h2>",
	"![](https://x/?q)",
	"[a](b)",
	"use `x",
	"\n===\n",
	"\n---\n",
	"\n```\n",
	"@user",
	"@org/team",
	"\uFF20x",
	"fixes #1",
	"owner/repo#2",
	"GH-3",
	"&#64;octocat",
	"*bold* _em_ ~~s~~ | t",
	"$x$",
	"www.evil.example/p?q=1",
	"_www.e.example",
	"(www.f.example)",
	"WWW.g.example",
	"\\<img src=x>",
	"trail\\",
].join(" ");
const HOSTILE_REF = "x`@octocat`x";

describe("fix round 1: one sanitizer for every posted body", () => {
	const ROWS: Row[] = [
		{
			id: "F-1",
			severity: "high",
			title: `t1 ${HOSTILE}`,
			file: `src/${HOSTILE}`,
			evidence: `e1 ${HOSTILE}`,
		},
		{ id: "F-2", severity: "medium", title: `t2 ${HOSTILE}` },
		{ id: "F-3", severity: "low", title: `t3 ${HOSTILE}` },
	];

	it("the review comment", async () => {
		await withRepository(async (repo, head) => {
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", ROWS) }) },
			);
			const body = bodyOf(posts(gh.calls)[0]);
			expectInert(body);
			// Seat text is shown, escaped, not dropped.
			expect(body).toContain("\\<img src=");
			expect(body).toContain("use \\`x");
		});
	});

	it("the verify comment and the automatic close-out card, with a hostile head ref", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			git(repo, ["branch", HOSTILE_REF]);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: HOSTILE_REF,
					keptFindingIds: ["F-1"],
					dismissed: [{ id: "F-2", reason: `r ${HOSTILE}` }],
					lowAdvisory: ["F-3"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[
								{
									rosterId: "terra",
									items: [
										{
											id: "F-1",
											disposition: "resolved",
											evidence: {
												file: `src/${HOSTILE}`,
												explanation: `ok ${HOSTILE}`,
											},
										},
									],
								},
							],
						),
					}),
				},
			);
			const posted = posts(gh.calls);
			expect(posted).toHaveLength(2);
			for (const call of posted) {
				expectInert(bodyOf(call));
			}
			const card = bodyOf(posted[1]);
			// A code span is inert on GitHub: no joiner hides in a copied ref.
			expect(card).toContain("``x`@octocat`x``");
		});
	});

	it("a regression's title, file and evidence", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							[ROWS[0] as Row],
							[resolved("F-1")],
							[
								{
									title: `r ${HOSTILE}`,
									file: `src/${HOSTILE}`,
									evidence: `e ${HOSTILE}`,
								},
							],
						),
					}),
				},
			);
			expectInert(bodyOf(posts(gh.calls)[0]));
		});
	});

	it("the manual comment card", async () => {
		const { assembleCloseoutComment } = await import(
			"../src/tool/closeout-comment.js"
		);
		const card = assembleCloseoutComment({
			findings: ROWS.map(stamped),
			panel: {
				runId: "r",
				baseRef: HOSTILE_REF,
				seats: [
					{
						rosterId: "terra",
						lens: "holistic",
						provider: "openai-codex",
						model: "gpt-5.6-terra",
					},
				],
			} as never,
			lost: [],
			meta: {
				baseRef: HOSTILE_REF,
				baseOid: "a".repeat(40),
				headOid: "b".repeat(40),
			},
			dismissed: [{ id: "F-2", reason: `r ${HOSTILE}` }],
			lowAdvisory: ["F-3"],
			headRef: HOSTILE_REF,
		});
		expectInert(card);
		expect(card).toContain("``x`@octocat`x``");
	});

	it("code spans hold file names unescaped; seat code in titles shows no entity", () => {
		const safe = githubSafe("low `a && b<T>`");
		expect(safe).not.toMatch(/&amp;|&lt;/);
		expect(safe).toBe("low \\`a \\&\\& b\\<T\\>\\`");
	});
});

describe("fix round 1: the close-out card keeps every line (H2)", () => {
	it("a clean verify with nothing dismissed and no lows posts counts, Seats, Lost and the range", async () => {
		await withRepository(async (repo, head) => {
			const rows: Row[] = [
				{ id: "F-1", severity: "high" },
				{ id: "F-2", severity: "medium" },
			];
			writeReviewRecord(repo, REVIEW_ID, rows);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1", "F-2"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, rows, [
							{ rosterId: "terra", items: [resolved("F-1"), resolved("F-2")] },
						]),
					}),
				},
			);
			const card = closeoutPosts(gh.calls);
			expect(card).toHaveLength(1);
			const lines = bodyOf(card[0]).split("\n");
			expect(lines).toContain(
				"2 findings submitted · 2 fixed · 0 dismissed · 0 left as low/advisory",
			);
			expect(lines.some((line) => line.startsWith("Seats: terra"))).toBe(true);
			expect(lines).toContain("Lost: none");
			expect(
				lines.some((line) => /^`main` \(`aaaaaaa`\) → `HEAD` \(`/.test(line)),
			).toBe(true);
		});
	});
});

describe("fix round 1: kept findings of any severity (M3)", () => {
	const ROWS: Row[] = [
		{ id: "F-1", severity: "high" },
		{ id: "F-3", severity: "low" },
	];

	for (const listed of [false, true]) {
		it(`a kept low that is resolved counts as fixed${listed ? ", even when also listed in lowAdvisory" : ""}`, async () => {
			await withRepository(async (repo, head) => {
				writeReviewRecord(repo, REVIEW_ID, ROWS);
				const gh = fakeGh({ pulls: [openPr(12, head)] });
				const result = await verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1", "F-3"],
						...(listed ? { lowAdvisory: ["F-3"] } : {}),
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, [
								{
									rosterId: "terra",
									items: [resolved("F-1"), resolved("F-3")],
								},
							]),
						}),
					},
				);
				const card = closeoutPosts(gh.calls);
				expect(card).toHaveLength(1);
				expect(bodyOf(card[0])).toContain(
					"2 findings submitted · 2 fixed · 0 dismissed · 0 left as low/advisory",
				);
				expect(bodyOf(posts(gh.calls)[0])).not.toContain("### Low / advisory");
				expect(textOf(result).split("\n").at(-1)).toMatch(
					/^PR close-out: posted to #12/,
				);
			});
		});
	}
});

describe("fix round 1: the close-out needs full coverage and agreement (M4)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];

	async function verifyWith(votes: SeatVote[]) {
		let gh = fakeGh();
		let text = "";
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			gh = fakeGh({ pulls: [openPr(12, head)] });
			text = textOf(
				await verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, votes),
						}),
					},
				),
			);
		});
		return { gh, text };
	}

	it("two seats that both resolve every kept id: the close-out posts", async () => {
		const { gh } = await verifyWith([
			{ rosterId: "terra", items: [resolved("F-1")] },
			{ rosterId: "claude", items: [resolved("F-1")] },
		]);
		expect(closeoutPosts(gh.calls)).toHaveLength(1);
	});

	it("seats disagree: the verify comment posts, the close-out does not", async () => {
		const { gh, text } = await verifyWith([
			{ rosterId: "terra", items: [resolved("F-1")] },
			{
				rosterId: "claude",
				items: [{ id: "F-1", disposition: "still present" }],
			},
		]);
		expect(posts(gh.calls)).toHaveLength(1);
		expect(text.split("\n").at(-1)).toBe(
			"PR close-out: not posted (seats disagree on F-1)",
		);
	});

	it("a seat that says nothing about a kept id is not agreement", async () => {
		const { gh, text } = await verifyWith([
			{ rosterId: "terra", items: [resolved("F-1")] },
			{ rosterId: "claude", items: [] },
		]);
		expect(posts(gh.calls)).toHaveLength(1);
		expect(text.split("\n").at(-1)).toBe(
			"PR close-out: not posted (seats disagree on F-1)",
		);
	});

	it("a lost verify seat: the verify comment posts, the close-out does not", async () => {
		const { gh, text } = await verifyWith([
			{ rosterId: "terra", items: [resolved("F-1")] },
			{ rosterId: "claude", failed: true },
		]);
		expect(posts(gh.calls)).toHaveLength(1);
		expect(text.split("\n").at(-1)).toBe(
			"PR close-out: not posted (lost verify coverage: claude/fix-verification)",
		);
	});

	it("a regression: the reply says so", async () => {
		const { gh, text } = await verifyWith([
			{ rosterId: "terra", items: [resolved("F-1")], regressions: 2 },
		]);
		expect(posts(gh.calls)).toHaveLength(1);
		expect(text.split("\n").at(-1)).toBe(
			"PR close-out: not posted (2 regressions)",
		);
	});

	it("the card's Lost line names lost verify seats after the review's", async () => {
		const { assembleCloseoutComment } = await import(
			"../src/tool/closeout-comment.js"
		);
		const card = assembleCloseoutComment({
			findings: ROWS.map(stamped),
			panel: {
				runId: "r",
				baseRef: "main",
				seats: [
					{ rosterId: "terra", lens: "holistic", provider: "p", model: "m" },
				],
			} as never,
			lost: ["glm/holistic"],
			verifyLost: ["claude/fix-verification"],
			meta: {
				baseRef: "main",
				baseOid: "a".repeat(40),
				headOid: "b".repeat(40),
			},
			dismissed: [],
			lowAdvisory: [],
		});
		expect(card.split("\n")).toContain(
			"Lost: glm/holistic, claude/fix-verification (verify)",
		);
	});
});

describe("fix round 1: the comment listing is read across pages (F-2)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];
	const existing = {
		id: 9,
		user: { login: "saeed" },
		body: `## Review panel · close-out\nReview \`${REVIEW_ID}\``,
	};
	const filler = Array.from({ length: 30 }, (_, index) => ({
		id: 200 + index,
		user: { login: "someone" },
		body: "hi",
	}));

	for (const [name, raw] of [
		[
			"pages printed one after another",
			`${JSON.stringify(filler)}${JSON.stringify([existing])}`,
		],
		[
			"pages on separate lines",
			`${JSON.stringify(filler)}\n${JSON.stringify([existing])}\n`,
		],
		["slurped pages", JSON.stringify([filler, [existing]])],
	] as const) {
		it(`finds an earlier close-out on page two: ${name}`, async () => {
			await withRepository(async (repo, head) => {
				writeReviewRecord(repo, REVIEW_ID, ROWS);
				const gh = fakeGh({ pulls: [openPr(12, head)], commentsRaw: raw });
				const result = await verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, [
								{ rosterId: "terra", items: [resolved("F-1")] },
							]),
						}),
					},
				);
				expect(closeoutPosts(gh.calls)).toHaveLength(0);
				expect(textOf(result).split("\n").at(-1)).toBe(
					"PR close-out: not posted (a close-out for this review is already on PR #12)",
				);
			});
		});
	}
});

describe("fix round 1: an explicit pr must be open at the run's head (L1)", () => {
	for (const [name, row, reason] of [
		[
			"closed",
			{ number: 7, state: "closed", head: { sha: "HEAD_OID" } },
			"PR #7 is not open",
		],
		[
			"at another head",
			{ number: 7, state: "open", head: { sha: "f".repeat(40) } },
			"PR #7's head is not this run's head",
		],
		["not a pull request", undefined, "#7 is not a pull request here"],
	] as const) {
		it(`posts nothing to a PR that is ${name}`, async () => {
			await withRepository(async (repo, head) => {
				const pr =
					row === undefined
						? undefined
						: {
								...row,
								head: {
									sha: row.head.sha === "HEAD_OID" ? head : row.head.sha,
								},
							};
				const gh = fakeGh(pr === undefined ? {} : { prs: { 7: pr } });
				const result = await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main", pr: 7 },
					{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", []) }) },
				);
				expect(posts(gh.calls)).toHaveLength(0);
				expect(textOf(result).split("\n").at(-1)).toBe(
					`PR comment: not posted (${reason})`,
				);
			});
		});
	}
});

describe("fix round 1: gh does not block the event loop (L2)", () => {
	it("timers keep firing while a slow scripted gh answers", async () => {
		const bin = mkdtempSync(path.join(tmpdir(), "rounds-slow-gh-"));
		writeFileSync(
			path.join(bin, "gh"),
			["#!/bin/sh", "sleep 0.4", "exit 1"].join("\n"),
			{ mode: 0o755 },
		);
		const savedPath = process.env.PATH;
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 20);
		try {
			await withRepository(async (repo) => {
				process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
				const { runGh: _unused, ...rest } = deps(fakeGh().runGh, {
					runReview: reviewRun(repo, "r-1", []),
				});
				const result = await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main" },
					{ deps: rest },
				);
				expect(textOf(result).split("\n").at(-1)).toMatch(
					/^PR comment: not posted \(gh failed/,
				);
			});
			expect(ticks).toBeGreaterThanOrEqual(5);
		} finally {
			clearInterval(timer);
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("fix round 1: one close-out per review, even across concurrent verifies (L3)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];

	it("two concurrent clean verifies post one close-out between them", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)], delayMs: 5 });
			const run = (id: string) =>
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, id, REVIEW_ID, ROWS, [
								{ rosterId: "terra", items: [resolved("F-1")] },
							]),
						}),
					},
				);
			const [a, b] = await Promise.all([run("v-1"), run("v-2")]);
			expect(closeoutPosts(gh.calls)).toHaveLength(1);
			const lasts = [textOf(a), textOf(b)].map((text) =>
				text.split("\n").at(-1),
			);
			expect(
				lasts.filter((line) => line?.startsWith("PR close-out: posted")),
			).toHaveLength(1);
			// The other found the claim still held, or the card already posted.
			expect(
				lasts.filter((line) =>
					/^PR close-out: not posted \((another verify is posting this review's close-out|this review's close-out is already posted)\)$/.test(
						line ?? "",
					),
				),
			).toHaveLength(1);
		});
	});

	it("a failed close-out post releases the claim, so a later verify posts it", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const failing = fakeGh({
				pulls: [openPr(12, head)],
				failPost: { at: 2, error: new Error("boom") },
			});
			const verify = (gh: { runGh: GhRunner }, id: string) =>
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, id, REVIEW_ID, ROWS, [
								{ rosterId: "terra", items: [resolved("F-1")] },
							]),
						}),
					},
				);
			const first = await verify(failing, "v-1");
			expect(textOf(first).split("\n").at(-1)).toMatch(
				/^PR close-out: not posted \(gh failed/,
			);
			const second = fakeGh({ pulls: [openPr(12, head)] });
			await verify(second, "v-2");
			expect(closeoutPosts(second.calls)).toHaveLength(1);
		});
	});

	it("a claim already in the review record stops the close-out", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const { CLOSEOUT_POSTED_MARKER } = await import(
				"../src/tool/round-post.js"
			);
			writeFileSync(
				path.join(
					repo,
					".review-panel",
					"runs",
					REVIEW_ID,
					CLOSEOUT_POSTED_MARKER,
				),
				"v-0",
			);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, [
							{ rosterId: "terra", items: [resolved("F-1")] },
						]),
					}),
				},
			);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
		});
	});
});

describe("fix round 1: verify N counts only verifies that posted (L4, L7)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];

	async function roundOf(
		setup: (repo: string) => void,
		ownRecord?: { posted?: boolean },
	): Promise<string> {
		let heading = "";
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			setup(repo);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(
							repo,
							"v-5",
							REVIEW_ID,
							ROWS,
							[
								{
									rosterId: "terra",
									items: [{ id: "F-1", disposition: "still present" }],
								},
							],
							ownRecord === undefined ? {} : { ownRecord },
						),
					}),
				},
			);
			heading = bodyOf(posts(gh.calls)[0]).split("\n")[0] ?? "";
		});
		return heading;
	}

	it("an earlier verify that did not post is not counted", async () => {
		expect(
			await roundOf((repo) =>
				writeVerifyRecord(repo, "v-1", REVIEW_ID, { posted: false }),
			),
		).toBe("## Review panel · verify 1");
	});

	it("an earlier verify that posted is counted", async () => {
		expect(
			await roundOf((repo) => writeVerifyRecord(repo, "v-1", REVIEW_ID)),
		).toBe("## Review panel · verify 2");
	});

	it("a record that is not a verify is not counted", async () => {
		expect(
			await roundOf((repo) =>
				writeVerifyRecord(repo, "v-1", REVIEW_ID, { kind: "review" }),
			),
		).toBe("## Review panel · verify 1");
	});

	it("the verify does not count its own record", async () => {
		expect(await roundOf(() => undefined, { posted: true })).toBe(
			"## Review panel · verify 1",
		);
	});

	it("a posted verify records it, and the next verify is numbered after it", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			const still = [
				{
					rosterId: "terra",
					items: [{ id: "F-1", disposition: "still present" as const }],
				},
			];
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const verify = (id: string, runGh: GhRunner) =>
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(runGh, {
							runVerify: async (input: { headRevision: string }) => {
								const result = await verifyRunSeats(
									repo,
									id,
									REVIEW_ID,
									ROWS,
									still,
								)(input);
								writeVerifyRecord(repo, id, REVIEW_ID, { posted: false });
								return result;
							},
						}),
					},
				);
			await verify("v-1", fakeGh({ pulls: [] }).runGh);
			await verify("v-2", gh.runGh);
			await verify("v-3", gh.runGh);
			expect(
				posts(gh.calls).map((call) => bodyOf(call).split("\n")[0]),
			).toEqual(["## Review panel · verify 1", "## Review panel · verify 2"]);
		});
	});
});

describe("fix round 1: the dedupe guard's filters (F-9, L7)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];

	for (const [name, comment] of [
		[
			"by another login",
			{
				id: 9,
				user: { login: "mallory" },
				body: `## Review panel · close-out\nReview \`${REVIEW_ID}\``,
			},
		],
		[
			"for another review",
			{
				id: 9,
				user: { login: "saeed" },
				body: "## Review panel · close-out\nReview `other-review`",
			},
		],
		[
			"under another heading",
			{
				id: 9,
				user: { login: "saeed" },
				body: `## Review panel · verify 1\nReview \`${REVIEW_ID}\``,
			},
		],
	] as const) {
		it(`a close-out ${name} does not stop this one`, async () => {
			await withRepository(async (repo, head) => {
				writeReviewRecord(repo, REVIEW_ID, ROWS);
				const gh = fakeGh({ pulls: [openPr(12, head)], comments: [comment] });
				const result = await verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					{
						deps: deps(gh.runGh, {
							runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, [
								{ rosterId: "terra", items: [resolved("F-1")] },
							]),
						}),
					},
				);
				expect(posts(gh.calls)).toHaveLength(2);
				expect(textOf(result).split("\n").at(-1)).toMatch(
					/^PR close-out: posted to #12/,
				);
			});
		});
	}

	it("refuses an unknown low/advisory id by name before any seat runs", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
						lowAdvisory: ["F-9"],
					},
					{
						deps: deps(fakeGh().runGh, {
							runVerify: async () => {
								throw new Error("no seat may run");
							},
						}),
					},
				),
			).rejects.toThrow(
				"Verify refused: low/advisory F-9 is not in the review record",
			);
		});
	});
});

describe("fix round 1: verify honours the posting gates (F-5)", () => {
	const ROWS: Row[] = [{ id: "F-1", severity: "high" }];

	async function cleanVerify(
		input: { prComment?: boolean; ownerApproved?: boolean },
		mode?: "auto" | "ownerApproved",
	) {
		let gh = fakeGh();
		let text = "";
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS);
			gh = fakeGh({ pulls: [openPr(12, head)] });
			text = textOf(
				await verifyAction(
					{
						repoDir: repo,
						priorRunId: REVIEW_ID,
						head: "HEAD",
						keptFindingIds: ["F-1"],
						...input,
					},
					{
						deps: deps(
							gh.runGh,
							{
								runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, ROWS, [
									{ rosterId: "terra", items: [resolved("F-1")] },
								]),
							},
							configWith(mode),
						),
					},
				),
			);
		});
		return { gh, text };
	}

	it("prComment: false makes no gh call, not even for the close-out", async () => {
		const { gh, text } = await cleanVerify({ prComment: false });
		expect(gh.calls).toEqual([]);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (turned off for this run)",
		);
	});

	it("ownerApproved mode without approval makes no gh call", async () => {
		const { gh, text } = await cleanVerify({}, "ownerApproved");
		expect(gh.calls).toEqual([]);
		expect(text.split("\n").at(-1)).toBe(
			"PR comment: not posted (the owner config asks for approval first)",
		);
	});

	it("ownerApproved mode with approval posts the verify comment and the close-out", async () => {
		const { gh } = await cleanVerify({ ownerApproved: true }, "ownerApproved");
		expect(posts(gh.calls)).toHaveLength(2);
	});
});

describe("fix round 1: gh runs in the reviewed repository (F-7)", () => {
	it("every call of a review and a clean verify has cwd set to the repository", async () => {
		await withRepository(async (repo, head) => {
			const rows: Row[] = [{ id: "F-1", severity: "high" }];
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", rows) }) },
			);
			writeReviewRecord(repo, REVIEW_ID, rows);
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, rows, [
							{ rosterId: "terra", items: [resolved("F-1")] },
						]),
					}),
				},
			);
			expect(closeoutPosts(gh.calls)).toHaveLength(1);
			expect(gh.calls.length).toBeGreaterThan(5);
			for (const call of gh.calls) {
				expect(call.cwd).toBe(repo);
			}
		});
	});
});

describe("fix round 1: the reply stays under its cap with the PR lines (F-8)", () => {
	it("a huge review with a long multibyte PR line", async () => {
		const { MAX_PRESENTATION_BYTES } = await import(
			"../src/tool/review-presentation.js"
		);
		await withRepository(async (repo, head) => {
			const rows: Row[] = Array.from({ length: 400 }, (_, index) => ({
				id: `F-${index + 1}`,
				severity: "medium" as const,
				title: `t${index} ${"€".repeat(200)}`,
				evidence: "€".repeat(400),
			}));
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				htmlUrl: `https://example.test/${"€".repeat(2000)}`,
			});
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", rows) }) },
			);
			const text = textOf(result);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_PRESENTATION_BYTES,
			);
			expect(text.split("\n").at(-1)).toMatch(/^PR comment: posted to #12/);
		});
	});

	it("a verify reply that fills its cap, with both PR lines long and multibyte", async () => {
		const { MAX_PRESENTATION_BYTES } = await import(
			"../src/tool/review-presentation.js"
		);
		await withRepository(async (repo, head) => {
			const rows: Row[] = [{ id: "F-1", severity: "high" }];
			writeReviewRecord(repo, REVIEW_ID, rows);
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				htmlUrl: `https://example.test/${"\u20AC".repeat(2000)}`,
			});
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(repo, "v-1", REVIEW_ID, rows, [
							{
								rosterId: "terra",
								items: [resolved("F-1")],
								// Regressions fill the report up to its reserve.
								regressions: 300,
								regressionText: "\u20AC".repeat(20),
							},
							// A lost seat with a long name makes the close-out line long.
							{ rosterId: "\u20AC".repeat(400), failed: true },
						]),
					}),
				},
			);
			const text = textOf(result);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_PRESENTATION_BYTES,
			);
			const lines = text.split("\n");
			expect(lines.at(-2)).toMatch(/^PR comment: posted to #12/);
			expect(lines.at(-1)).toMatch(
				/^PR close-out: not posted \(lost verify coverage: /,
			);
		});
	});
});

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

const STILL: SeatVote[] = [
	{ rosterId: "terra", items: [{ id: "F-1", disposition: "still present" }] },
];

function reviewRecordDir(repo: string): string {
	return path.join(repo, ".review-panel", "runs", REVIEW_ID);
}

function headingsOf(calls: GhCall[]): string[] {
	return posts(calls).map((call) => bodyOf(call).split("\n")[0] ?? "");
}

/** A process id that is certainly not running any more. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""]);
	return child.pid as number;
}

function verifyOnce(
	repo: string,
	gh: { runGh: GhRunner },
	id: string,
	votes: SeatVote[] = STILL,
	signal?: AbortSignal,
) {
	return verifyAction(
		{
			repoDir: repo,
			priorRunId: REVIEW_ID,
			head: "HEAD",
			keptFindingIds: ["F-1"],
		},
		{
			...(signal === undefined ? {} : { signal }),
			deps: deps(gh.runGh, {
				runVerify: verifyRunSeats(repo, id, REVIEW_ID, ROWS_R2, votes),
			}),
		},
	);
}

const ROWS_R2: Row[] = [{ id: "F-1", severity: "high" }];

/** A title that is not text: the verify body cannot be rendered from it. */
const RENDER_FAILS_ROWS: Row[] = [
	{ id: "F-1", severity: "high", title: 42 as unknown as string },
];

describe("fix round 2: concurrent verifies get distinct, sequential round numbers (regression-1-1)", () => {
	it("two concurrent verifies post verify 1 and verify 2 and leave no claim behind", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({ pulls: [openPr(12, head)], delayMs: 5 });
			await Promise.all([
				verifyOnce(repo, gh, "v-1"),
				verifyOnce(repo, gh, "v-2"),
			]);
			expect(headingsOf(gh.calls).sort()).toEqual([
				"## Review panel · verify 1",
				"## Review panel · verify 2",
			]);
			expect(
				readdirSync(reviewRecordDir(repo)).filter((name) =>
					name.endsWith(".claim"),
				),
			).toEqual([]);
			// The next verify follows them.
			const next = fakeGh({ pulls: [openPr(12, head)] });
			await verifyOnce(repo, next, "v-3");
			expect(headingsOf(next.calls)).toEqual(["## Review panel · verify 3"]);
		});
	});

	it("a failed post gives its number back, so no later round skips it", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const failing = fakeGh({
				pulls: [openPr(12, head)],
				failPost: { at: 1, error: new Error("boom") },
			});
			const first = await verifyOnce(repo, failing, "v-1");
			expect(textOf(first).split("\n").at(-1)).toBe(
				"PR comment: not posted (gh failed: boom; verify 1 is left for the next verify)",
			);
			const second = fakeGh({ pulls: [openPr(12, head)] });
			await verifyOnce(repo, second, "v-2");
			expect(headingsOf(second.calls)).toEqual(["## Review panel · verify 1"]);
		});
	});

	it("concurrent verifies where one post fails: the other is verify 1, never a lone verify 2", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				delayMs: 5,
				failPost: { at: 1, error: new Error("boom") },
			});
			const replies = await Promise.all([
				verifyOnce(repo, gh, "v-1"),
				verifyOnce(repo, gh, "v-2"),
			]);
			expect(
				replies
					.flatMap((reply) => textOf(reply).split("\n"))
					.filter((line) => line.startsWith("PR comment:"))
					.sort(),
			).toEqual([
				"PR comment: not posted (gh failed: boom; verify 1 is left for the next verify)",
				"PR comment: posted to #12 (https://github.com/smarzban/demo/pull/12#issuecomment-101)",
			]);
			const bodies = posts(gh.calls).map((call) => bodyOf(call).split("\n")[0]);
			// The first POST failed; the one that reached the PR is verify 1.
			expect(bodies).toEqual([
				"## Review panel · verify 1",
				"## Review panel · verify 1",
			]);
		});
	});
});

describe("fix round 3: close-out claims are generations, never taken over", () => {
	const clean: SeatVote[] = [{ rosterId: "terra", items: [resolved("F-1")] }];

	function writeClaim(
		repo: string,
		name: string,
		info: object | string,
	): string {
		const file = path.join(reviewRecordDir(repo), name);
		writeFileSync(file, typeof info === "string" ? info : JSON.stringify(info));
		return file;
	}

	function stale(): object {
		return {
			verifyRunId: "v-0",
			pid: process.pid,
			host: hostname(),
			claimedAt: Date.now() - ROUND_DEADLINE_MS - 10_000,
		};
	}

	function claimsLeft(repo: string): string[] {
		return readdirSync(reviewRecordDir(repo))
			.filter((name) => name.includes(".claim"))
			.sort();
	}

	it("a stale closeout.claim-1 and no card on the PR: generation 2 posts the card", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			writeClaim(repo, "closeout.claim-1", stale());
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(1);
			expect(textOf(result).split("\n").at(-1)).toMatch(
				/^PR close-out: posted to #12/,
			);
			// The stale claim stays where it is; the posted marker records the card.
			expect(claimsLeft(repo)).toEqual(["closeout.claim-1"]);
			expect(
				JSON.parse(
					readFileSync(
						path.join(reviewRecordDir(repo), CLOSEOUT_POSTED_MARKER),
						"utf8",
					),
				),
			).toMatchObject({ verifyRunId: "v-1" });
		});
	});

	it("a stale claim on this host whose process is gone, with the card already on the PR: no second card, closeout.posted written", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			writeClaim(repo, "closeout.claim-1", {
				verifyRunId: "v-0",
				pid: deadPid(),
				host: hostname(),
				claimedAt: Date.now(),
			});
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				comments: [
					{
						id: 9,
						user: { login: "saeed" },
						body: `## Review panel · close-out\nReview \`${REVIEW_ID}\``,
					},
				],
			});
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (a close-out for this review is already on PR #12)",
			);
			expect(
				existsSync(path.join(reviewRecordDir(repo), CLOSEOUT_POSTED_MARKER)),
			).toBe(true);
		});
	});

	it("a won claim with the card already on the PR writes closeout.posted and removes the claim (L4)", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				comments: [
					{
						id: 9,
						user: { login: "saeed" },
						body: `## Review panel · close-out\nReview \`${REVIEW_ID}\``,
					},
				],
			});
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (a close-out for this review is already on PR #12)",
			);
			expect(
				existsSync(path.join(reviewRecordDir(repo), CLOSEOUT_POSTED_MARKER)),
			).toBe(true);
			expect(claimsLeft(repo)).toEqual([]);
		});
	});

	it("a fresh claim: another verify is posting it", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			writeClaim(repo, "closeout.claim-1", {
				verifyRunId: "v-0",
				pid: process.pid,
				host: hostname(),
				claimedAt: Date.now(),
			});
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (another verify is posting this review's close-out)",
			);
		});
	});

	it("closeout.posted: already posted, and the PR is not asked", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			writeClaim(repo, CLOSEOUT_POSTED_MARKER, "{}");
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
			expect(
				gh.calls.filter((call) => call.args.includes("--paginate")),
			).toHaveLength(0);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (this review's close-out is already posted)",
			);
		});
	});

	it("every generation left stale and no card: nothing posts, and the reply says how to clear them", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			for (let g = 1; g <= 5; g += 1) {
				writeClaim(repo, `closeout.claim-${g}`, stale());
			}
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyOnce(repo, gh, "v-1", clean);
			expect(closeoutPosts(gh.calls)).toHaveLength(0);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR close-out: not posted (closeout.claim-1 to closeout.claim-5 were all left by verifies that stopped; delete them from the review's run record to post it)",
			);
		});
	});

	it("a failed close-out post removes its claim and writes no marker", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({
				pulls: [openPr(12, head)],
				failPost: { at: 2, error: new Error("boom") },
			});
			await verifyOnce(repo, gh, "v-1", clean);
			expect(claimsLeft(repo)).toEqual([]);
			expect(
				existsSync(path.join(reviewRecordDir(repo), CLOSEOUT_POSTED_MARKER)),
			).toBe(false);
		});
	});
});

describe("fix round 3: round markers and claims through the verify action", () => {
	it("a posted verify writes round.posted in its own record and round-1.posted in the review's (L4)", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyOnce(repo, gh, "v-1");
			expect(
				JSON.parse(
					readFileSync(
						path.join(
							repo,
							".review-panel",
							"runs",
							"v-1",
							ROUND_POSTED_MARKER,
						),
						"utf8",
					),
				),
			).toEqual({ pr: 12, round: 1 });
			expect(
				existsSync(path.join(reviewRecordDir(repo), "round-1.posted")),
			).toBe(true);
			expect(
				readdirSync(reviewRecordDir(repo)).filter((name) =>
					name.endsWith(".claim"),
				),
			).toEqual([]);
		});
	});

	it("a stale round-1.claim is skipped: the verify posts verify 2 and leaves the stale claim", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			writeFileSync(
				path.join(reviewRecordDir(repo), "round-1.claim"),
				JSON.stringify({
					verifyRunId: "v-0",
					pid: deadPid(),
					host: hostname(),
					claimedAt: Date.now(),
				}),
			);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyOnce(repo, gh, "v-1");
			expect(headingsOf(gh.calls)).toEqual(["## Review panel · verify 2"]);
			expect(
				existsSync(path.join(reviewRecordDir(repo), "round-1.claim")),
			).toBe(true);
		});
	});

	it("a verify body that cannot be rendered gives its claim back (L4)", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, RENDER_FAILS_ROWS);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRunSeats(
							repo,
							"v-1",
							REVIEW_ID,
							RENDER_FAILS_ROWS,
							STILL,
						),
					}),
				},
			);
			expect(textOf(result)).toMatch(
				/PR comment: not posted \(the comment could not be built: /,
			);
			expect(posts(gh.calls)).toHaveLength(0);
			expect(
				readdirSync(reviewRecordDir(repo)).filter((name) =>
					name.includes("round-"),
				),
			).toEqual([]);
		});
	});
});

describe("fix round 2: the abort signal reaches gh (L2)", () => {
	it("the round hands the run's signal to every gh call", async () => {
		await withRepository(async (repo, head) => {
			const controller = new AbortController();
			const seen: Array<AbortSignal | undefined> = [];
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					signal: controller.signal,
					deps: deps(
						(args, options) => {
							seen.push(
								(options as { signal?: AbortSignal } | undefined)?.signal,
							);
							return gh.runGh(args, options);
						},
						{
							runReview: reviewRun(repo, "r-1", []),
						},
					),
				},
			);
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.every((signal) => signal === controller.signal)).toBe(true);
		});
	});

	it("an abort kills a running gh at once, and the reply says the run was interrupted", async () => {
		const bin = mkdtempSync(path.join(tmpdir(), "rounds-abort-gh-"));
		writeFileSync(
			path.join(bin, "gh"),
			["#!/bin/sh", "exec sleep 20"].join("\n"),
			{
				mode: 0o755,
			},
		);
		const savedPath = process.env.PATH;
		try {
			await withRepository(async (repo) => {
				process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
				const controller = new AbortController();
				const { runGh: _unused, ...rest } = deps(fakeGh().runGh, {
					runReview: async (config) => {
						setTimeout(() => controller.abort(), 200);
						return reviewRun(repo, "r-1", [])(config);
					},
				});
				const started = Date.now();
				const result = await reviewAction(
					{ repoDir: repo, base: "main~1", head: "main" },
					{ signal: controller.signal, deps: rest },
				);
				expect(Date.now() - started).toBeLessThan(5_000);
				expect(textOf(result).split("\n").at(-1)).toBe(
					"PR comment: not posted (the run was interrupted)",
				);
			});
		} finally {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("defaultRunGh rejects as soon as its signal aborts", async () => {
		const bin = mkdtempSync(path.join(tmpdir(), "rounds-abort-gh-"));
		writeFileSync(
			path.join(bin, "gh"),
			["#!/bin/sh", "exec sleep 20"].join("\n"),
			{
				mode: 0o755,
			},
		);
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const started = Date.now();
			await expect(
				defaultRunGh(["api", "user"], { signal: controller.signal }),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			process.env.PATH = savedPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("fix round 2: posted text (M1, L3, L4, L7)", () => {
	it("escapes the dot of every www. so GitHub's autolinker cannot fire", () => {
		expect(postedText("see www.evil.example/p")).toBe(
			"see www\\.evil.example/p",
		);
		expect(postedText("_www.e.example")).toBe("\\_www\\.e.example");
		expect(postedText("(WWW.x.example)")).toBe("\\(WWW\\.x.example\\)");
		expect(postedText("www.e")).not.toMatch(/‍/);
	});

	it("escapes a backslash so seat text cannot unescape a tag", () => {
		expect(postedText("\\<img src=x>")).toBe("\\\\\\<img src=x\\>");
		expect(postedText("trail\\")).toBe("trail\\\\");
	});

	it("escapes $ so no math renders", () => {
		expect(postedText("$x$ and $$y$$")).toBe("\\$x\\$ and \\$\\$y\\$\\$");
	});

	it("puts no joiner inside a code span, so copied paths still work", () => {
		expect(postedCode("node_modules/@types/x/index.d.ts")).toBe(
			"`node_modules/@types/x/index.d.ts`",
		);
		expect(postedCode("src/C#/a.cs")).toBe("`src/C#/a.cs`");
		// Outside a code span the joiner still breaks the mention.
		expect(postedText("@types/x")).toBe("@‍types/x");
	});

	it("keeps emoji presentation selectors and joiners inside emoji sequences", () => {
		expect(postedText("⚠️ warn")).toBe("⚠️ warn");
		expect(postedText("👨‍👩‍👧 fam")).toBe("👨‍👩‍👧 fam");
		// Anywhere else they are still replaced.
		expect(postedText("a️b")).toBe("a�b");
		expect(postedText("a‍b")).toBe("a�b");
		expect(postedText("⚠‍b")).toBe("⚠�b");
	});

	it("evidence that reads as a block marker stays behind the Evidence: label", async () => {
		const rows: Row[] = [
			{ id: "F-1", severity: "high", evidence: "===" },
			{ id: "F-2", severity: "medium", evidence: "1. x" },
		];
		await withRepository(async (repo, head) => {
			const review = fakeGh({ pulls: [openPr(12, head)] });
			await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps(review.runGh, { runReview: reviewRun(repo, "r-1", rows) }),
				},
			);
			expectInert(bodyOf(posts(review.calls)[0]));
			writeReviewRecord(repo, REVIEW_ID, rows);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: REVIEW_ID,
					head: "HEAD",
					keptFindingIds: ["F-1", "F-2"],
				},
				{
					deps: deps(gh.runGh, {
						runVerify: verifyRun(
							repo,
							"v-1",
							REVIEW_ID,
							rows,
							[
								{
									id: "F-1",
									disposition: "still present",
									evidence: { file: "src/a.ts", explanation: "===" },
								},
								{
									id: "F-2",
									disposition: "still present",
									evidence: { file: "src/a.ts", explanation: "> q" },
								},
							],
							[{ title: "r", file: "src/c.ts", evidence: "===" }],
						),
					}),
				},
			);
			expectInert(bodyOf(posts(gh.calls)[0]));
		});
	});
});

describe("fix round 2: one round's gh calls share a deadline (L7)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("each call gets at most 30 s, then what is left of 60 s, then none", async () => {
		await withRepository(async (repo, head) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const timeouts: Array<number | undefined> = [];
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps(
						(args, options) => {
							timeouts.push(options?.timeoutMs);
							vi.setSystemTime(Date.now() + 25_000);
							return gh.runGh(args, options);
						},
						{ runReview: reviewRun(repo, "r-1", []) },
					),
				},
			);
			// user at 0 s, repo view at 25 s, pulls lookup at 50 s, POST refused at 75 s.
			expect(timeouts).toEqual([30_000, 30_000, 10_000]);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (gh took longer than 60 s in total)",
			);
		});
	});

	it("an interrupt during one call stops the next", async () => {
		await withRepository(async (repo, head) => {
			const controller = new AbortController();
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					signal: controller.signal,
					deps: deps(
						(args, options) => {
							controller.abort();
							return gh.runGh(args, options);
						},
						{ runReview: reviewRun(repo, "r-1", []) },
					),
				},
			);
			expect(gh.calls).toHaveLength(1);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (the run was interrupted)",
			);
		});
	});
});

describe("fix round 2: the manual card is capped too (L5)", () => {
	it("cuts whole rows to stay under GitHub's limit", async () => {
		const { assembleCloseoutComment } = await import(
			"../src/tool/closeout-comment.js"
		);
		const rows: Row[] = Array.from({ length: 80 }, (_, index) => ({
			id: `F-${index + 1}`,
			severity: "high" as const,
			title: "#".repeat(300),
		}));
		const card = assembleCloseoutComment({
			findings: rows.map(stamped),
			panel: {
				runId: "r",
				baseRef: "main",
				seats: [
					{ rosterId: "terra", lens: "holistic", provider: "p", model: "m" },
				],
			} as never,
			lost: [],
			meta: {
				baseRef: "main",
				baseOid: "a".repeat(40),
				headOid: "b".repeat(40),
			},
			dismissed: rows.map((row) => ({ id: row.id, reason: "#".repeat(1_000) })),
			lowAdvisory: [],
		});
		expect(card.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
		expect(card).toMatch(/- \d+ row\(s\) cut to fit GitHub's comment limit/);
		expect(card.split("\n")[0]).toBe("## Review panel");
	});
});

describe("fix round 2: nits", () => {
	it("a top-level JSON string is a malformed comment listing", () => {
		expect(parseJsonPages('"x"')).toBeUndefined();
		expect(parseJsonPages('"[]"')).toBeUndefined();
		expect(parseJsonPages("[]")).toEqual([]);
		expect(parseJsonPages('[{"a":"]"}]')).toEqual([{ a: "]" }]);
	});

	it("a kept high listed as low/advisory is refused; a kept low is not", () => {
		const findings = [
			stamped({ id: "F-1", severity: "high" }),
			stamped({ id: "F-2", severity: "low" }),
		];
		expect(() => assertVerifyJudgment(findings, ["F-1"], [], ["F-1"])).toThrow(
			/F-1 is high/,
		);
		expect(() =>
			assertVerifyJudgment(findings, ["F-2"], [], ["F-2"]),
		).not.toThrow();
	});
});

describe("fix round 3: the interrupt reply", () => {
	it("an interrupt during a verify's POST gives its number back, and the reply says so exactly", async () => {
		await withRepository(async (repo, head) => {
			writeReviewRecord(repo, REVIEW_ID, ROWS_R2);
			const gh = fakeGh({ pulls: [openPr(12, head)] });
			const controller = new AbortController();
			const runGh: GhRunner = (args, options) => {
				if (!args.includes("POST")) {
					return gh.runGh(args, options);
				}
				setTimeout(() => controller.abort(), 10);
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				});
			};
			const result = await verifyOnce(
				repo,
				{ runGh },
				"v-1",
				STILL,
				controller.signal,
			);
			expect(textOf(result).split("\n").at(-1)).toBe(
				"PR comment: not posted (the run was interrupted; verify 1 is left for the next verify)",
			);
			expect(
				readdirSync(reviewRecordDir(repo)).filter((name) =>
					name.startsWith("round-"),
				),
			).toEqual([]);
		});
	});
});

describe("fix round 3: nits", () => {
	it.each([
		["empty", ""],
		["spaces", "   "],
		["NEL", "\u0085"],
		["zero-width space", "​"],
		["bidi and joiner", "‮‍⁠"],
	])(
		"a code value with nothing visible (%s) renders as (empty), never as a bare fence",
		(_name, value) => {
			expect(postedCode(value)).toBe("(empty)");
		},
	);

	it("a visible code value is still a code span", () => {
		expect(postedCode(" a ")).toBe("`a`");
	});
});
