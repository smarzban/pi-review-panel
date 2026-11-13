import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	auditAction,
	type CommentInput,
	commentAction,
	diagnoseAction,
	ownerRecordKey,
	ownerRecordKeyCheck,
	resumeAction,
	reviewAction,
	verifyAction,
} from "../src/actions/actions.js";
import type { Config } from "../src/config/schema.js";
import { resumeRun } from "../src/run/resume.js";
import type { RunAuditResult } from "../src/run/run-audit.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type { PlannedSeat } from "../src/run/types.js";
import type { PostCloseoutInput } from "../src/tool/closeout-post.js";
import { createReviewPanelTool } from "../src/tool/review-panel.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import { TEST_RECORD_KEY } from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

/**
 * What the Pi tool tests cannot show: that each action runs from plain inputs
 * (no Pi host, no TypeBox, no argument parser, no repository resolution), and
 * that it refuses a bad input itself. The tool's behaviour through these
 * actions is pinned in `review-panel.test.ts` and `audit-tool.test.ts`.
 */

const ACTION_MODULES = ["src/actions/actions.ts", "src/actions/repository.ts"];
const BANNED = /^(typebox|@earendil-works)(\/|$)/;

/**
 * Specifiers a module loads when it is imported: static `import`/`export …
 * from`, side-effect `import "…"`, and `require("…")` (including `import x =
 * require("…")`). A dynamic `import(x)` is not one: it runs only when called.
 */
function loadedSpecifiers(source: string): string[] {
	const staticPattern =
		/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
	const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
	return [
		...[...source.matchAll(staticPattern)].map(
			(match) => (match[1] ?? match[2]) as string,
		),
		...[...source.matchAll(requirePattern)].map((match) => match[1] as string),
	];
}

/** Every source file the modules reach through relative imports. */
function importGraph(entries: string[]): Map<string, string> {
	const graph = new Map<string, string>();
	const pending = entries.map((entry) => path.resolve(entry));
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (graph.has(file)) {
			continue;
		}
		const source = readFileSync(file, "utf8");
		graph.set(file, source);
		for (const specifier of loadedSpecifiers(source)) {
			if (specifier.startsWith(".")) {
				const target = path
					.resolve(path.dirname(file), specifier)
					.replace(/\.js$/, ".ts");
				expect(existsSync(target), `${file} imports ${specifier}`).toBe(true);
				pending.push(target);
			}
		}
	}
	return graph;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function withRepository(test: (repo: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "actions-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "actions@example.test"]);
	git(repo, ["config", "user.name", "Actions Test"]);
	writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	writeFileSync(path.join(repo, "head.txt"), "head\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "head", "--quiet"]);
	return test(realpathSync(repo)).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

const config: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
	],
	defaults: { seats: ["terra", "claude"] },
};

const HOME = "/tmp/actions-home";

function deps(overrides: ActionDependencies = {}): ActionDependencies {
	return {
		env: {},
		home: HOME,
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		...overrides,
	};
}

function textOf(result: ActionResult): string {
	expect(result.content).toHaveLength(1);
	expect(result.content[0]?.type).toBe("text");
	return result.content[0]?.text ?? "";
}

function voted(repo: string, runId: string, seats: PlannedSeat[]) {
	return {
		recordPath: path.join(repo, ".review-panel", "runs", runId),
		outcomes: seats.map((seat) => ({
			seat,
			outcome: { kind: "voted" as const, findings: [] },
		})),
	};
}

/** A complete review record, as `comment` reads it. */
function writeReviewRecord(
	repo: string,
	runId: string,
	findings: Array<{ id: string; severity: "high" | "medium" | "low" }>,
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	const seat = {
		rosterId: "terra",
		lens: "holistic",
		provider: "openai-codex",
		model: "gpt-5.6-terra",
	};
	writeFileSync(
		path.join(recordPath, "panel.json"),
		JSON.stringify({ runId, baseRef: "main", seats: [seat] }),
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
		JSON.stringify(
			findings.map((row) => ({
				id: row.id,
				seat: { provider: seat.provider, model: seat.model, lens: seat.lens },
				finding: {
					file: "src/a.ts",
					line: 1,
					severity: row.severity,
					title: `${row.id} title`,
					evidence: "evidence",
				},
			})),
		),
	);
	writeFileSync(
		path.join(recordPath, "execution.json"),
		JSON.stringify({ cancelled: false, lostCoverage: [], outcomes: [] }),
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

/** A `postComment` seam that records each body it was asked to post. */
function poster() {
	const bodies: string[] = [];
	return {
		bodies,
		postComment: (input: PostCloseoutInput) => {
			bodies.push(input.body);
			return {
				action: "created" as const,
				commentId: 1,
				pr: 7,
				url: "https://example.test/pull/7#issuecomment-1",
			};
		},
	};
}

describe("review_panel actions without Pi", () => {
	it("reach no typebox or Pi package through any import that loads with the module", () => {
		const graph = importGraph(ACTION_MODULES);
		const files = [...graph.keys()].map((file) =>
			path.relative(process.cwd(), file),
		);
		expect(files).toContain("src/run/run-review.ts");
		expect(files).not.toContain("src/tool/review-panel.ts");
		const offenders = [...graph.entries()].flatMap(([file, source]) => {
			const relative = path.relative(process.cwd(), file);
			return [
				...loadedSpecifiers(source)
					.filter((specifier) => BANNED.test(specifier))
					.map((specifier) => `${relative}: ${specifier}`),
				// createRequire can load any package by a computed name.
				...(/\bcreateRequire\b/.test(source)
					? [`${relative}: createRequire`]
					: []),
			];
		});
		expect(offenders).toEqual([]);
	});

	it("diagnose reports ready", async () => {
		await withRepository(async (repo) => {
			const result = await diagnoseAction({ repoDir: repo }, { deps: deps() });
			expect(textOf(result)).toBe(
				[
					"# Review panel readiness",
					"- Status: ready",
					"- All configured prerequisites are available.",
				].join("\n"),
			);
		});
	});

	it("diagnose reports needs setup when the record key has a problem", async () => {
		await withRepository(async (repo) => {
			const result = await diagnoseAction(
				{ repoDir: repo },
				{
					deps: deps({
						checkRecordKey: () => ({
							cause: "record key is missing",
							fix: "Run a review to create it.",
						}),
					}),
				},
			);
			expect(textOf(result)).toBe(
				[
					"# Review panel readiness",
					"- Status: needs setup",
					"## Required remediation",
					`- record key ${HOME}/.pi-review-panel/record-key: record key is missing. Run a review to create it.`,
				].join("\n"),
			);
		});
	});

	it("diagnose stays ready on a record-key warning and shows it after the report", async () => {
		await withRepository(async (repo) => {
			const result = await diagnoseAction(
				{ repoDir: repo },
				{
					deps: deps({
						checkRecordKey: () => ({
							cause: "record key folder is group-writable",
							fix: "Run chmod g-w on it.",
							warning: true,
						}),
					}),
				},
			);
			expect(textOf(result)).toBe(
				[
					"# Review panel readiness",
					"- Status: ready",
					"- All configured prerequisites are available.",
					"## Warnings",
					"- record key folder is group-writable. Run chmod g-w on it.",
				].join("\n"),
			);
		});
	});

	it("diagnose cuts a long record-key warning to 1,500 characters and stays ready", async () => {
		await withRepository(async (repo) => {
			const cause = "x".repeat(2_000);
			const result = await diagnoseAction(
				{ repoDir: repo },
				{
					deps: deps({
						checkRecordKey: () => ({ cause, fix: "Fix it.", warning: true }),
					}),
				},
			);
			const text = textOf(result);
			expect(text).toContain("- Status: ready");
			const line = text.split("\n").at(-1) ?? "";
			expect(line).toBe(`- ${"x".repeat(1_500)}…`);
		});
	});

	it("review runs from plain inputs", async () => {
		await withRepository(async (repo) => {
			const result = await reviewAction(
				{ repoDir: repo, base: "main~1", head: "main" },
				{
					deps: deps({
						runReview: async (runConfig) =>
							voted(repo, "r-1", runConfig.seats) as unknown as RunReviewResult,
					}),
				},
			);
			expect(textOf(result)).toBe(
				[
					"# Review panel",
					"2/2 voted · 0 findings",
					`Record: \`${path.join(repo, ".review-panel", "runs", "r-1")}\``,
					"",
					"None submitted.",
					"",
					"Not a merge decision.",
				].join("\n"),
			);
		});
	});

	it("audit runs from plain inputs", async () => {
		await withRepository(async (repo) => {
			const result = await auditAction(
				{ repoDir: repo, passes: ["security"] },
				{
					deps: deps({
						runAudit: async (input) =>
							voted(repo, "a-1", input.seats) as unknown as RunAuditResult,
					}),
				},
			);
			expect(textOf(result)).toBe(
				[
					"# Repository audit",
					"2/2 voted · 0 findings",
					`Record: \`${path.join(repo, ".review-panel", "runs", "a-1")}\``,
					"",
					"None submitted.",
					"",
					"Not a merge decision.",
				].join("\n"),
			);
		});
	});

	it("verify runs from plain inputs", async () => {
		await withRepository(async (repo) => {
			const result = await verifyAction(
				{
					repoDir: repo,
					priorRunId: "run-1",
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps({
						runVerify: async () => ({
							recordPath: path.join(repo, ".review-panel", "runs", "v-1"),
							priorRunId: "run-1",
							priorHeadOid: "a".repeat(40),
							headOid: "b".repeat(40),
							kept: [],
							outcomes: [],
						}),
					}),
				},
			);
			expect(textOf(result)).toBe(
				[
					"# Review panel verify",
					"0/0 voted · no kept ids · no regressions",
					`Record: \`${path.join(repo, ".review-panel", "runs", "v-1")}\``,
					"",
					"Not a merge decision.",
				].join("\n"),
			);
		});
	});

	it("resume runs from plain inputs", async () => {
		await withRepository(async (repo) => {
			const seats = plannedSeats(["correctness", "security"]);
			const runId = await interruptedReviewRecord(repo, seats);
			const fake = createSdkSeatFake();
			const result = await resumeAction(
				{ repoDir: repo, priorRunId: runId },
				{
					deps: deps({
						loadConfig: () => ({
							roster: seats.map((seat) => ({
								id: seat.rosterId,
								provider: seat.provider,
								model: seat.model,
							})),
							defaults: { seats: ["seat-0"] },
						}),
						resumeRun: (run, options) =>
							resumeRun(run, {
								...(options as NonNullable<typeof options>),
								sessionFactory: fake.factory,
							}),
					}),
				},
			);
			expect(textOf(result).split("\n")[0]).toBe(
				`Resumed ${runId}: ran 1 of 2 planned seats again (seat-1/security); kept 1 as recorded.`,
			);
		});
	});

	it("comment runs from plain inputs", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1", []);
			const { bodies, postComment } = poster();
			const result = await commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: "review-1",
					dismissed: [],
					lowAdvisory: [],
					pr: 7,
				},
				{ deps: deps({ postComment }) },
			);
			expect(bodies).toHaveLength(1);
			expect(textOf(result)).toBe(
				[
					"Posted comment on PR #7 (created)",
					"https://example.test/pull/7#issuecomment-1",
					"",
					bodies[0],
				].join("\n"),
			);
		});
	});
});

describe("comment refuses without the owner's approval, whoever builds its input", () => {
	for (const [label, approval] of [
		["false", { ownerApproved: false }],
		["omitted", {}],
	] as const) {
		it(`ownerApproved ${label}`, async () => {
			await withRepository(async (repo) => {
				writeReviewRecord(repo, "review-1", []);
				const { bodies, postComment } = poster();
				const input = {
					repoDir: repo,
					priorRunId: "review-1",
					dismissed: [],
					lowAdvisory: [],
					...approval,
				} as unknown as CommentInput & { repoDir: string };
				await expect(
					commentAction(input, { deps: deps({ postComment }) }),
				).rejects.toThrow(
					/^comment refused: ownerApproved must be true after the owner asked to post$/,
				);
				expect(bodies).toEqual([]);
			});
		});
	}
});

type Case = {
	action: "review" | "audit" | "verify" | "resume" | "comment";
	args: Record<string, unknown>;
	message: string;
};

const ACTIONS = {
	review: reviewAction,
	audit: auditAction,
	verify: verifyAction,
	resume: resumeAction,
	comment: commentAction,
} as const;

const verifyArgs = {
	priorRunId: "run-1",
	head: "HEAD",
	keptFindingIds: ["F-1"],
};
const commentArgs = { ownerApproved: true, priorRunId: "review-1" };

/** Bad inputs a caller that skips `parse*` might send, and the tool's refusal. */
const CASES: Case[] = [
	{
		action: "review",
		args: { base: "", head: "HEAD" },
		message: "base must be a non-empty string",
	},
	{
		action: "review",
		args: { base: "HEAD~1", head: "" },
		message: "head must be a non-empty string",
	},
	{
		action: "audit",
		args: { seats: [] },
		message: "seats must be a non-empty array of non-empty strings",
	},
	{
		action: "audit",
		args: { passes: [""] },
		message: "passes must contain only non-empty strings",
	},
	{
		action: "audit",
		args: { scopingNote: " " },
		message: "scopingNote must be a non-empty string",
	},
	{
		action: "verify",
		args: { ...verifyArgs, priorRunId: "" },
		message: "priorRunId must be a non-empty string",
	},
	{
		action: "verify",
		args: { ...verifyArgs, head: "" },
		message: "head must be a non-empty string",
	},
	{
		action: "verify",
		args: { ...verifyArgs, keptFindingIds: undefined },
		message: "keptFindingIds must be an array of non-empty strings",
	},
	{
		action: "verify",
		args: { ...verifyArgs, keptFindingIds: [""] },
		message: "keptFindingIds[0] must be a non-empty string",
	},
	{
		action: "verify",
		args: { ...verifyArgs, seats: [] },
		message: "seats must be a non-empty array of non-empty strings",
	},
	{
		action: "verify",
		args: { ...verifyArgs, scopingNote: "" },
		message: "scopingNote must be a non-empty string",
	},
	{
		action: "resume",
		args: { priorRunId: "" },
		message: "priorRunId must be a non-empty string",
	},
	{
		action: "comment",
		args: { ...commentArgs, priorRunId: "" },
		message: "priorRunId must be a non-empty string",
	},
	{
		action: "comment",
		args: { ...commentArgs, dismissed: [{ id: "", reason: "r" }] },
		message: "dismissed[0].id must be a non-empty string",
	},
	{
		action: "comment",
		args: { ...commentArgs, lowAdvisory: [3] },
		message: "lowAdvisory[0] must be a finding id",
	},
	{
		action: "comment",
		args: { ...commentArgs, verifyRunId: "" },
		message:
			"comment refused: F-1 still outstanding; pass verifyRunId after a clean verify or dismiss them",
	},
];

describe("each action refuses a bad input itself, as the tool does", () => {
	function refusingDeps(): ActionDependencies {
		const never = () => {
			throw new Error("must not run");
		};
		return deps({
			runReview: never,
			runAudit: never,
			runVerify: never,
			resumeRun: never,
			postComment: never,
		});
	}

	for (const { action, args, message } of CASES) {
		it(`${action} ${JSON.stringify(args)}`, async () => {
			await withRepository(async (repo) => {
				writeReviewRecord(repo, "review-1", [{ id: "F-1", severity: "high" }]);
				const defined = Object.fromEntries(
					Object.entries(args).filter(([, value]) => value !== undefined),
				);
				const tool = createReviewPanelTool(refusingDeps());
				await expect(
					tool.execute(
						"tool-call",
						{ action, repository: repo, ...defined },
						undefined,
						undefined,
						{},
					),
				).rejects.toThrow(message);
				const run = ACTIONS[action] as (
					input: unknown,
					context: { deps: ActionDependencies },
				) => Promise<ActionResult>;
				const direct = run(
					{ repoDir: repo, ...args },
					{ deps: refusingDeps() },
				);
				await expect(direct).rejects.toThrow(message);
				await direct.catch((error: Error) =>
					expect(error.message).toBe(message),
				);
			});
		});
	}

	it("comment drops an empty head the way the tool does", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1", []);
			const viaTool = poster();
			await createReviewPanelTool(
				deps({ postComment: viaTool.postComment }),
			).execute(
				"tool-call",
				{ action: "comment", repository: repo, ...commentArgs, head: "" },
				undefined,
				undefined,
				{},
			);
			const direct = poster();
			await commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: "review-1",
					dismissed: [],
					lowAdvisory: [],
					head: "",
				},
				{ deps: deps({ postComment: direct.postComment }) },
			);
			expect(direct.bodies).toEqual(viaTool.bodies);
		});
	});
});

describe("each action resolves its own repository", () => {
	type Call = (repoDir: string, d: ActionDependencies) => Promise<ActionResult>;
	const calls: Array<[string, Call]> = [
		["diagnose", (repoDir, d) => diagnoseAction({ repoDir }, { deps: d })],
		["audit", (repoDir, d) => auditAction({ repoDir }, { deps: d })],
		[
			"review",
			(repoDir, d) =>
				reviewAction({ repoDir, base: "main~1", head: "main" }, { deps: d }),
		],
		[
			"verify",
			(repoDir, d) =>
				verifyAction(
					{ repoDir, priorRunId: "r-1", head: "main", keptFindingIds: [] },
					{ deps: d },
				),
		],
		[
			"resume",
			(repoDir, d) => resumeAction({ repoDir, priorRunId: "r-1" }, { deps: d }),
		],
		[
			"comment",
			(repoDir, d) =>
				commentAction(
					{
						repoDir,
						ownerApproved: true,
						priorRunId: "r-1",
						dismissed: [],
						lowAdvisory: [],
					},
					{ deps: d },
				),
		],
	];

	it.each(calls)(
		"%s refuses a relative repository path",
		async (_name, call) => {
			await expect(call("repo", deps())).rejects.toThrow(
				"repository must be a non-empty absolute path",
			);
		},
	);

	// comment reads no readiness; its relative-path refusal above proves it
	// resolves the repository through the same call.
	it.each(calls.filter(([name]) => name !== "comment"))(
		"%s works on the repository top level when given a subdirectory",
		async (_name, call) => {
			await withRepository(async (repo) => {
				const sub = path.join(repo, "src");
				mkdirSync(sub);
				const seen: string[] = [];
				await expect(
					call(
						sub,
						deps({
							diagnose: async (input) => {
								seen.push(input.repoDir);
								throw new Error("stop after readiness");
							},
						}),
					),
				).rejects.toThrow("stop after readiness");
				expect(seen).toEqual([repo]);
			});
		},
	);

	it.each(
		calls.filter(([name]) => ["audit", "review", "resume"].includes(name)),
	)(
		"%s hands the record key the repository top level when given a subdirectory",
		async (_name, call) => {
			await withRepository(async (repo) => {
				const sub = path.join(repo, "src");
				mkdirSync(sub);
				const seen: string[] = [];
				await expect(
					call(
						sub,
						deps({
							recordKey: (input) => {
								seen.push(input.repoDir);
								throw new Error("stop at the record key");
							},
						}),
					),
				).rejects.toThrow("stop at the record key");
				expect(seen).toEqual([repo]);
			});
		},
	);

	it("review and audit record their run under the repository top level when given a subdirectory", async () => {
		await withRepository(async (repo) => {
			const sub = path.join(repo, "src");
			mkdirSync(sub);
			const seen: string[] = [];
			const stop = (repoDir: string): never => {
				seen.push(repoDir);
				throw new Error("stop at the runner");
			};
			const d = deps({
				runReview: async (runConfig) => stop(runConfig.repoDir),
				runAudit: async (input) => stop(input.repoDir),
			});
			await expect(
				reviewAction(
					{ repoDir: sub, base: "main~1", head: "main" },
					{ deps: d },
				),
			).rejects.toThrow("stop at the runner");
			await expect(auditAction({ repoDir: sub }, { deps: d })).rejects.toThrow(
				"stop at the runner",
			);
			expect(seen).toEqual([repo, repo]);
		});
	});

	it("the record-key helpers judge a key inside the repository from a subdirectory too", async () => {
		await withRepository(async (repo) => {
			const sub = path.join(repo, "src");
			mkdirSync(sub);
			const env = {
				PI_REVIEW_PANEL_CONFIG: path.join(repo, ".cfg", "config.json"),
			};
			const keyPath = path.join(repo, ".cfg", "record-key");
			mkdirSync(path.join(repo, ".cfg"), { mode: 0o700 });

			expect(
				ownerRecordKeyCheck({ repoDir: sub, env, home: HOME })?.cause,
			).toMatch(/is inside the reviewed repository/);
			expect(() =>
				ownerRecordKey({ repoDir: sub, env, home: HOME, create: true }),
			).toThrow(/is inside the reviewed repository/);
			// A bad config override does not skip the repository check.
			expect(() =>
				ownerRecordKeyCheck({
					repoDir: "relative",
					env: { PI_REVIEW_PANEL_CONFIG: "relative.json" },
					home: HOME,
				}),
			).toThrow("repository must be a non-empty absolute path");
			expect(existsSync(keyPath)).toBe(false);
		});
	});
});
