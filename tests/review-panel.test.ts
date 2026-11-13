import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import { loadRecordKey } from "../src/run/record-key.js";
import { resumeRun } from "../src/run/resume.js";
import { runAudit } from "../src/run/run-audit.js";
import { type RunReviewResult, runReview } from "../src/run/run-review.js";
import type { PlannedSeat, RunConfig } from "../src/run/types.js";
import reviewPanelExtension, {
	canonicalizeRepository,
	createReviewPanelTool,
	prepareReviewArguments,
	REPOSITORY_EXAMPLE,
	rejectFilesystemRoot,
} from "../src/tool/review-panel.js";
import { signPlan, signSeat, TEST_RECORD_KEY } from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

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
		recordKey: () => TEST_RECORD_KEY,
		...overrides,
	});
}

describe("review_panel public tool adapter", () => {
	it("prepares stringified arrays before host schema validation", () => {
		const tool = toolWith();
		const jsonEncoded = prepareReviewArguments({
			action: "review",
			repository: "/tmp/repo",
			base: "main",
			head: "HEAD",
			lenses: '["subtle-correctness"]\n',
		});
		expect(jsonEncoded).toEqual({
			action: "review",
			repository: "/tmp/repo",
			base: "main",
			head: "HEAD",
			lenses: ["subtle-correctness"],
		});
		expect(Value.Check(tool.parameters, jsonEncoded)).toBe(true);

		const scalar = prepareReviewArguments({
			action: "review",
			repository: "/tmp/repo",
			base: "main",
			head: "HEAD",
			lenses: "security",
		});
		expect(scalar).toMatchObject({ lenses: ["security"] });
		expect(Value.Check(tool.parameters, scalar)).toBe(true);
	});

	it("accepts every documented object argument shape without schema branches", () => {
		const tool = toolWith();
		const args = {
			action: "comment",
			repository: "/tmp/repo",
			priorRunId: "review-run",
			ownerApproved: true,
			pr: 42,
			dismissed: [
				{ id: "F-1", reason: "not reproducible", title: "finding title" },
			],
			lowAdvisory: [],
			verifyRunId: "verify-run",
			head: "HEAD",
		};

		expect(Value.Check(tool.parameters, tool.prepareArguments(args))).toBe(
			true,
		);
		const schema = JSON.stringify(tool.parameters);
		expect(schema).not.toContain('"anyOf"');
		expect(schema).not.toContain('"oneOf"');
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
		const usage = await tool
			.execute("tool-call", {}, undefined, undefined, {})
			.then(
				() => {
					throw new Error("empty probe must throw");
				},
				(error: unknown) =>
					error instanceof Error ? error.message : String(error),
			);
		expect(usage).toMatch(/already in the repo/i);
		expect(usage).not.toContain("/absolute/path");
		expect(usage).not.toContain(REPOSITORY_EXAMPLE);
	});

	it("uses cwd when repository is omitted or a placeholder", async () => {
		await withRepository(async (repository) => {
			let seen: string | undefined;
			const tool = toolWith({
				diagnose: async ({ repoDir }) => {
					seen = repoDir;
					return { ready: true, rows: [] };
				},
			});
			const expected = realpathSync(repository);
			for (const repositoryArg of ["/", REPOSITORY_EXAMPLE, undefined]) {
				seen = undefined;
				const args =
					repositoryArg === undefined
						? { action: "diagnose" }
						: { action: "diagnose", repository: repositoryArg };
				await tool.execute("tool-call", args, undefined, undefined, {
					cwd: repository,
				});
				expect(seen).toBe(expected);
			}
		});
	});

	it("prefers an explicit repository over cwd", async () => {
		await withRepository(async (repository) => {
			const otherRoot = mkdtempSync(path.join(tmpdir(), "review-panel-other-"));
			try {
				const other = makeRepository(otherRoot);
				let seen: string | undefined;
				const tool = toolWith({
					diagnose: async ({ repoDir }) => {
						seen = repoDir;
						return { ready: true, rows: [] };
					},
				});
				await tool.execute(
					"tool-call",
					{ action: "diagnose", repository },
					undefined,
					undefined,
					{ cwd: other },
				);
				expect(seen).toBe(realpathSync(repository));
				expect(seen).not.toBe(realpathSync(other));
			} finally {
				rmSync(otherRoot, { recursive: true, force: true });
			}
		});
	});

	it("refuses a placeholder when cwd is not a Git repository", async () => {
		const loose = mkdtempSync(path.join(tmpdir(), "review-panel-loose-"));
		try {
			const tool = toolWith();
			await expect(
				tool.execute(
					"tool-call",
					{ action: "diagnose", repository: "/" },
					undefined,
					undefined,
					{ cwd: loose },
				),
			).rejects.toThrow(/not a Git repository/i);
			expect(() => canonicalizeRepository("/")).toThrow(REPOSITORY_EXAMPLE);
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
	});

	it("refuses a Git top-level that is the filesystem root", () => {
		expect(() => rejectFilesystemRoot("/", "/workspace")).toThrow(
			/real repo directory/,
		);
		expect(() => rejectFilesystemRoot("/", "/workspace")).toThrow(
			REPOSITORY_EXAMPLE,
		);
		expect(
			rejectFilesystemRoot("/Users/you/the-repo", "/Users/you/the-repo"),
		).toBe("/Users/you/the-repo");
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

	it("drops a suggestion for a lens the panel already ran", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith({
				suggestLenses: () => [
					{
						lens: "tests",
						reason: "code changed",
						evidence: [{ file: "src/a.ts" }],
					},
					{
						lens: "security",
						reason: "added subprocess line",
						evidence: [{ file: "src/a.ts", line: 1 }],
					},
				],
				runReview: async (config: RunConfig) =>
					({
						recordPath: path.join(repository, ".review-panel", "runs", "run-5"),
						outcomes: config.seats.map((seat) => ({
							seat,
							outcome: { kind: "voted" as const, findings: [] },
						})),
					}) as unknown as RunReviewResult,
			});
			const response = await tool.execute(
				"tool-call",
				{
					action: "review",
					repository,
					base: "HEAD~1",
					head: "HEAD",
					lenses: ["tests"],
				},
				undefined,
				undefined,
				{},
			);
			const text = response.content[0]?.text ?? "";
			expect(text).toContain("Suggest: security");
			expect(text).not.toContain("Suggest: tests");
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
	priorRunId = "review-1",
): void {
	const recordPath = path.join(repository, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "verification.json"),
		`${JSON.stringify(
			{
				priorRunId,
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

	it("refuses a verify run that belongs to a different review", async () => {
		await withRepository(async (repository) => {
			writeReviewRecord(repository, "review-1", {
				findings: [{ id: "F-1", severity: "high", title: "auth bypass" }],
			});
			writeVerifyRecord(repository, "verify-other", ["F-1"], "review-other");
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
						verifyRunId: "verify-other",
						ownerApproved: true,
						pr: 29,
					},
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/priorRunId/);
			expect(posted).toBe(0);
		});
	});
});

describe("review_panel resume action", () => {
	function threeSeats(): PlannedSeat[] {
		return ["correctness", "security", "tests"].map((lens, index) => ({
			rosterId: `seat-${index}`,
			provider: "openai-codex",
			model: `gpt-5.6-${index}`,
			lens,
			lensPrompt: `Review through ${lens}.`,
		}));
	}

	/** A real review record interrupted after its first seat settled. */
	async function interruptedRecord(repository: string): Promise<string> {
		const controller = new AbortController();
		const fake = createSdkSeatFake([
			{ kind: "default" },
			{ kind: "pending" },
			{ kind: "pending" },
		]);
		await expect(
			runReview(
				{ repoDir: repository, baseRef: "HEAD~1", seats: threeSeats() },
				{
					abortSignal: controller.signal,
					recordKey: TEST_RECORD_KEY,
					sessionFactory: fake.factory,
					onProgress: (event) => {
						if (event.kind === "seat-finished") {
							controller.abort();
						}
					},
				},
			),
		).rejects.toThrow(/cancel/i);
		const runsDir = path.join(repository, ".review-panel", "runs");
		return readdirSync(runsDir)[0] as string;
	}

	it("lists resume in the tool description, the action argument and the usage", async () => {
		const tool = toolWith();
		expect(tool.description).toMatch(/resume/i);
		expect(JSON.stringify(tool.parameters)).toContain('\\"resume\\"');
		await expect(
			tool.execute("tool-call", {}, undefined, undefined, {}),
		).rejects.toThrow(/"action": "resume", "priorRunId"/);
	});

	it("rejects arguments resume does not take, so seats never come from the caller", async () => {
		await withRepository(async (repository) => {
			const tool = toolWith();
			await expect(
				tool.execute(
					"tool-call",
					{ action: "resume", repository, priorRunId: "x", seats: ["terra"] },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/resume does not accept argument "seats"/);
			await expect(
				tool.execute(
					"tool-call",
					{ action: "resume", repository },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/priorRunId must be a non-empty string/);
		});
	});

	it("refuses an unknown run before anything runs", async () => {
		await withRepository(async (repository) => {
			let ran = false;
			const tool = toolWith({
				resumeRun: async () => {
					ran = true;
					throw new Error("must not run");
				},
			});
			await expect(
				tool.execute(
					"tool-call",
					{ action: "resume", repository, priorRunId: "no-such-run" },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/Resume refused: run "no-such-run" was not found/);
			expect(ran).toBe(false);
		});
	});

	it("finishes an interrupted review and says which seats ran again", async () => {
		await withRepository(async (repository) => {
			const runId = await interruptedRecord(repository);
			const sessions: string[] = [];
			const fake = createSdkSeatFake();
			const updates: string[] = [];
			const tool = toolWith({
				loadConfig: () => ({
					roster: threeSeats().map((seat) => ({
						id: seat.rosterId,
						provider: seat.provider,
						model: seat.model,
					})),
					defaults: { seats: ["seat-0"] },
				}),
				resumeRun: (run, options) =>
					resumeRun(run, {
						...(options as NonNullable<typeof options>),
						sessionFactory: async (input) => {
							sessions.push(input.spec.lens);
							return fake.factory(input);
						},
					}),
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "resume", repository, priorRunId: runId },
				undefined,
				(update: { content: Array<{ text: string }> }) =>
					updates.push(update.content[0]?.text ?? ""),
				{},
			);
			const text = response.content[0]?.text ?? "";
			expect(sessions.sort()).toEqual(["security", "tests"]);
			expect(text).toContain(
				`Resumed ${runId}: ran 2 of 3 planned seats again (seat-1/security, seat-2/tests); kept 1 as recorded.`,
			);
			expect(text).toContain("# Review panel");
			expect(text).toContain("3/3 voted");
			expect(text).toContain("Not a merge decision.");
			expect(updates[0]).toMatch(/review started/);
		});
	});

	function rosterOf(seats: PlannedSeat[]): Config {
		return {
			roster: seats.map((seat) => ({
				id: seat.rosterId,
				provider: seat.provider,
				model: seat.model,
			})),
			defaults: { seats: [seats[0]?.rosterId ?? "seat-0"] },
		};
	}

	function countingResume(sessions: string[]) {
		const fake = createSdkSeatFake();
		return (
			run: Parameters<typeof resumeRun>[0],
			options: Parameters<typeof resumeRun>[1] | undefined,
		) =>
			resumeRun(run, {
				...(options as NonNullable<typeof options>),
				sessionFactory: async (input) => {
					sessions.push(input.spec.lens);
					return fake.factory(input);
				},
			});
	}

	it("finishes an interrupted audit with the audit rendering", async () => {
		await withRepository(async (repository) => {
			const seats = threeSeats()
				.slice(0, 2)
				.map((seat, index) => ({
					...seat,
					lens: index === 0 ? "code-health" : "security",
				}));
			const controller = new AbortController();
			const interrupted = createSdkSeatFake([
				{ kind: "default" },
				{ kind: "pending" },
			]);
			await expect(
				runAudit(
					{ repoDir: repository, seats },
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
				path.join(repository, ".review-panel", "runs"),
			)[0] as string;
			const sessions: string[] = [];
			const updates: string[] = [];
			const tool = toolWith({
				loadConfig: () => rosterOf(seats),
				resumeRun: countingResume(sessions),
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "resume", repository, priorRunId: runId },
				undefined,
				(update: { content: Array<{ text: string }> }) =>
					updates.push(update.content[0]?.text ?? ""),
				{},
			);
			const text = response.content[0]?.text ?? "";
			expect(sessions).toEqual(["security"]);
			expect(text).toContain(
				`Resumed ${runId}: ran 1 of 2 planned seats again (seat-1/security); kept 1 as recorded.`,
			);
			expect(text).toContain("# Repository audit");
			expect(text).toContain("2/2 voted");
			expect(text).not.toContain("# Review panel");
			expect(updates[0]).toMatch(/audit started/);
		});
	});

	it("counts a seat it could not rebuild as lost coverage, not as kept", async () => {
		await withRepository(async (repository) => {
			const runId = await interruptedRecord(repository);
			const sessions: string[] = [];
			const config = rosterOf(threeSeats());
			// The owner removed the row of seat 2 since the run started.
			config.roster = config.roster.slice(0, 2);
			const tool = toolWith({
				loadConfig: () => config,
				resumeRun: countingResume(sessions),
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "resume", repository, priorRunId: runId },
				undefined,
				undefined,
				{},
			);
			const text = response.content[0]?.text ?? "";
			expect(sessions).toEqual(["security"]);
			expect(text).toContain(
				`Resumed ${runId}: ran 1 of 3 planned seats again (seat-1/security); kept 1 as recorded; lost 1 that could not be rebuilt from the owner config (seat-2/tests).`,
			);
		});
	});

	it("says when the record's scoping note was not passed to the re-run seats", async () => {
		await withRepository(async (repository) => {
			const runId = await interruptedRecord(repository);
			const planPath = path.join(
				repository,
				".review-panel",
				"runs",
				runId,
				"plan.json",
			);
			const plan = JSON.parse(readFileSync(planPath, "utf8"));
			plan.scopingNote = "Only README.md is in scope.";
			writeFileSync(planPath, JSON.stringify(plan));
			// Signed as the owner's own record, so the test reaches the note.
			const recordPath = path.dirname(planPath);
			signPlan(recordPath);
			signSeat(recordPath, 0);
			const tool = toolWith({
				loadConfig: () => rosterOf(threeSeats()),
				resumeRun: countingResume([]),
			});
			const response = await tool.execute(
				"tool-call",
				{ action: "resume", repository, priorRunId: runId },
				undefined,
				undefined,
				{},
			);
			const text = response.content[0]?.text ?? "";
			expect(text).toContain(
				"The interrupted run had a scoping note. It is stored in the record, so the re-run seats did not get it.",
			);
			expect(text).not.toContain("Only README.md is in scope.");
		});
	});

	it("runs the readiness check before resuming", async () => {
		await withRepository(async (repository) => {
			const runId = await interruptedRecord(repository);
			let resumed = 0;
			const tool = toolWith({
				loadConfig: () => rosterOf(threeSeats()),
				diagnose: async () => ({
					ready: false,
					rows: [
						{
							prerequisite: "configuration",
							remediation: "Create the outside-repository config.",
						},
					],
				}),
				resumeRun: async () => {
					resumed += 1;
					throw new Error("resumeRun must not be called");
				},
			});
			await expect(
				tool.execute(
					"tool-call",
					{ action: "resume", repository, priorRunId: runId },
					undefined,
					undefined,
					{},
				),
			).rejects.toThrow(/needs setup/);
			expect(resumed).toBe(0);
		});
	});
});

describe("review_panel record key", () => {
	const seats: PlannedSeat[] = ["correctness", "security"].map(
		(lens, index) => ({
			rosterId: `seat-${index}`,
			provider: "openai-codex",
			model: `gpt-5.6-${index}`,
			lens,
			lensPrompt: `Review through ${lens}.`,
		}),
	);
	const roster: Config = {
		roster: seats.map((seat) => ({
			id: seat.rosterId,
			provider: seat.provider,
			model: seat.model,
		})),
		defaults: { seats: ["seat-0"] },
	};

	/**
	 * A tool that resolves the record key the way production does, from the
	 * folder of `$PI_REVIEW_PANEL_CONFIG`: a temporary folder, never the
	 * owner's real one.
	 */
	function ownerTool(
		configDir: string,
		overrides: Parameters<typeof createReviewPanelTool>[0] = {},
	): ReviewTool {
		return createReviewPanelTool({
			env: { PI_REVIEW_PANEL_CONFIG: path.join(configDir, "config.json") },
			home: "/nonexistent-home",
			diagnose: async () => ({ ready: true, rows: [] }),
			loadConfig: () => roster,
			...overrides,
		});
	}

	function withConfigDir(test: (configDir: string) => Promise<void>) {
		const configDir = mkdtempSync(path.join(tmpdir(), "review-panel-owner-"));
		return test(configDir).finally(() =>
			rmSync(configDir, { recursive: true, force: true }),
		);
	}

	it("review creates the key beside the owner config and signs the run with it", async () => {
		await withRepository((repository) =>
			withConfigDir(async (configDir) => {
				let given: Buffer | undefined;
				const tool = ownerTool(configDir, {
					runReview: async (config: RunConfig, options) => {
						given = options?.recordKey;
						return {
							recordPath: path.join(repository, ".review-panel", "runs", "r"),
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
					undefined,
					{},
				);
				const keyPath = path.join(configDir, "record-key");
				const onDisk = readFileSync(keyPath);
				expect(onDisk).toHaveLength(32);
				expect(given?.equals(onDisk)).toBe(true);
				if (process.platform !== "win32") {
					expect(statSync(keyPath).mode & 0o777).toBe(0o600);
				}
			}),
		);
	});

	/** A key another process could read: the run that needs it must refuse. */
	function plantOpenKey(configDir: string): void {
		const keyPath = path.join(configDir, "record-key");
		writeFileSync(keyPath, Buffer.alloc(32, 9));
		chmodSync(keyPath, 0o644);
	}

	it.skipIf(process.platform === "win32")(
		"review refuses, and runs no seat, when the record key is unusable",
		async () => {
			await withRepository((repository) =>
				withConfigDir(async (configDir) => {
					plantOpenKey(configDir);
					let reviewed = 0;
					const tool = ownerTool(configDir, {
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
					).rejects.toThrow(
						/Review refused: record key .*record-key is readable by group or other users and is refused/,
					);
					expect(reviewed).toBe(0);
				}),
			);
		},
	);

	it.skipIf(process.platform === "win32")(
		"audit refuses, and runs no seat, when the record key is unusable",
		async () => {
			await withRepository((repository) =>
				withConfigDir(async (configDir) => {
					symlinkSync(
						path.join(configDir, "elsewhere"),
						path.join(configDir, "record-key"),
					);
					let audited = 0;
					const tool = ownerTool(configDir, {
						loadConfig: () => ({
							...roster,
							defaults: { seats: ["seat-0", "seat-1"] },
						}),
						runAudit: async () => {
							audited += 1;
							throw new Error("runAudit must not be called");
						},
					});
					await expect(
						tool.execute(
							"tool-call",
							{ action: "audit", repository, passes: ["security"] },
							undefined,
							undefined,
							{},
						),
					).rejects.toThrow(
						/Audit refused: record key .*record-key is a symlink and is refused/,
					);
					expect(audited).toBe(0);
				}),
			);
		},
	);

	it("diagnose reports ready for a usable key folder with no key, and creates none", async () => {
		await withRepository((repository) =>
			withConfigDir(async (configDir) => {
				const tool = ownerTool(configDir);
				const response = await tool.execute(
					"tool-call",
					{ action: "diagnose", repository },
					undefined,
					undefined,
					{},
				);
				expect(response.content[0]?.text).toContain("- Status: ready");
				expect(readdirSync(configDir)).toEqual([]);
			}),
		);
	});

	it.skipIf(process.platform === "win32")(
		"diagnose reports an unusable record key as one row with its path, cause and fix",
		async () => {
			await withRepository((repository) =>
				withConfigDir(async (configDir) => {
					plantOpenKey(configDir);
					const keyPath = path.join(configDir, "record-key");
					const tool = ownerTool(configDir);
					const response = await tool.execute(
						"tool-call",
						{ action: "diagnose", repository },
						undefined,
						undefined,
						{},
					);
					const text = response.content[0]?.text ?? "";
					expect(text).toContain("- Status: needs setup");
					expect(text).toContain(
						`- record key ${keyPath}: record key ${keyPath} is readable by group or other users and is refused.`,
					);
					expect(text).toContain(`chmod 600 ${keyPath}`);
					expect(statSync(keyPath).mode & 0o777).toBe(0o644);
				}),
			);
		},
	);

	it.skipIf(
		process.platform === "win32" ||
			(typeof process.getuid === "function" && process.getuid() === 0),
	)(
		"diagnose reports a read-only config folder, and writes nothing there",
		async () => {
			await withRepository((repository) =>
				withConfigDir(async (configDir) => {
					chmodSync(configDir, 0o555);
					try {
						const tool = ownerTool(configDir);
						const response = await tool.execute(
							"tool-call",
							{ action: "diagnose", repository },
							undefined,
							undefined,
							{},
						);
						const text = response.content[0]?.text ?? "";
						expect(text).toContain("- Status: needs setup");
						expect(text).toMatch(
							/- record key .*record-key: record key .*record-key cannot be created: its folder .* is not writable/,
						);
						expect(readdirSync(configDir)).toEqual([]);
					} finally {
						chmodSync(configDir, 0o700);
					}
				}),
			);
		},
	);

	it("resume never creates the key, and refuses without one", async () => {
		await withRepository((repository) =>
			withConfigDir(async (configDir) => {
				const tool = ownerTool(configDir);
				await expect(
					tool.execute(
						"tool-call",
						{ action: "resume", repository, priorRunId: "any-run" },
						undefined,
						undefined,
						{},
					),
				).rejects.toThrow(/Resume refused: there is no record key at /);
				expect(readdirSync(configDir)).toEqual([]);
			}),
		);
	});

	it("resumes a record signed with the owner's key, and keeps a forged finding out of the reply", async () => {
		await withRepository((repository) =>
			withConfigDir(async (configDir) => {
				const recordKey = loadRecordKey(path.join(configDir, "record-key"), {
					create: true,
					repoDir: repository,
				});
				const controller = new AbortController();
				const interrupted = createSdkSeatFake([
					{ kind: "default" },
					{ kind: "pending" },
				]);
				await expect(
					runReview(
						{ repoDir: repository, baseRef: "HEAD~1", seats },
						{
							abortSignal: controller.signal,
							recordKey,
							sessionFactory: interrupted.factory,
							onProgress: (event) => {
								if (event.kind === "seat-finished") {
									controller.abort();
								}
							},
						},
					),
				).rejects.toThrow(/cancel/i);
				const runsDir = path.join(repository, ".review-panel", "runs");
				const runId = readdirSync(runsDir)[0] as string;
				const seatsDir = path.join(runsDir, runId, "seats");
				// A forger copies seat 0's file and MAC to seat 1, with a finding.
				const forged = JSON.parse(
					readFileSync(path.join(seatsDir, "0.json"), "utf8"),
				);
				forged.index = 1;
				forged.facts.seat = { ...forged.facts.seat, ...seats[1] };
				forged.facts.outcome = {
					kind: "voted",
					findings: [
						{
							file: "head.txt",
							line: 1,
							severity: "high",
							title: "PLANTED-HIGH finding",
							evidence: "planted",
						},
					],
				};
				writeFileSync(path.join(seatsDir, "1.json"), JSON.stringify(forged));
				writeFileSync(
					path.join(seatsDir, "1.mac"),
					readFileSync(path.join(seatsDir, "0.mac")),
				);
				const sessions: string[] = [];
				const fake = createSdkSeatFake();
				const tool = ownerTool(configDir, {
					resumeRun: (run, options) =>
						resumeRun(run, {
							...(options as NonNullable<typeof options>),
							sessionFactory: async (input) => {
								sessions.push(input.spec.lens);
								return fake.factory(input);
							},
						}),
				});
				const response = await tool.execute(
					"tool-call",
					{ action: "resume", repository, priorRunId: runId },
					undefined,
					undefined,
					{},
				);
				const text = response.content[0]?.text ?? "";
				expect(sessions).toEqual(["security"]);
				expect(text).toContain(
					`Resumed ${runId}: ran 1 of 2 planned seats again (seat-1/security); kept 1 as recorded.`,
				);
				expect(text).not.toContain("PLANTED-HIGH");
			}),
		);
	});
});
