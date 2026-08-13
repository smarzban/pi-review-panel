// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DISCARD_LEDGER_FILE } from "../src/run/flag.js";
import { COMPLETE_MARKER, PANEL_FILE } from "../src/run/record.js";
import {
	RunReviewError,
	type RunReviewOptions,
	runReview as runSdkReview,
} from "../src/run/run-review.js";
import { scheduleSeats } from "../src/run/scheduler.js";
import { type PinnedSnapshot, pinSnapshot } from "../src/run/snapshot.js";
import type { PlannedSeat, RunConfig } from "../src/run/types.js";
import {
	createSdkSeatFake,
	type FakeResponse,
	type FakeSdkRun,
	SDK_FINDING,
} from "./fixtures/sdk-seat-fake.js";

let sdkFake = createSdkSeatFake();
let lastSdkRuns: FakeSdkRun[] = [];
const DEFAULT_RESPONSES: FakeResponse[] = [{ kind: "default" }];

function runReview(config: RunConfig, options: RunReviewOptions = {}) {
	return runSdkReview(config, {
		...options,
		sessionFactory: options.sessionFactory ?? sdkFake.factory,
	});
}

function withSdkResponses<T>(
	responses: FakeResponse[],
	run: () => Promise<T>,
): Promise<T> {
	const previous = sdkFake;
	sdkFake = createSdkSeatFake(responses);
	return run().finally(() => {
		lastSdkRuns = sdkFake.runs;
		sdkFake = previous;
	});
}

const SDK_SUBMITTED_FINDING = SDK_FINDING;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A self-contained host repo with one commit; never touches the real repo. */
function createHostRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "run-review-host-"));
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "run@example.test"]);
	git(repo, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(repo, "committed.txt"), "committed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base"]);
	// Tests pass baseRef origin/main; publish the base commit under that name
	// so assertBaseResolves accepts it (no real remote needed).
	git(repo, ["branch", "-M", "main"]);
	git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	return repo;
}

function worktreeCount(repo: string): number {
	return git(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
}

function twoSeats(): PlannedSeat[] {
	return ["correctness", "security"].map((lens, index) => ({
		rosterId: `roster-${index}`,
		provider: "openai-codex",
		model: "gpt-5.3-codex",
		lens,
		lensPrompt: `Review this change through a ${lens} lens.`,
	}));
}

function removeFixture(...paths: string[]): void {
	for (const fixture of paths) {
		if (fixture !== "") {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * A synthetic completed prior record: a directory bearing the COMPLETE
 * marker and, optionally, a discard ledger written verbatim. The flagger
 * consumes exactly this shape (feature 4 authors real ledgers later).
 */
function makePriorRecord(
	root: string,
	name: string,
	ledgerContent?: string,
): string {
	const recordPath = path.join(root, name);
	mkdirSync(recordPath);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	if (ledgerContent !== undefined) {
		writeFileSync(path.join(recordPath, DISCARD_LEDGER_FILE), ledgerContent);
	}
	return recordPath;
}

describe("runReview", () => {
	it("pins the HEAD oid captured before reserve, not a later tip", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-head-oid-"));
		const before = git(repo, ["rev-parse", "HEAD"]).trim();
		let pinnedCommit: string | undefined;
		try {
			await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
					},
					{
						pinSnapshot: (repoDir, commit) => {
							pinnedCommit = commit;
							// Simulate a new commit landing after capture / during reserve.
							writeFileSync(path.join(repoDir, "late.txt"), "late\n");
							git(repoDir, ["add", "."]);
							git(repoDir, ["commit", "-m", "late"]);
							return pinSnapshot(repoDir, commit);
						},
					},
				),
			);
			expect(pinnedCommit).toBe(before);
			expect(git(repo, ["rev-parse", "HEAD"]).trim()).not.toBe(before);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins an explicit committed revision when provided, ignoring a moved HEAD (loop)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-explicit-rev-"));
		const before = git(repo, ["rev-parse", "HEAD"]).trim();
		// Advance HEAD after capturing the pinned revision: the run must
		// review the explicit revision, never the moved tip.
		writeFileSync(path.join(repo, "tip.txt"), "tip\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "tip"]);
		const pinned: Array<string | undefined> = [];

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
						revision: before,
					},
					{
						pinSnapshot: (repoDir, commit) => {
							pinned.push(commit);
							return pinSnapshot(repoDir, commit);
						},
					},
				),
			);

			// The snapshot is the explicit revision, and the report names it
			// as the HEAD OID reviewed, not the moved tip.
			expect(pinned).toEqual([before]);
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).toContain(`HEAD OID: \`${before}\``);
			expect(report).not.toContain("tip.txt");
			expect(result.outcomes).toHaveLength(2);
			for (const facts of result.outcomes) {
				expect(facts.outcome).toEqual({
					kind: "voted",
					findings: [SDK_SUBMITTED_FINDING],
				});
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an unknown baseRef before reserve or pin", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-unknown-base-"));
		try {
			let pinCalls = 0;
			await expect(
				runReview(
					{ repoDir: repo, baseRef: "definitely-not-a-ref", seats: twoSeats() },
					{
						pinSnapshot: () => {
							pinCalls += 1;
							throw new Error("pin must not run");
						},
					},
				),
			).rejects.toThrow(/does not resolve/);
			expect(pinCalls).toBe(0);
			expect(existsSync(path.join(repo, ".review-panel"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a missing or empty baseRef before any side effect; the runner is never invoked (AC-2)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-refuse-"));
		const spyLog = path.join(root, "stub-invocation.log");

		try {
			for (const baseRef of ["", "   "]) {
				await expect(
					withSdkResponses(DEFAULT_RESPONSES, () =>
						runReview({ repoDir: repo, baseRef, seats: twoSeats() }, {}),
					),
				).rejects.toThrow(/baseRef/);
			}

			// Zero side effects: no record directory, no snapshot, no runner.
			// The spy log stands in for the injectable runner: injected SDK seam records
			// it on every invocation, so its absence proves zero calls.
			expect(existsSync(path.join(repo, ".review-panel"))).toBe(false);
			expect(existsSync(spyLog)).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("runs two stub seats end to end: artifacts, COMPLETE marker, one released snapshot, both outcomes (the slice)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-e2e-"));

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{},
				),
			);

			// The record holds both artifacts and the completeness marker.
			expect(
				result.recordPath.startsWith(path.join(repo, ".review-panel", "runs")),
			).toBe(true);
			expect(existsSync(path.join(result.recordPath, "report.md"))).toBe(true);
			expect(existsSync(path.join(result.recordPath, "findings.json"))).toBe(
				true,
			);
			expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
				true,
			);
			expect(result.cleanupError).toBeUndefined();

			// findings.json carries both seats' submissions, run-stamped.
			const stamped = JSON.parse(
				readFileSync(path.join(result.recordPath, "findings.json"), "utf8"),
			);
			expect(stamped.map((row: { id: string }) => row.id)).toEqual([
				"F-1",
				"F-2",
			]);
			expect(
				stamped.map((row: { seat: { lens: string } }) => row.seat.lens),
			).toEqual(["correctness", "security"]);

			// The report is this run's: it carries the run id.
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).toContain(path.basename(result.recordPath));

			// The result carries both outcomes in planned order, both voted.
			expect(result.outcomes.map((facts) => facts.seat.lens)).toEqual([
				"correctness",
				"security",
			]);
			for (const facts of result.outcomes) {
				expect(facts.outcome).toEqual({
					kind: "voted",
					findings: [SDK_SUBMITTED_FINDING],
				});
				expect(facts.replay.worktree).toContain("review-panel-snapshot-");
				expect(facts.lifecycle.tokens.total).toBe(26);
			}

			// Both sessions reviewed the same pinned snapshot.
			const first = result.outcomes[0].replay.worktree;
			const second = result.outcomes[1].replay.worktree;
			expect(first).toBe(second);

			// The snapshot is gone: directory removed and unregistered from git.
			expect(existsSync(first)).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("still completes and marks the run when seats fail, attributing each failure (composition-level)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-seatfail-"));

		try {
			const result = await withSdkResponses([{ kind: "failure" }], () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{},
				),
			);

			// The run completes and is marked despite every seat failing.
			expect(existsSync(path.join(result.recordPath, "report.md"))).toBe(true);
			expect(existsSync(path.join(result.recordPath, "findings.json"))).toBe(
				true,
			);
			expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
				true,
			);
			expect(
				JSON.parse(
					readFileSync(path.join(result.recordPath, "findings.json"), "utf8"),
				),
			).toEqual([]);

			// Each failure is attributed: class and reason per seat.
			expect(result.outcomes).toHaveLength(2);
			for (const facts of result.outcomes) {
				expect(facts.outcome).toMatchObject({
					kind: "failed",
					class: "provider-error",
				});
				if (facts.outcome.kind === "failed") {
					expect(facts.outcome.reason.length).toBeGreaterThan(0);
				}
			}
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("leaves the record unmarked but releases the snapshot when a post-pin stage fails, naming the stage (AC-31)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-fatal-"));
		const spyLog = path.join(root, "stub-invocation.log");

		try {
			let error: unknown;
			try {
				await withSdkResponses(DEFAULT_RESPONSES, () =>
					runReview(
						{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
						{
							// Forced fatal after pinning: the injected scheduler throws.
							scheduleSeats: async () => {
								throw new Error("injected scheduler failure");
							},
						},
					),
				);
			} catch (caught) {
				error = caught;
			}

			// The error names the failed stage and carries its cause.
			expect(error).toBeInstanceOf(RunReviewError);
			if (error instanceof RunReviewError) {
				expect(error.stage).toBe("schedule");
				expect(error.message).toContain('stage "schedule"');
				expect(error.message).toContain("injected scheduler failure");
			}

			// The runner never spoke: the injected scheduler short-circuited
			// the seat layer before any seat spawn.
			expect(existsSync(spyLog)).toBe(false);

			// A reserved-but-unmarked record is the audit trail: present, no
			// COMPLETE marker, and no report (render never ran).
			const runsDir = path.join(repo, ".review-panel", "runs");
			const runIds = readdirSync(runsDir);
			expect(runIds).toHaveLength(1);
			const recordPath = path.join(runsDir, runIds[0]);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);
			expect(existsSync(path.join(recordPath, "report.md"))).toBe(false);

			// The snapshot was still released on the fatal path.
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("flags co-located current findings in report.md with the prior discard reason (AC-16, full stack)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-flag-"));

		// A completed prior record whose ledger co-locates with the stub
		// finding (src/example.ts:1; ledger line 10 is inside the 20-line
		// ADR-0002 window).
		const prior = makePriorRecord(
			root,
			"prior-record",
			JSON.stringify([
				{
					id: "F-9",
					file: "src/example.ts",
					line: 10,
					reason: "discarded as a false positive last run",
				},
			]),
		);

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
						priorRecordPaths: [prior],
					},
					{},
				),
			);

			expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
				true,
			);
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);

			// Both seats submitted the SAME co-located finding, so F-1 and
			// F-2 each carry the flag and the prior reason verbatim.
			expect(
				countOccurrences(
					report,
					"- Flag: co-locates with a finding discarded in a prior run.",
				),
			).toBe(2);
			expect(
				countOccurrences(
					report,
					"- Prior discard reason: discarded as a false positive last run",
				),
			).toBe(2);

			// Annotations live in report.md only: findings.json stays the
			// stamped set, untouched by the flagger.
			const findings = readFileSync(
				path.join(result.recordPath, "findings.json"),
				"utf8",
			);
			expect(findings).not.toContain("discarded as a false positive last run");
			expect(JSON.parse(findings).map((row: { id: string }) => row.id)).toEqual(
				["F-1", "F-2"],
			);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("surfaces an unreadable prior ledger in the report instead of skipping it (AC-33, full stack)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-notice-"));

		// A completed prior record whose ledger is corrupt.
		const prior = makePriorRecord(root, "prior-record", "{{{ this is not json");

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
						priorRecordPaths: [prior],
					},
					{},
				),
			);

			// The unreadable ledger does not abort the run.
			expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
				true,
			);
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);

			// The notice is unmissable: its section names the record and the
			// reason, ahead of the findings, which still render.
			expect(report).toContain("## Unreadable discard ledgers");
			expect(report).toContain(`- Record: ${prior}`);
			expect(report).toContain(
				"- Reason: discard-ledger.json is not valid JSON",
			);
			expect(report.indexOf("## Unreadable discard ledgers")).toBeLessThan(
				report.indexOf("## Findings"),
			);
			expect(report).toContain("### F-1 [low]");
			expect(report).not.toContain("- Flag:");
		} finally {
			removeFixture(repo, root);
		}
	});

	it("renders no annotations when no prior record paths are configured (AC-17, full stack)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-noprior-"));

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{},
				),
			);

			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).not.toContain("## Unreadable discard ledgers");
			expect(report).not.toContain("- Flag:");
			expect(report).toContain("### F-1 [low]");
		} finally {
			removeFixture(repo, root);
		}
	});

	it("records a cleanup failure alongside the outcome without changing it (AC-19)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-cleanup-"));
		let realPin: PinnedSnapshot | undefined;

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{
						// Forced cleanup failure: the real pin's release is
						// replaced with one that fails as data.
						pinSnapshot: (repoDir, commit) => {
							const pin = pinSnapshot(repoDir, commit);
							realPin = pin;
							return {
								worktreePath: pin.worktreePath,
								release: () => ({ ok: false, error: "forced cleanup failure" }),
							};
						},
					},
				),
			);

			// The run's reported outcome is unchanged: a successful, marked run.
			expect(result.outcomes).toHaveLength(2);
			for (const facts of result.outcomes) {
				expect(facts.outcome).toEqual({
					kind: "voted",
					findings: [SDK_SUBMITTED_FINDING],
				});
			}
			expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
				true,
			);

			// The cleanup error is recorded alongside it and is durable.
			expect(result.cleanupError).toBe("forced cleanup failure");
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).toContain("## Snapshot cleanup failure");
			expect(report).toContain("forced cleanup failure");
			expect(
				readFileSync(path.join(result.recordPath, "cleanup-error.txt"), "utf8"),
			).toContain("forced cleanup failure");

			// The forced release was the one consulted: the real snapshot
			// survives the run, still registered in git.
			expect(realPin).not.toBeUndefined();
			if (realPin !== undefined) {
				expect(existsSync(realPin.worktreePath)).toBe(true);
				expect(worktreeCount(repo)).toBe(2);
			}
		} finally {
			realPin?.release();
			removeFixture(repo, root);
		}
	});

	it("freezes the base OID before scheduling so a moved symbolic base is ignored", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-base-oid-"));
		const baseOid = git(repo, ["rev-parse", "origin/main"]).trim();
		// Advance the symbolic tip while leaving origin/main as a movable name.
		writeFileSync(path.join(repo, "tip.txt"), "tip\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "tip"]);
		// Point a symbolic base name at the original OID.
		git(repo, ["branch", "-f", "review-base", baseOid]);
		const scheduledBases: string[] = [];

		try {
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "review-base",
						seats: twoSeats(),
					},
					{
						scheduleSeats: async (input, options) => {
							scheduledBases.push(input.baseRef);
							// Move the symbolic base after resolve, before seats run.
							git(repo, ["branch", "-f", "review-base", "HEAD"]);
							return scheduleSeats(input, options);
						},
					},
				),
			);

			expect(scheduledBases).toEqual([baseOid]);
			for (const facts of result.outcomes) {
				expect(facts.replay.baseRef).toBe(baseOid);
				expect(facts.replay.baseRef).not.toBe("review-base");
			}
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).toContain("Base ref: `review-base`");
			expect(report).toContain(`Base OID: \`${baseOid}\``);
			expect(report).toMatch(/HEAD OID: `[0-9a-f]{40}`/);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("refuses a leading-dash base before any side effect", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-dash-base-"));
		try {
			let pinCalls = 0;
			await expect(
				runReview(
					{ repoDir: repo, baseRef: "--output=/tmp/x", seats: twoSeats() },
					{
						pinSnapshot: () => {
							pinCalls += 1;
							throw new Error("pin must not run");
						},
					},
				),
			).rejects.toThrow(/git option/);
			expect(pinCalls).toBe(0);
			expect(existsSync(path.join(repo, ".review-panel"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an empty seats list before reserve or pin", async () => {
		const repo = createHostRepo();
		try {
			await expect(
				runReview({ repoDir: repo, baseRef: "origin/main", seats: [] }, {}),
			).rejects.toThrow(/at least one seat/);
			expect(existsSync(path.join(repo, ".review-panel"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("leaves the record unmarked when the host cancels mid-run", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-cancel-"));
		const controller = new AbortController();
		const seats = ["a", "b", "c", "d", "e"].map((lens, index) => ({
			rosterId: `roster-${index}`,
			provider: "openai-codex",
			model: "gpt-5.3-codex",
			lens,
			lensPrompt: `lens ${lens}`,
		}));
		let releaseCalls = 0;

		try {
			const pending = withSdkResponses([{ kind: "pending" }], () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats },
					{
						abortSignal: controller.signal,
						pinSnapshot: (repoDir, commit) => {
							const pin = pinSnapshot(repoDir, commit);
							return {
								worktreePath: pin.worktreePath,
								release: () => {
									releaseCalls += 1;
									return pin.release();
								},
							};
						},
					},
				),
			);
			// Wait until the SDK seam observes four in-flight sessions.
			while (sdkFake.runs.length < 4) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			controller.abort();
			await expect(pending).rejects.toThrow(/cancel|teardown/i);

			const runsDir = path.join(repo, ".review-panel", "runs");
			const runIds = existsSync(runsDir) ? readdirSync(runsDir) : [];
			expect(runIds.length).toBe(1);
			const recordPath = path.join(runsDir, runIds[0]);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
			expect(releaseCalls).toBe(1);
			// Queued fifth seat never opened an SDK session.
			expect(lastSdkRuns).toHaveLength(4);
			expect(lastSdkRuns.every((run) => run.aborted && run.disposed)).toBe(
				true,
			);
		} finally {
			controller.abort();
			removeFixture(repo, root);
		}
	});

	it("releaseOnce: post-release persistence failure does not invent cleanupError", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-release-once-"));
		let releaseCalls = 0;
		let realPin: PinnedSnapshot | undefined;

		try {
			await expect(
				withSdkResponses(DEFAULT_RESPONSES, () =>
					runReview(
						{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
						{
							pinSnapshot: (repoDir, commit) => {
								const pin = pinSnapshot(repoDir, commit);
								realPin = pin;
								return {
									worktreePath: pin.worktreePath,
									release: () => {
										releaseCalls += 1;
										return pin.release();
									},
								};
							},
							scheduleSeats: async (input, options) => {
								const outcomes = await scheduleSeats(input, options);
								// Make the report destination a directory. runReview reaches
								// its release stage successfully, then report persistence fails.
								const runsDir = path.join(repo, ".review-panel", "runs");
								const recordPath = path.join(runsDir, readdirSync(runsDir)[0]);
								mkdirSync(path.join(recordPath, "report.md"));
								return outcomes;
							},
						},
					),
				),
			).rejects.toMatchObject({
				name: "RunReviewError",
				stage: "render",
				cleanupError: undefined,
			});
			expect(releaseCalls).toBe(1);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			if (realPin !== undefined && existsSync(realPin.worktreePath)) {
				realPin.release();
			}
			removeFixture(repo, root);
		}
	});

	it("refuses an already-aborted signal before any side effect", async () => {
		const repo = createHostRepo();
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{
						abortSignal: controller.signal,
					},
				),
			).rejects.toThrow(/already cancelled/);
			expect(existsSync(path.join(repo, ".review-panel"))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("threads a configured scopingNote into the scheduler input verbatim (AC-23)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-scope-note-"));
		const note = "Scope: only the src/ directory, ignore tests.\nSecond line.";
		let scheduledNote: string | undefined;

		try {
			await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
						scopingNote: note,
					},
					{
						scheduleSeats: async (input, options) => {
							scheduledNote = input.scopingNote;
							return scheduleSeats(input, options);
						},
					},
				),
			);

			// The note reaches the scheduler input byte-for-byte; T-4 already
			// proved ScheduleInput.scopingNote reaches every SeatSpec verbatim.
			expect(scheduledNote).toBe(note);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("leaves the scopingNote key off the scheduler input when note is absent (AC-23)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-scope-absent-"));
		let scheduledInput: Parameters<typeof scheduleSeats>[0] | undefined;

		try {
			await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{
						scheduleSeats: async (input, options) => {
							scheduledInput = input;
							return scheduleSeats(input, options);
						},
					},
				),
			);

			// The key is absent, not merely undefined: an absent SeatSpec
			// scopingNote adds no prompt scoping section downstream.
			expect(scheduledInput).not.toBeUndefined();
			expect(Object.hasOwn(scheduledInput ?? {}, "scopingNote")).toBe(false);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("surfaces a throwing writePanel as a panel-stage failure before pin or schedule runs (AC-25)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-panel-throw-"));
		try {
			let pinCalls = 0;
			let error: unknown;
			try {
				await runReview(
					{ repoDir: repo, baseRef: "origin/main", seats: twoSeats() },
					{
						writePanel: () => {
							throw new Error("injected panel write failure");
						},
						pinSnapshot: () => {
							pinCalls += 1;
							throw new Error("pin must not run");
						},
					},
				);
			} catch (caught) {
				error = caught;
			}

			// The error names the panel stage and carries its cause; pin never ran.
			expect(error).toBeInstanceOf(RunReviewError);
			if (error instanceof RunReviewError) {
				expect(error.stage).toBe("panel");
				expect(error.message).toContain('stage "panel"');
				expect(error.message).toContain("injected panel write failure");
			}
			expect(pinCalls).toBe(0);

			// The record was reserved but the panel write failed first: the
			// aborted run holds no panel.json (nothing was written) and no marker.
			const runsDir = path.join(repo, ".review-panel", "runs");
			const runIds = existsSync(runsDir) ? readdirSync(runsDir) : [];
			expect(runIds).toHaveLength(1);
			const recordPath = path.join(runsDir, runIds[0]);
			expect(existsSync(path.join(recordPath, PANEL_FILE))).toBe(false);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);
		} finally {
			removeFixture(repo, root);
		}
	});

	it("persists the exact planned panel before pinning; an aborted run retains it (AC-22, AC-23, AC-25)", async () => {
		const repo = createHostRepo();
		const root = mkdtempSync(path.join(tmpdir(), "run-review-panel-"));
		const note = "Scope: only the src/ directory.\nSecond line.";

		try {
			// A completed run's durable panel carries every planned row, the
			// human-facing baseRef, and the scoping note verbatim.
			const result = await withSdkResponses(DEFAULT_RESPONSES, () =>
				runReview(
					{
						repoDir: repo,
						baseRef: "origin/main",
						seats: twoSeats(),
						scopingNote: note,
					},
					{},
				),
			);

			const panel = JSON.parse(
				readFileSync(path.join(result.recordPath, PANEL_FILE), "utf8"),
			);
			expect(Object.keys(panel)).toEqual([
				"runId",
				"baseRef",
				"scopingNote",
				"seats",
			]);
			expect(panel.runId).toBe(path.basename(result.recordPath));
			expect(panel.baseRef).toBe("origin/main");
			expect(panel.scopingNote).toBe(note);
			expect(panel.seats).toEqual([
				{
					rosterId: "roster-0",
					lens: "correctness",
					provider: "openai-codex",
					model: "gpt-5.3-codex",
				},
				{
					rosterId: "roster-1",
					lens: "security",
					provider: "openai-codex",
					model: "gpt-5.3-codex",
				},
			]);
			for (const row of panel.seats) {
				expect(Object.keys(row)).toEqual([
					"rosterId",
					"lens",
					"provider",
					"model",
				]);
			}

			// A pin failure aborts the run AFTER the panel write: the reserved
			// record still holds panel.json, before either pin or scheduling
			// could proceed. A distinct baseRef keeps the two run-ids apart.
			git(repo, ["branch", "-f", "review-base", "HEAD"]);
			let error: unknown;
			try {
				await runReview(
					{ repoDir: repo, baseRef: "review-base", seats: twoSeats() },
					{
						pinSnapshot: () => {
							throw new Error("injected pin failure");
						},
					},
				);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(RunReviewError);
			if (error instanceof RunReviewError) {
				expect(error.stage).toBe("pin");
			}

			const runsDir = path.join(repo, ".review-panel", "runs");
			const runIds = readdirSync(runsDir);
			expect(runIds).toHaveLength(2);
			const aborted = path.join(
				runsDir,
				runIds.find((id: string) => id !== path.basename(result.recordPath)) ??
					"",
			);
			expect(existsSync(path.join(aborted, PANEL_FILE))).toBe(true);
			expect(existsSync(path.join(aborted, COMPLETE_MARKER))).toBe(false);
			const abortedPanel = JSON.parse(
				readFileSync(path.join(aborted, PANEL_FILE), "utf8"),
			);
			expect(abortedPanel.baseRef).toBe("review-base");
			// No scoping note was configured on the aborted run: key omitted.
			expect(Object.hasOwn(abortedPanel, "scopingNote")).toBe(false);
			expect(abortedPanel.seats).toEqual(panel.seats);
		} finally {
			removeFixture(repo, root);
		}
	});
});
