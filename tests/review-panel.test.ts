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
	const root = mkdtempSync(path.join(tmpdir(), "empanel-review-tool-"));
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
		home: "/tmp/empanel-review-home",
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
