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
	commentAction,
	reviewAction,
	verifyAction,
} from "../src/actions/actions.js";
import { loadRoleTable } from "../src/config/roles.js";
import type { Config } from "../src/config/schema.js";
import type { RunVerifyInput } from "../src/run/run-verify.js";
import type { RunConfig } from "../src/run/types.js";
import type { PostCloseoutInput } from "../src/tool/closeout-post.js";
import { signGroups, TEST_RECORD_KEY } from "./fixtures/record-key.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function withRepository(test: (repo: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "grouping-actions-"));
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

const CONFIG: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
	],
	defaults: { seats: ["terra"], consolidator: "claude" },
};

/** A gh that finds no open PR, so nothing is posted. */
function noOpenPr(args: readonly string[]): string {
	if (args[0] === "api" && args[1] === "user") {
		return "saeed";
	}
	if (args[0] === "repo") {
		return "smarzban/demo";
	}
	return "[]";
}

function deps(overrides: ActionDependencies = {}): ActionDependencies {
	return {
		env: {},
		home: "/tmp/grouping-actions-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => CONFIG,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh: noOpenPr,
		...overrides,
	};
}

function textOf(result: ActionResult): string {
	return result.content[0]?.text ?? "";
}

const SEVERITIES = {
	"F-1": "high",
	"F-2": "low",
	"F-3": "medium",
	"F-4": "medium",
} as const;

/**
 * A complete review record with four findings and, unless `groups` is
 * null, a groups.json: G-1 = F-1 + F-3, G-2 = F-4, G-3 = F-2.
 */
function writeReviewRecord(
	repo: string,
	runId: string,
	options: { sign?: boolean; groups?: unknown } = {},
): string {
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
			Object.entries(SEVERITIES).map(([id, severity]) => ({
				id,
				seat: { provider: seat.provider, model: seat.model, lens: seat.lens },
				finding: {
					file: "src/a.ts",
					line: 1,
					severity,
					title: `${id} title`,
					evidence: "evidence",
				},
			})),
		),
	);
	writeFileSync(
		path.join(recordPath, "execution.json"),
		JSON.stringify({ cancelled: false, lostCoverage: [], outcomes: [] }),
	);
	if (options.groups !== null) {
		writeFileSync(
			path.join(recordPath, "groups.json"),
			`${JSON.stringify(
				{
					version: 1,
					runId,
					consolidator: {
						rosterId: "claude",
						provider: "anthropic",
						model: "claude-opus-5",
					},
					groups: options.groups ?? [
						{ id: "G-1", findingIds: ["F-1", "F-3"] },
						{ id: "G-2", findingIds: ["F-4"] },
						{ id: "G-3", findingIds: ["F-2"] },
					],
				},
				null,
				2,
			)}\n`,
		);
		if (options.sign !== false) {
			signGroups(recordPath);
		}
	}
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	return recordPath;
}

function verifyCapture(repo: string) {
	const seen: RunVerifyInput[] = [];
	return {
		seen,
		runVerify: async (input: RunVerifyInput) => {
			seen.push(input);
			return {
				recordPath: path.join(repo, ".review-panel", "runs", "v-1"),
				priorRunId: input.priorRunId,
				priorHeadOid: "b".repeat(40),
				headOid: "c".repeat(40),
				kept: [],
				outcomes: [],
			};
		},
	};
}

describe("review passes the owner's grouping seat to the run", () => {
	it("plans defaults.consolidator as the grouping seat, and none without it (T495)", async () => {
		await withRepository(async (repo) => {
			const seen: RunConfig[] = [];
			// A record with four findings, as the run leaves it.
			const recordPath = writeReviewRecord(repo, "r", { groups: null });
			const runReview = async (input: RunConfig) => {
				seen.push(input);
				return {
					recordPath,
					outcomes: [],
					...(input.consolidator === undefined
						? {}
						: {
								grouping: {
									seat: input.consolidator,
									lifecycle: {
										startedAtMs: 0,
										settledAtMs: 1,
										durationMs: 1,
										attempts: 1 as const,
										aborted: false,
										tokens: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											total: 0,
										},
										cost: 0,
									},
									outcome: {
										kind: "grouped" as const,
										groups: [
											{ id: "G-1", findingIds: ["F-1", "F-3"] },
											{ id: "G-2", findingIds: ["F-4"] },
											{ id: "G-3", findingIds: ["F-2"] },
										],
									},
								},
							}),
				};
			};
			const replies: string[] = [];
			for (const loadConfig of [
				() => CONFIG,
				() => ({ ...CONFIG, defaults: { seats: ["terra"] } }),
			]) {
				replies.push(
					textOf(
						await reviewAction(
							{ repoDir: repo, base: "HEAD~1", head: "HEAD" },
							{
								deps: deps({ loadConfig, runReview, suggestLenses: () => [] }),
							},
						),
					),
				);
			}
			expect(replies[0]).toContain("4 findings in 3 groups");
			expect(replies[0]).toContain("grouping (claude)");
			expect(replies[0]).toContain("- G-1 [high, stated by a seat] F-1 title");
			expect(replies[1]).not.toContain("G-1");
			expect(seen[0]?.consolidator).toEqual({
				rosterId: "claude",
				provider: "anthropic",
				model: "claude-opus-5",
				lens: "grouping",
				lensPrompt: loadRoleTable().get("grouping")?.prompt,
			});
			expect(seen[1]).not.toHaveProperty("consolidator");
		});
	});
});

describe("verify takes G-ids as well as F-ids", () => {
	it("expands each G-id to its member F-ids before any seat runs (T495)", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const capture = verifyCapture(repo);
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: "review-1",
					head: "HEAD",
					keptFindingIds: ["G-1"],
					dismissed: [{ id: "G-2", reason: "by design" }],
					lowAdvisory: ["G-3"],
				},
				{ deps: deps({ runVerify: capture.runVerify }) },
			);
			expect(capture.seen).toHaveLength(1);
			expect(capture.seen[0]?.keptFindingIds).toEqual(["F-1", "F-3"]);
		});
	});

	it("takes F-ids and G-ids together, and F-ids alone without reading the key", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const capture = verifyCapture(repo);
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: "review-1",
					head: "HEAD",
					keptFindingIds: ["G-1", "F-4"],
				},
				{ deps: deps({ runVerify: capture.runVerify }) },
			);
			await verifyAction(
				{
					repoDir: repo,
					priorRunId: "review-1",
					head: "HEAD",
					keptFindingIds: ["F-1"],
				},
				{
					deps: deps({
						runVerify: capture.runVerify,
						recordKey: () => {
							throw new Error("the key is not needed for F-ids");
						},
					}),
				},
			);
			expect(capture.seen.map((input) => input.keptFindingIds)).toEqual([
				["F-1", "F-3", "F-4"],
				["F-1"],
			]);
		});
	});

	it("refuses an id that names no group before any seat runs", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const capture = verifyCapture(repo);
			for (const args of [
				{ keptFindingIds: ["G-9"] },
				{ keptFindingIds: ["F-1"], lowAdvisory: ["G-7"] },
				{ keptFindingIds: [], dismissed: [{ id: "G-8", reason: "x" }] },
			]) {
				await expect(
					verifyAction(
						{ repoDir: repo, priorRunId: "review-1", head: "HEAD", ...args },
						{ deps: deps({ runVerify: capture.runVerify }) },
					),
				).rejects.toThrow(/Verify refused: G-[789] is not a group/);
			}
			expect(capture.seen).toHaveLength(0);
		});
	});

	it("refuses G-ids when the grouping record is unsigned, forged or missing, and asks for F-ids", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "unsigned", { sign: false });
			const forged = writeReviewRecord(repo, "forged");
			// Rewritten after signing: G-1 now claims a different set.
			writeFileSync(
				path.join(forged, "groups.json"),
				JSON.stringify({
					version: 1,
					runId: "forged",
					groups: [{ id: "G-1", findingIds: ["F-1", "F-2", "F-3", "F-4"] }],
				}),
			);
			writeReviewRecord(repo, "ungrouped", { groups: null });
			const capture = verifyCapture(repo);
			for (const priorRunId of ["unsigned", "forged", "ungrouped"]) {
				await expect(
					verifyAction(
						{
							repoDir: repo,
							priorRunId,
							head: "HEAD",
							keptFindingIds: ["G-1"],
						},
						{ deps: deps({ runVerify: capture.runVerify }) },
					),
				).rejects.toThrow(/Verify refused: .*signed grouping.*pass F-ids/);
			}
			expect(capture.seen).toHaveLength(0);
		});
	});

	it("asks for F-ids when the record key cannot be read, for verify and comment", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const capture = verifyCapture(repo);
			const noKey = () => {
				throw new Error("there is no record key at /k");
			};
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: "review-1",
						head: "HEAD",
						keptFindingIds: ["G-1"],
					},
					{ deps: deps({ runVerify: capture.runVerify, recordKey: noKey }) },
				),
			).rejects.toThrow(
				/Verify refused: G-ids need .*record key cannot be read: there is no record key at \/k.*pass F-ids instead/,
			);
			await expect(
				commentAction(
					{
						repoDir: repo,
						ownerApproved: true,
						priorRunId: "review-1",
						dismissed: [{ id: "G-1", reason: "x" }],
						lowAdvisory: [],
					},
					{ deps: deps({ recordKey: noKey }) },
				),
			).rejects.toThrow(/comment refused: G-ids need .*pass F-ids instead/);
			expect(capture.seen).toHaveLength(0);
		});
	});

	it("refuses signed groups that do not place every F-id exactly once", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "partial", {
				groups: [{ id: "G-1", findingIds: ["F-1", "F-3"] }],
			});
			const capture = verifyCapture(repo);
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: "partial",
						head: "HEAD",
						keptFindingIds: ["G-1"],
					},
					{ deps: deps({ runVerify: capture.runVerify }) },
				),
			).rejects.toThrow(/pass F-ids/);
			expect(capture.seen).toHaveLength(0);
		});
	});

	it("still refuses a high member listed as low/advisory through its group", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const capture = verifyCapture(repo);
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: "review-1",
						head: "HEAD",
						keptFindingIds: ["G-2"],
						lowAdvisory: ["G-1", "G-3"],
					},
					{ deps: deps({ runVerify: capture.runVerify }) },
				),
			).rejects.toThrow(/F-1 is high/);
			expect(capture.seen).toHaveLength(0);
		});
	});
});

describe("comment takes G-ids as well as F-ids", () => {
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

	it("expands G-ids in dismissed and lowAdvisory to their members (T495)", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			const { bodies, postComment } = poster();
			await commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: "review-1",
					dismissed: [
						{ id: "G-1", reason: "out of scope" },
						{ id: "F-4", reason: "by design" },
					],
					lowAdvisory: ["G-3"],
					pr: 7,
				},
				{ deps: deps({ postComment }) },
			);
			expect(bodies).toHaveLength(1);
			const body = bodies[0] ?? "";
			for (const id of ["F-1", "F-2", "F-3", "F-4"]) {
				expect(body).toContain(id);
			}
			expect(body).not.toContain("G-1");
		});
	});

	it("refuses an unknown G-id and an unsigned grouping before posting", async () => {
		await withRepository(async (repo) => {
			writeReviewRecord(repo, "review-1");
			writeReviewRecord(repo, "unsigned", { sign: false });
			const { bodies, postComment } = poster();
			await expect(
				commentAction(
					{
						repoDir: repo,
						ownerApproved: true,
						priorRunId: "review-1",
						dismissed: [{ id: "G-4", reason: "x" }],
						lowAdvisory: [],
					},
					{ deps: deps({ postComment }) },
				),
			).rejects.toThrow(/comment refused: G-4 is not a group/);
			await expect(
				commentAction(
					{
						repoDir: repo,
						ownerApproved: true,
						priorRunId: "unsigned",
						dismissed: [{ id: "G-1", reason: "x" }],
						lowAdvisory: [],
					},
					{ deps: deps({ postComment }) },
				),
			).rejects.toThrow(/comment refused: .*pass F-ids/);
			expect(bodies).toHaveLength(0);
		});
	});
});
