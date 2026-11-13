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
import { describe, expect, it } from "vitest";

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
import type { GhRunner } from "../src/tool/closeout-post.js";
import { createReviewPanelTool } from "../src/tool/review-panel.js";
import { GITHUB_COMMENT_LIMIT, githubSafe } from "../src/tool/round-post.js";
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
};

function fakeGh(script: GhScript = {}): { calls: GhCall[]; runGh: GhRunner } {
	const calls: GhCall[] = [];
	let nextId = 100;
	const runGh: GhRunner = (args, options) => {
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
		if (/issues\/\d+\/comments/.test(joined) && joined.includes("POST")) {
			nextId += 1;
			const pr = /issues\/(\d+)\//.exec(joined)?.[1];
			return JSON.stringify({
				id: nextId,
				html_url: `https://github.com/${REPO_SLUG}/pull/${pr}#issuecomment-${nextId}`,
			});
		}
		if (/issues\/\d+\/comments/.test(joined)) {
			return JSON.stringify(script.comments ?? []);
		}
		throw new Error(`unexpected gh ${joined}`);
	};
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
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({ runId, kind: "verify", priorRunId }),
	);
	writeFileSync(
		path.join(recordPath, "verification.json"),
		JSON.stringify({ priorRunId, keptFindingIds: [], outcomes: [] }),
	);
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

	it("posts to an explicit pr without looking one up", async () => {
		await withRepository(async (repo) => {
			const gh = fakeGh({ pulls: [] });
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main", pr: 31 },
				{ deps: deps(gh.runGh, { runReview: reviewRun(repo, "r-1", []) }) },
			);
			expect(posts(gh.calls)[0]?.args).toContain(
				`repos/${REPO_SLUG}/issues/31/comments`,
			);
			expect(
				gh.calls.some((call) => call.args.join(" ").includes("/pulls")),
			).toBe(false);
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
			// Not every kept id is resolved: no close-out.
			expect(textOf(result)).not.toContain("PR close-out");
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
			expect(body).not.toMatch(/@[A-Za-z]/);
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
		expect(safe).not.toMatch(/&#|&lt;x/);
		expect(safe.startsWith("&amp;#")).toBe(true);
	});
});
