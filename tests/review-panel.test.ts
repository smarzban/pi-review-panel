// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import type { RunReviewResult } from "../src/run/run-review.js";
import type { PlannedSeat, RunConfig } from "../src/run/types.js";
import reviewPanelExtension, {
	createReviewPanelTool,
	prepareReviewArguments,
} from "../src/tool/review-panel.js";

type ReviewTool = ReturnType<typeof createReviewPanelTool>;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepository(root: string): string {
	const repository = path.join(root, "repository");
	mkdirSync(repository);
	git(repository, ["init", "-b", "main", "--quiet"]);
	git(repository, ["config", "user.email", "test@example.test"]);
	git(repository, ["config", "user.name", "Test"]);
	writeFileSync(path.join(repository, "base.txt"), "base\n");
	git(repository, ["add", "."]);
	git(repository, ["commit", "-m", "base", "--quiet"]);
	writeFileSync(path.join(repository, "head.txt"), "head\n");
	git(repository, ["add", "."]);
	git(repository, ["commit", "-m", "head", "--quiet"]);
	return repository;
}

function withRepository(
	test: (repository: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "review-panel-tool-"));
	return test(makeRepository(root)).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

const sampleConfig: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

function toolWith(
	overrides: Parameters<typeof createReviewPanelTool>[0] = {},
): ReviewTool {
	return createReviewPanelTool({
		env: {},
		home: "/tmp/review-panel-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => sampleConfig,
		...overrides,
	});
}

describe("review_panel public tool adapter", () => {
	it("prepares a stringified lenses list before host schema validation", () => {
		expect(
			prepareReviewArguments({
				action: "review",
				repository: "/tmp/repo",
				base: "main",
				head: "HEAD",
				lenses: '["subtle-correctness"]\n',
			}),
		).toEqual({
			action: "review",
			repository: "/tmp/repo",
			base: "main",
			head: "HEAD",
			lenses: ["subtle-correctness"],
		});
		expect(
			prepareReviewArguments({
				action: "review",
				repository: "/tmp/repo",
				base: "main",
				head: "HEAD",
				lenses: "security",
			}),
		).toMatchObject({ lenses: ["security"] });
	});

	it("turns an empty probe into a copy-paste usage error", async () => {
		const tool = toolWith();
		await expect(
			tool.execute("tool-call", {}, undefined, undefined, {}),
		).rejects.toThrow(/"action": "diagnose"/);
		await expect(
			tool.execute("tool-call", {}, undefined, undefined, {}),
		).rejects.toThrow(/"action": "review"/);
		await expect(
			tool.execute("tool-call", {}, undefined, undefined, {}),
		).rejects.toThrow(/"action": "verify"/);
	});

	it("registers exactly one tool named review_panel", () => {
		const tools: ReviewTool[] = [];
		reviewPanelExtension({ registerTool: (tool) => tools.push(tool) });

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("review_panel");
		expect(JSON.stringify(tools[0]?.parameters)).not.toContain("Type.Unknown");
	});

	it("diagnose launches no reviewer", async () => {
		await withRepository(async (repository) => {
			let reviewed = 0;
			const tool = toolWith({
				runReview: async () => {
					reviewed += 1;
					throw new Error("runReview must not be called");
				},
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "diagnose", repository },
				undefined,
				undefined,
				{ cwd: "/untrusted-context" },
			);

			expect(reviewed).toBe(0);
			expect(response.content[0]?.text).toContain("# Review panel readiness");
			expect(response.content[0]?.text).toContain("ready");
		});
	});

	it("diagnose refuses extra arguments", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith();
			await expect(
				tool.execute(
					"tool-call",
					{ action: "diagnose", repository, base: "HEAD" },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/diagnose does not accept argument "base"/);
		});
	});

	it("review refuses equal revisions", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith();
			const head = git(repository, ["rev-parse", "HEAD"]).trim();
			await expect(
				tool.execute(
					"tool-call",
					{ action: "review", repository, base: head, head },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/same commit/);
		});
	});

	it("review refuses an unknown argument before the core runs", async () => {
		await withRepository(async (repository) => {
			let reviewed = 0;
			const tool = toolWith({
				runReview: async () => {
					reviewed += 1;
					throw new Error("runReview must not be called");
				},
			});
			await expect(
				tool.execute(
					"tool-call",
					{
						action: "review",
						repository,
						base: "HEAD~1",
						head: "HEAD",
						repairAuthorization: "current owner request",
					},
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/repairAuthorization/);
			expect(reviewed).toBe(0);
		});
	});

	it("bare review plans holistic times default seats and no specialists", async () => {
		await withRepository(async (repository) => {
			let planned: PlannedSeat[] | undefined;
			const tool = toolWith({
				runReview: async (config: RunConfig) => {
					planned = config.seats;
					return {
						recordPath: path.join(repository, ".review-panel", "runs", "run-1"),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					} as unknown as RunReviewResult;
				},
			});

			const response = await tool.execute(
				"tool-call",
				{ action: "review", repository, base: "HEAD~1", head: "HEAD" },
				undefined,
				undefined,
				{},
			);

			expect(planned?.map((seat) => [seat.lens, seat.rosterId])).toEqual([
				["holistic", "terra"],
			]);
			expect(response.content[0]?.text).toContain("# Review panel");
			expect(response.content[0]?.text).toContain("1/1 voted · 0 findings");
			expect(response.content[0]?.text).not.toContain("## Seats");
			expect(response.content[0]?.text).not.toMatch(/\bverdict\b/i);
			expect(response.content[0]?.text).toContain(
				path.join(repository, ".review-panel", "runs", "run-1"),
			);
		});
	});

	it("accepts a stringified lenses argument on review", async () => {
		await withRepository(async (repository) => {
			let planned: PlannedSeat[] | undefined;
			const tool = toolWith({
				runReview: async (config: RunConfig) => {
					planned = config.seats;
					return {
						recordPath: path.join(
							repository,
							".review-panel",
							"runs",
							"run-str",
						),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					} as unknown as RunReviewResult;
				},
			});
			await tool.execute(
				"tool-call",
				{
					action: "review",
					repository,
					base: "HEAD~1",
					head: "HEAD",
					lenses: '["security"]\n',
				},
				undefined,
				undefined,
				{},
			);
			expect(planned?.some((seat) => seat.lens === "security")).toBe(true);
		});
	});

	it("optional lenses add at most two-seat specialist rows", async () => {
		await withRepository(async (repository) => {
			let planned: PlannedSeat[] | undefined;
			const twoSeatConfig: Config = {
				roster: [
					{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
					{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
					{ id: "glm", provider: "ollama", model: "glm-5.2" },
				],
				defaults: { seats: ["terra", "claude", "glm"] },
			};
			const tool = toolWith({
				loadConfig: () => twoSeatConfig,
				runReview: async (config: RunConfig) => {
					planned = config.seats;
					return {
						recordPath: path.join(repository, ".review-panel", "runs", "run-2"),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					} as unknown as RunReviewResult;
				},
			});

			await tool.execute(
				"tool-call",
				{
					action: "review",
					repository,
					base: "HEAD~1",
					head: "HEAD",
					lenses: ["security"],
				},
				undefined,
				undefined,
				{},
			);

			expect(planned?.map((seat) => [seat.lens, seat.rosterId])).toEqual([
				["holistic", "terra"],
				["holistic", "claude"],
				["holistic", "glm"],
				["security", "terra"],
				["security", "claude"],
			]);
		});
	});

	it("names a failed seat as lost coverage", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith({
				runReview: async (config: RunConfig) =>
					({
						recordPath: path.join(repository, ".review-panel", "runs", "run-3"),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: {
								kind: "failed" as const,
								class: "no-submit",
								reason: "ended without submit_findings",
							},
						})),
					}) as unknown as RunReviewResult,
			});

			const response = await tool.execute(
				"tool-call",
				{ action: "review", repository, base: "HEAD~1", head: "HEAD" },
				undefined,
				undefined,
				{},
			);

			expect(response.content[0]?.text).toContain(
				"Lost: terra/holistic (no-submit)",
			);
		});
	});

	it("throws unreadiness instead of reviewing", async () => {
		await withRepository(async (repository) => {
			let reviewed = 0;
			const tool = toolWith({
				diagnose: async () => ({
					ready: false,
					rows: [
						{
							prerequisite: "configuration",
							remediation: "Create the outside-repository config.",
						},
					],
				}),
				runReview: async () => {
					reviewed += 1;
					throw new Error("runReview must not be called");
				},
			});

			await expect(
				tool.execute(
					"tool-call",
					{ action: "review", repository, base: "HEAD~1", head: "HEAD" },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/needs setup/);
			expect(reviewed).toBe(0);
		});
	});

	it("includes advisory lens suggestions in the review summary", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith({
				suggestLenses: () => [
					{
						lens: "security",
						reason: "added subprocess line",
						evidence: [{ file: "src/a.ts", line: 1 }],
					},
				],
				runReview: async (config: RunConfig) =>
					({
						recordPath: path.join(repository, ".review-panel", "runs", "run-4"),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					}) as unknown as RunReviewResult,
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "review", repository, base: "HEAD~1", head: "HEAD" },
				undefined,
				undefined,
				{},
			);
			expect(response.content[0]?.text).toContain("Suggest: security");
		});
	});

	it("verify requires a prior run and kept ids", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith();
			await expect(
				tool.execute(
					"tool-call",
					{
						action: "verify",
						repository,
						priorRunId: "missing",
						head: "HEAD",
						keptFindingIds: ["F-1"],
					},
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/prior run/);
		});
	});

	it("verify renders kept dispositions and regressions", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith({
				runVerify: async () => ({
					recordPath: path.join(
						repository,
						".review-panel",
						"runs",
						"verify-1",
					),
					priorRunId: "run-1",
					priorHeadOid: "a".repeat(40),
					headOid: "b".repeat(40),
					kept: [
						{
							id: "F-1",
							seat: {
								provider: "openai-codex",
								model: "gpt-5.6-terra",
								lens: "holistic",
							},
							finding: {
								file: "a.txt",
								line: 1,
								severity: "high",
								title: "bug",
								evidence: "broken",
							},
						},
					],
					outcomes: [
						{
							seat: {
								rosterId: "terra",
								provider: "openai-codex",
								model: "gpt-5.6-terra",
								lens: "fix-verification",
								lensPrompt: "verify",
							},
							outcome: {
								kind: "voted",
								result: {
									items: [
										{
											id: "F-1",
											disposition: "resolved",
											evidence: { file: "a.txt", explanation: "fixed" },
										},
									],
									regressions: [
										{
											regressionId: "regression-1-1",
											file: "b.txt",
											line: 1,
											title: "new hole",
											evidence: "fix introduced it",
										},
									],
								},
							},
						},
					],
				}),
			});
			const response = await tool.execute(
				"tool-call",
				{
					action: "verify",
					repository,
					priorRunId: "run-1",
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				undefined,
				undefined,
				{},
			);
			expect(response.content[0]?.text).toContain("# Review panel verify");
			expect(response.content[0]?.text).toContain("F-1 resolved");
			expect(response.content[0]?.text).toContain("new hole");
			expect(response.content[0]?.text).not.toMatch(/\bverdict\b/i);
		});
	});

	it("forwards in-flight review progress to the host onUpdate", async () => {
		await withRepository(async (repository) => {
			const updates: string[] = [];
			const tool = toolWith({
				runReview: async (config, options) => {
					options?.onProgress?.({
						kind: "seat-started",
						seat: config.seats[0] as PlannedSeat,
						activeSeats: 1,
						completedSeats: 0,
						totalSeats: config.seats.length,
					});
					return {
						recordPath: path.join(
							repository,
							".review-panel",
							"runs",
							"run-progress",
						),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					} as unknown as RunReviewResult;
				},
			});
			await tool.execute(
				"tool-call",
				{ action: "review", repository, base: "HEAD~1", head: "HEAD" },
				undefined,
				(update: { content: Array<{ type: string; text: string }> }) => {
					updates.push(update.content[0]?.text ?? "");
				},
				{},
			);
			expect(updates[0]).toContain("holistic: terra");
			expect(updates[0]).toMatch(/review started · /);
			expect(
				updates.some(
					(line) =>
						line.includes("holistic: terra") && line.includes("terra/holistic"),
				),
			).toBe(true);
			expect(updates.join("\n")).not.toMatch(/\bverdict\b/i);
		});
	});

	it("forwards in-flight verify progress to the host onUpdate", async () => {
		await withRepository(async (repository) => {
			const updates: string[] = [];
			const tool = toolWith({
				runVerify: async (_input, options) => {
					const seat: PlannedSeat = {
						rosterId: "terra",
						provider: "openai-codex",
						model: "gpt-5.6-terra",
						lens: "fix-verification",
						lensPrompt: "verify",
					};
					options?.onProgress?.({
						kind: "seat-started",
						seat,
						completedSeats: 0,
						totalSeats: 1,
					});
					return {
						recordPath: path.join(
							repository,
							".review-panel",
							"runs",
							"verify-p",
						),
						priorRunId: "run-1",
						priorHeadOid: "a".repeat(40),
						headOid: "b".repeat(40),
						kept: [],
						outcomes: [
							{
								seat,
								outcome: {
									kind: "voted",
									result: { items: [], regressions: [] },
								},
							},
						],
					};
				},
			});
			await tool.execute(
				"tool-call",
				{
					action: "verify",
					repository,
					priorRunId: "run-1",
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				undefined,
				(update: { content: Array<{ type: string; text: string }> }) => {
					updates.push(update.content[0]?.text ?? "");
				},
				{},
			);
			expect(updates[0]).toContain("fix-verification: terra");
			expect(updates[0]).toMatch(/verify started · /);
			expect(
				updates.some(
					(line) =>
						line.includes("fix-verification: terra") &&
						line.includes("terra/fix-verification"),
				),
			).toBe(true);
		});
	});
});

function writeReviewRecord(
	repository: string,
	runId: string,
	input: {
		findings: Array<{
			id: string;
			severity: "high" | "medium" | "low";
			title: string;
		}>;
		lost?: Array<{ rosterId: string; lens: string }>;
		extras?: string[];
	},
): void {
	const recordPath = path.join(repository, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	const seats = [
		{
			rosterId: "terra",
			lens: "holistic",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		},
		...(input.extras ?? []).map((lens) => ({
			rosterId: "terra",
			lens,
			provider: "openai-codex",
			model: "gpt-5.6-terra",
		})),
	];
	writeFileSync(
		path.join(recordPath, "panel.json"),
		`${JSON.stringify({ runId, baseRef: "origin/main", seats }, null, 2)}\n`,
	);
	writeFileSync(
		path.join(recordPath, "meta.json"),
		`${JSON.stringify(
			{
				runId,
				baseRef: "origin/main",
				baseOid: "a1b2c3dffffffffeeeeeeeeeeeeeeeeeeeeeee",
				headOid: "e4f5a6bffffffffeeeeeeeeeeeeeeeeeeeeeee",
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		`${JSON.stringify(
			input.findings.map((row) => ({
				id: row.id,
				seat: {
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					lens: "holistic",
				},
				finding: {
					file: "src/a.ts",
					line: 1,
					severity: row.severity,
					title: row.title,
					evidence: "evidence",
				},
			})),
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		path.join(recordPath, "execution.json"),
		`${JSON.stringify(
			{
				cancelled: false,
				lostCoverage: [],
				outcomes: (input.lost ?? []).map((seat) => ({
					seat: {
						...seat,
						provider: "openai-codex",
						model: "gpt-5.6-terra",
						lensPrompt: "review",
					},
					outcome: { kind: "failed", class: "no-submit", reason: "silent" },
				})),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

function writeVerifyRecord(
	repository: string,
	runId: string,
	resolvedIds: string[],
): void {
	const recordPath = path.join(repository, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "verification.json"),
		`${JSON.stringify(
			{
				priorRunId: "review-1",
				keptFindingIds: resolvedIds,
				outcomes: [
					{
						seat: {
							rosterId: "terra",
							lens: "fix-verification",
							provider: "openai-codex",
							model: "gpt-5.6-terra",
						},
						outcome: {
							kind: "voted",
							result: {
								items: resolvedIds.map((id) => ({
									id,
									disposition: "resolved",
									evidence: { file: "src/a.ts", explanation: "fixed" },
								})),
								regressions: [],
							},
						},
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

describe("review_panel comment", () => {
	it("turns an empty probe into usage that names comment", async () => {
		const tool = toolWith();
		await expect(
			tool.execute("tool-call", {}, undefined, undefined, {}),
		).rejects.toThrow(/"action": "comment"/);
	});

	it("refuses comment until the owner approved posting", async () => {
		await withRepository(async (repository) => {
			writeReviewRecord(repository, "review-1", { findings: [] });
			const tool = toolWith({
				postComment: () => {
					throw new Error("postComment must not run");
				},
			});
			await expect(
				tool.execute(
					"tool-call",
					{
						action: "comment",
						repository,
						priorRunId: "review-1",
					},
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/ownerApproved/);
		});
	});

	it("posts a nothing-kept card after owner approval", async () => {
		await withRepository(async (repository) => {
			writeReviewRecord(repository, "review-1", {
				findings: [
					{ id: "F-1", severity: "high", title: "auth bypass" },
					{ id: "F-2", severity: "low", title: "rename helper" },
				],
				extras: ["security"],
				lost: [{ rosterId: "deepseek", lens: "holistic" }],
			});
			let posted: { body: string; pr?: number | string } | undefined;
			const tool = toolWith({
				postComment: (input) => {
					posted = { body: input.body, pr: input.pr };
					return {
						action: "created",
						commentId: 42,
						pr: 29,
						url: "https://github.com/smarzban/demo/pull/29#issuecomment-42",
					};
				},
			});
			const response = await tool.execute(
				"tool-call",
				{
					action: "comment",
					repository,
					priorRunId: "review-1",
					ownerApproved: true,
					pr: 29,
					dismissed: [{ id: "F-1", reason: "checked, not real" }],
					lowAdvisory: ["F-2"],
				},
				undefined,
				undefined,
				{},
			);
			expect(posted?.pr).toBe(29);
			expect(posted?.body).toContain("## Review panel");
			expect(posted?.body).toContain(
				"2 findings submitted · 0 fixed · 1 dismissed · 1 left as low/advisory",
			);
			expect(posted?.body).toContain("Lost: deepseek/holistic");
			expect(posted?.body).toContain("extras: security");
			expect(posted?.body).toContain("- F-1 auth bypass — checked, not real");
			expect(posted?.body).not.toContain("### Fixed");
			expect(posted?.body).not.toMatch(/ready to merge/i);
			expect(response.content[0]?.text).toContain("Posted comment on PR #29");
			expect(response.content[0]?.text).toContain("created");
			expect(response.content[0]?.text).toContain("## Review panel");
			expect(response.content[0]?.text).not.toMatch(/\bverdict\b/i);
		});
	});

	it("refuses remaining high findings without a verify run", async () => {
		await withRepository(async (repository) => {
			writeReviewRecord(repository, "review-1", {
				findings: [{ id: "F-1", severity: "high", title: "auth bypass" }],
			});
			let posted = 0;
			const tool = toolWith({
				postComment: () => {
					posted += 1;
					throw new Error("postComment must not run");
				},
			});
			await expect(
				tool.execute(
					"tool-call",
					{
						action: "comment",
						repository,
						priorRunId: "review-1",
						ownerApproved: true,
						pr: 29,
					},
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/verifyRunId/);
			expect(posted).toBe(0);
		});
	});

	it("counts verified remaining findings as fixed", async () => {
		await withRepository(async (repository) => {
			writeReviewRecord(repository, "review-1", {
				findings: [
					{ id: "F-1", severity: "high", title: "auth bypass" },
					{ id: "F-2", severity: "low", title: "nit" },
				],
			});
			writeVerifyRecord(repository, "verify-1", ["F-1"]);
			let body = "";
			const tool = toolWith({
				postComment: (input) => {
					body = input.body;
					return {
						action: "updated",
						commentId: 9,
						pr: 10,
						url: "https://example.test/9",
					};
				},
			});
			const response = await tool.execute(
				"tool-call",
				{
					action: "comment",
					repository,
					priorRunId: "review-1",
					verifyRunId: "verify-1",
					ownerApproved: true,
					pr: 10,
					lowAdvisory: ["F-2"],
				},
				undefined,
				undefined,
				{},
			);
			expect(body).toContain(
				"2 findings submitted · 1 fixed · 0 dismissed · 1 left as low/advisory",
			);
			expect(body).not.toContain("### Dismissed");
			expect(body).toContain("- F-2 nit");
			expect(body).not.toContain("F-1");
			expect(response.content[0]?.text).toContain("updated");
		});
	});
});
