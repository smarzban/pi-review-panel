import { execFileSync } from "node:child_process";
import {
	cpSync,
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
	commentAction,
	ownerRecordKey,
	verifyAction,
} from "../src/actions/actions.js";
import type { Config } from "../src/config/schema.js";
import { loadPriorRun } from "../src/run/prior-run.js";
import { loadResumable, resumeRun } from "../src/run/resume.js";
import { runVerify } from "../src/run/run-verify.js";
import type { PostCloseoutInput } from "../src/tool/closeout-post.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import {
	signReviewRecord,
	signVerifyRecord,
	TEST_RECORD_KEY,
} from "./fixtures/record-key.js";
import {
	createAdvisorySeatRunner,
	createSdkReviewRunner,
	createSdkSeatFake,
	SDK_FINDING,
} from "./fixtures/sdk-seat-fake.js";

/**
 * Run records live in the reviewed repository, so anyone who can put files
 * there can plant one. Verify and comment take a record as the owner's own
 * only when its completion MAC (`record.mac`, from the owner's record key,
 * bound to the record's run id) covers the files they read; a review record's
 * `plan.json` must carry a valid `plan.mac` too. Anything else is refused,
 * with the fix, before any seat runs and before anything is posted.
 */

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(repo: string, file: string): void {
	writeFileSync(path.join(repo, file), `${file}\n`);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", file, "--quiet"]);
}

function withRepository(
	test: (repo: string, root: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "signed-records-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "signed@example.test"]);
	git(repo, ["config", "user.name", "Signed Test"]);
	commit(repo, "base.txt");
	commit(repo, "head.txt");
	return test(realpathSync(repo), root).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

const config: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

const OTHER_KEY = Buffer.alloc(32, 8);

/** A gh that finds no open PR, so verify posts nothing on its own. */
function noOpenPr(args: readonly string[]): string {
	if (args[0] === "api" && args[1] === "user") {
		return "owner";
	}
	if (args[0] === "repo") {
		return "owner/demo";
	}
	return "[]";
}

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
				url: "https://github.com/owner/demo/pull/7#issuecomment-1",
			};
		},
	};
}

function deps(overrides: ActionDependencies = {}): ActionDependencies {
	return {
		env: {},
		home: "/tmp/signed-records-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => config,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh: noOpenPr,
		runVerify: () => {
			throw new Error("no verify seat may run for a refused record");
		},
		...overrides,
	};
}

function recordOf(repo: string, runId: string): string {
	return path.join(repo, ".review-panel", "runs", runId);
}

/** A complete review record with one high finding, unsigned. */
function plantReview(repo: string, runId: string): string {
	const recordPath = recordOf(repo, runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId,
			baseRef: "main",
			baseOid: git(repo, ["rev-parse", "HEAD~1"]).trim(),
			headOid: git(repo, ["rev-parse", "HEAD~1"]).trim(),
		}),
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify([
			{
				id: "F-1",
				seat: { provider: "openai-codex", model: "gpt-5.6-terra", lens: "x" },
				finding: { ...SDK_FINDING, severity: "high" },
			},
		]),
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	return recordPath;
}

/** A complete verify record of `priorRunId` that marks F-1 resolved, unsigned. */
function plantVerify(repo: string, runId: string, priorRunId: string): string {
	const recordPath = recordOf(repo, runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "verification.json"),
		JSON.stringify({
			priorRunId,
			keptFindingIds: ["F-1"],
			outcomes: [
				{
					seat: { rosterId: "terra", lens: "fix-verification" },
					outcome: {
						kind: "voted",
						result: {
							items: [{ id: "F-1", disposition: "resolved" }],
							regressions: [],
						},
					},
				},
			],
		}),
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	return recordPath;
}

const NOT_SIGNED =
	/not signed by this owner's record key.*run a new review|run a new review.*not signed by this owner's record key/s;

function verifyCall(repo: string, priorRunId: string) {
	return {
		repoDir: repo,
		priorRunId,
		head: "HEAD",
		keptFindingIds: ["F-1"],
	};
}

function commentCall(priorRunId: string, verifyRunId?: string) {
	return {
		ownerApproved: true as const,
		priorRunId,
		dismissed: [],
		lowAdvisory: [],
		...(verifyRunId === undefined ? {} : { verifyRunId }),
	};
}

/**
 * Every way a record can be planted, each built from a repository that
 * already holds one genuine signed review `real-1`.
 */
const PLANTED: Array<{ name: string; plant: (repo: string) => string }> = [
	{
		name: "an unsigned record",
		plant: (repo) => {
			plantReview(repo, "planted");
			return "planted";
		},
	},
	{
		name: "a record signed with another key",
		plant: (repo) => {
			signReviewRecord(plantReview(repo, "planted"), OTHER_KEY);
			return "planted";
		},
	},
	{
		name: "a genuine signed record copied to another run id",
		plant: (repo) => {
			cpSync(recordOf(repo, "real-1"), recordOf(repo, "planted"), {
				recursive: true,
			});
			return "planted";
		},
	},
	{
		name: "a genuine record with findings.json from another signed run",
		plant: (repo) => {
			const other = plantReview(repo, "real-2");
			writeFileSync(path.join(other, "findings.json"), "[]");
			signReviewRecord(other);
			cpSync(
				path.join(other, "findings.json"),
				path.join(recordOf(repo, "real-1"), "findings.json"),
			);
			return "real-1";
		},
	},
	{
		name: "a genuine record with its plan.mac removed",
		plant: (repo) => {
			rmSync(path.join(recordOf(repo, "real-1"), "plan.mac"));
			return "real-1";
		},
	},
];

describe("verify refuses a record not signed by the owner's key", () => {
	for (const { name, plant } of PLANTED) {
		it(`refuses ${name}, before any seat runs`, async () => {
			await withRepository(async (repo) => {
				signReviewRecord(plantReview(repo, "real-1"));
				const runId = plant(repo);
				const before = readdirSync(path.join(repo, ".review-panel", "runs"));
				await expect(
					verifyAction(verifyCall(repo, runId), { deps: deps() }),
				).rejects.toThrow(NOT_SIGNED);
				await expect(
					verifyAction(verifyCall(repo, runId), { deps: deps() }),
				).rejects.toThrow(/^Verify refused: /);
				expect(readdirSync(path.join(repo, ".review-panel", "runs"))).toEqual(
					before,
				);
			});
		});
	}

	it("refuses in runVerify itself too, for a seam that skips the action", async () => {
		await withRepository(async (repo) => {
			plantReview(repo, "planted");
			await expect(
				runVerify(
					{
						repoDir: repo,
						config,
						priorRunId: "planted",
						headRevision: git(repo, ["rev-parse", "HEAD"]).trim(),
						keptFindingIds: ["F-1"],
					},
					{
						recordKey: TEST_RECORD_KEY,
						runAdvisorySeat: () => {
							throw new Error("no seat may run");
						},
					},
				),
			).rejects.toThrow(NOT_SIGNED);
		});
	});

	it("refuses with no record key, and creates none", async () => {
		await withRepository(async (repo, root) => {
			signReviewRecord(plantReview(repo, "real-1"));
			const home = path.join(root, "home");
			mkdirSync(path.join(home, ".pi-review-panel"), { recursive: true });
			await expect(
				verifyAction(verifyCall(repo, "real-1"), {
					deps: deps({ home, recordKey: ownerRecordKey }),
				}),
			).rejects.toThrow(/^Verify refused: .*no record key/s);
			expect(
				existsSync(path.join(home, ".pi-review-panel", "record-key")),
			).toBe(false);
		});
	});
});

describe("comment refuses a record not signed by the owner's key", () => {
	for (const { name, plant } of PLANTED) {
		it(`refuses ${name} and posts nothing`, async () => {
			await withRepository(async (repo) => {
				signReviewRecord(plantReview(repo, "real-1"));
				const runId = plant(repo);
				const { bodies, postComment } = poster();
				await expect(
					commentAction(
						{
							repoDir: repo,
							...commentCall(runId),
							dismissed: [{ id: "F-1", reason: "out of scope" }],
						},
						{ deps: deps({ postComment }) },
					),
				).rejects.toThrow(NOT_SIGNED);
				expect(bodies).toEqual([]);
			});
		});
	}

	it("refuses a planted verify record that marks a genuine review's finding resolved", async () => {
		await withRepository(async (repo) => {
			signReviewRecord(plantReview(repo, "real-1"));
			plantVerify(repo, "v-planted", "real-1");
			const { bodies, postComment } = poster();
			await expect(
				commentAction(
					{ repoDir: repo, ...commentCall("real-1", "v-planted") },
					{ deps: deps({ postComment }) },
				),
			).rejects.toThrow(NOT_SIGNED);
			expect(bodies).toEqual([]);
		});
	});

	it("refuses a genuine verify record copied to another run id", async () => {
		await withRepository(async (repo) => {
			signReviewRecord(plantReview(repo, "real-1"));
			signVerifyRecord(plantVerify(repo, "v-1", "real-1"));
			cpSync(recordOf(repo, "v-1"), recordOf(repo, "v-copy"), {
				recursive: true,
			});
			const { bodies, postComment } = poster();
			await expect(
				commentAction(
					{ repoDir: repo, ...commentCall("real-1", "v-copy") },
					{ deps: deps({ postComment }) },
				),
			).rejects.toThrow(NOT_SIGNED);
			expect(bodies).toEqual([]);
			// The genuine verify record itself is accepted.
			await commentAction(
				{ repoDir: repo, ...commentCall("real-1", "v-1") },
				{ deps: deps({ postComment }) },
			);
			expect(bodies).toHaveLength(1);
		});
	});

	it("refuses with no record key, posts nothing and creates no key", async () => {
		await withRepository(async (repo, root) => {
			signReviewRecord(plantReview(repo, "real-1"));
			const home = path.join(root, "home");
			mkdirSync(path.join(home, ".pi-review-panel"), { recursive: true });
			const { bodies, postComment } = poster();
			await expect(
				commentAction(
					{
						repoDir: repo,
						...commentCall("real-1"),
						dismissed: [{ id: "F-1", reason: "out of scope" }],
					},
					{ deps: deps({ home, recordKey: ownerRecordKey, postComment }) },
				),
			).rejects.toThrow(/^comment refused: .*no record key/s);
			expect(bodies).toEqual([]);
			expect(
				existsSync(path.join(home, ".pi-review-panel", "record-key")),
			).toBe(false);
		});
	});
});

describe("the owner's own records still work", () => {
	it("review, then verify, then comment, end to end", async () => {
		await withRepository(async (repo) => {
			const { reviewAction } = await import("../src/actions/actions.js");
			await reviewAction(
				{ repoDir: repo, base: "HEAD~1", head: "HEAD" },
				{
					deps: deps({
						runReview: createSdkReviewRunner([
							{
								kind: "findings",
								findings: [{ ...SDK_FINDING, severity: "high" }],
							},
						]),
					}),
				},
			);
			const [reviewId] = readdirSync(path.join(repo, ".review-panel", "runs"));
			expect(
				existsSync(path.join(recordOf(repo, reviewId), "record.mac")),
			).toBe(true);
			commit(repo, "fix.txt");
			await verifyAction(verifyCall(repo, reviewId as string), {
				deps: deps({
					runVerify: (input, options) =>
						runVerify(input, {
							...options,
							runAdvisorySeat: createAdvisorySeatRunner(),
						}),
				}),
			});
			const verifyId = readdirSync(
				path.join(repo, ".review-panel", "runs"),
			).find((name) => name !== reviewId) as string;
			expect(
				existsSync(path.join(recordOf(repo, verifyId), "record.mac")),
			).toBe(true);
			const { bodies, postComment } = poster();
			await commentAction(
				{ repoDir: repo, ...commentCall(reviewId as string, verifyId) },
				{ deps: deps({ postComment }) },
			);
			expect(bodies).toHaveLength(1);
		});
	});

	it("a resumed review is signed at completion and verify reads it", async () => {
		await withRepository(async (repo) => {
			const seats = plannedSeats(["holistic", "security"]);
			const runId = await interruptedReviewRecord(repo, seats);
			await resumeRun(loadResumable(repo, runId, TEST_RECORD_KEY), {
				config: {
					roster: seats.map((seat) => ({
						id: seat.rosterId,
						provider: seat.provider,
						model: seat.model,
					})),
					defaults: { seats: seats.map((seat) => seat.rosterId) },
				},
				recordKey: TEST_RECORD_KEY,
				sessionFactory: createSdkSeatFake([{ kind: "default" }]).factory,
			});
			const prior = loadPriorRun(repo, runId, TEST_RECORD_KEY);
			expect(prior.findings.length).toBeGreaterThan(0);
			expect(() => loadPriorRun(repo, runId, OTHER_KEY)).toThrow(NOT_SIGNED);
			expect(
				JSON.parse(
					readFileSync(path.join(prior.recordPath, "meta.json"), "utf8"),
				).runId,
			).toBe(runId);
		});
	});
});
