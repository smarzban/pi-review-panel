import { execFileSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	type ActionDependencies,
	auditAction,
	commentAction,
	diagnoseAction,
	parseAuditArguments,
	parseCommentArguments,
	parseDiagnoseArguments,
	parseResumeArguments,
	parseReviewArguments,
	parseVerifyArguments,
	resumeAction,
	reviewAction,
	verifyAction,
} from "../src/actions/actions.js";
import { resolveReviewRepository } from "../src/actions/repository.js";
import type { Config } from "../src/config/schema.js";
import type { RunAuditResult } from "../src/run/run-audit.js";
import { type RunReviewResult, runReview } from "../src/run/run-review.js";
import type { PlannedSeat } from "../src/run/types.js";
import type { ReviewProgressView } from "../src/tool/review-presentation.js";
import { TEST_RECORD_KEY } from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

const ACTION_MODULES = ["src/actions/actions.ts", "src/actions/repository.ts"];

/** Static `import`/`export … from` specifiers; a dynamic `import(x)` is not one. */
function staticSpecifiers(source: string): string[] {
	const pattern =
		/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
	return [...source.matchAll(pattern)].map(
		(match) => (match[1] ?? match[2]) as string,
	);
}

/** Every source file the module reaches through static relative imports. */
function importGraph(entries: string[]): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	const pending = entries.map((entry) => path.resolve(entry));
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (graph.has(file)) {
			continue;
		}
		const specifiers = staticSpecifiers(readFileSync(file, "utf8"));
		graph.set(file, specifiers);
		for (const specifier of specifiers) {
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

function deps(overrides: ActionDependencies = {}): ActionDependencies {
	return {
		env: {},
		home: "/tmp/actions-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		...overrides,
	};
}

describe("review_panel actions without Pi", () => {
	it("reach no typebox or Pi package through any static import", () => {
		const graph = importGraph(ACTION_MODULES);
		const files = [...graph.keys()].map((file) =>
			path.relative(process.cwd(), file),
		);
		expect(files).toContain("src/run/run-review.ts");
		expect(files).not.toContain("src/tool/review-panel.ts");
		const offenders = [...graph.entries()].flatMap(([file, specifiers]) =>
			specifiers
				.filter((specifier) =>
					/^(typebox|@earendil-works)(\/|$)/.test(specifier),
				)
				.map(
					(specifier) => `${path.relative(process.cwd(), file)}: ${specifier}`,
				),
		);
		expect(offenders).toEqual([]);
	});

	it("diagnose reports readiness from plain inputs", async () => {
		await withRepository(async (repo) => {
			expect(parseDiagnoseArguments({ action: "diagnose" })).toEqual({});
			expect(() =>
				parseDiagnoseArguments({ action: "diagnose", seats: ["x"] }),
			).toThrow('diagnose does not accept argument "seats"');
			const result = await diagnoseAction({ repoDir: repo }, { deps: deps() });
			expect(result.content[0]?.text).toMatch(/ready/i);
		});
	});

	it("review runs through injected seams and reports progress views", async () => {
		await withRepository(async (repo) => {
			const views: ReviewProgressView[] = [];
			const input = parseReviewArguments({
				action: "review",
				base: "main~1",
				head: "main",
			});
			const result = await reviewAction(
				{ repoDir: resolveReviewRepository(repo, "/"), ...input },
				{
					deps: deps({
						runReview: async (runConfig) =>
							({
								recordPath: path.join(repo, ".review-panel", "runs", "r-1"),
								outcomes: runConfig.seats.map((seat) => ({
									seat,
									outcome: { kind: "voted" as const, findings: [] },
								})),
							}) as unknown as RunReviewResult,
					}),
					onProgress: (view) => views.push(view),
				},
			);
			expect(result.content[0]?.text).toContain("# Review panel");
			expect(views[0]).toMatchObject({ phase: "review", event: "started" });
		});
	});

	it("audit runs through injected seams", async () => {
		await withRepository(async (repo) => {
			const input = parseAuditArguments({
				action: "audit",
				passes: ["security"],
			});
			const result = await auditAction(
				{ repoDir: repo, ...input },
				{
					deps: deps({
						runAudit: async (auditInput) =>
							({
								recordPath: path.join(repo, ".review-panel", "runs", "a-1"),
								outcomes: auditInput.seats.map((seat) => ({
									seat,
									outcome: { kind: "voted" as const, findings: [] },
								})),
							}) as unknown as RunAuditResult,
					}),
				},
			);
			expect(result.content[0]?.text).toContain("# Repository audit");
		});
	});

	it("verify runs through injected seams", async () => {
		await withRepository(async (repo) => {
			const input = parseVerifyArguments({
				action: "verify",
				priorRunId: "run-1",
				head: "HEAD",
				keptFindingIds: ["F-1"],
			});
			expect(input).toMatchObject({ keptFindingIds: ["F-1"] });
			const result = await verifyAction(
				{ repoDir: repo, ...input },
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
			expect(result.content[0]?.text).toContain("# Review panel verify");
		});
	});

	it("resume finishes an interrupted review record", async () => {
		await withRepository(async (repo) => {
			const seats: PlannedSeat[] = ["correctness", "security"].map(
				(lens, index) => ({
					rosterId: `seat-${index}`,
					provider: "openai-codex",
					model: `gpt-5.6-${index}`,
					lens,
					lensPrompt: `Review through ${lens}.`,
				}),
			);
			const controller = new AbortController();
			const interrupted = createSdkSeatFake([
				{ kind: "default" },
				{ kind: "pending" },
			]);
			await expect(
				runReview(
					{ repoDir: repo, baseRef: "HEAD~1", seats },
					{
						abortSignal: controller.signal,
						recordKey: TEST_RECORD_KEY,
						sessionFactory: interrupted.factory,
						onProgress: (event) => {
							if (event.kind === "seat-finished") {
								controller.abort();
							}
						},
					},
				),
			).rejects.toThrow(/cancel/i);
			const runId = readdirSync(
				path.join(repo, ".review-panel", "runs"),
			)[0] as string;
			const input = parseResumeArguments({
				action: "resume",
				priorRunId: runId,
			});
			const fake = createSdkSeatFake();
			const { resumeRun } = await import("../src/run/resume.js");
			const result = await resumeAction(
				{ repoDir: repo, ...input },
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
			expect(result.content[0]?.text).toContain(
				`Resumed ${runId}: ran 1 of 2 planned seats again`,
			);
		});
	});

	it("comment posts the close-out card through the injected poster", async () => {
		await withRepository(async (repo) => {
			const recordPath = path.join(repo, ".review-panel", "runs", "review-1");
			mkdirSync(recordPath, { recursive: true });
			const seat = {
				rosterId: "terra",
				lens: "holistic",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			};
			writeFileSync(
				path.join(recordPath, "panel.json"),
				JSON.stringify({ runId: "review-1", baseRef: "main", seats: [seat] }),
			);
			writeFileSync(
				path.join(recordPath, "meta.json"),
				JSON.stringify({
					runId: "review-1",
					baseRef: "main",
					baseOid: "a".repeat(40),
					headOid: "b".repeat(40),
				}),
			);
			writeFileSync(path.join(recordPath, "findings.json"), "[]");
			writeFileSync(
				path.join(recordPath, "execution.json"),
				JSON.stringify({ cancelled: false, lostCoverage: [], outcomes: [] }),
			);
			writeFileSync(path.join(recordPath, "COMPLETE"), "");
			expect(() =>
				parseCommentArguments({ action: "comment", priorRunId: "review-1" }),
			).toThrow(/ownerApproved must be true/);
			const input = parseCommentArguments({
				action: "comment",
				priorRunId: "review-1",
				ownerApproved: true,
				pr: 7,
			});
			let posted: string | undefined;
			const result = await commentAction(
				{ repoDir: repo, ...input },
				{
					deps: deps({
						postComment: (post) => {
							posted = post.body;
							return {
								action: "created",
								commentId: 1,
								pr: 7,
								url: "https://example.test/pull/7#issuecomment-1",
							};
						},
					}),
				},
			);
			expect(posted).toContain("## Review panel");
			expect(result.content[0]?.text).toContain("Posted comment on PR #7");
		});
	});
});
