import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAction } from "../src/actions/actions.js";
import type { Config } from "../src/config/schema.js";
import { planConsolidator, recordedGrouping } from "../src/run/grouping.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { loadResumable, resumeRun } from "../src/run/resume.js";
import { type RunReviewResult, runReview } from "../src/run/run-review.js";
import type { RunVerifyInput } from "../src/run/run-verify.js";
import { pinSnapshot } from "../src/run/snapshot.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import {
	signGroups,
	TEST_RECORD_KEY,
	testGroupsMac,
	testPlanMac,
} from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let root = "";
afterEach(() => {
	if (root !== "") {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createHostRepo(): string {
	root = mkdtempSync(path.join(tmpdir(), "resume-grouping-"));
	const repo = realpathSync(root);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "run@example.test"]);
	git(repo, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	writeFileSync(path.join(repo, "change.txt"), "change\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "change", "--quiet"]);
	return repo;
}

const SEATS = plannedSeats(["correctness", "security"]);

function ownerConfig(consolidator?: string): Config {
	return {
		roster: [
			...SEATS.map((seat) => ({
				id: seat.rosterId,
				provider: seat.provider,
				model: seat.model,
			})),
			{ id: "opus", provider: "anthropic", model: "claude-opus-5" },
		],
		defaults: {
			seats: ["seat-0"],
			...(consolidator === undefined ? {} : { consolidator }),
		},
	};
}

function onlyRecord(repo: string): string {
	const runs = path.join(repo, ".review-panel", "runs");
	return path.join(runs, readdirSync(runs)[0] as string);
}

/** The grouping the finished record's execution.json holds. */
function recorded(recordPath: string) {
	return recordedGrouping(
		readFileSync(path.join(recordPath, "execution.json"), "utf8"),
		readFileSync(path.join(recordPath, "findings.json"), "utf8"),
	);
}

describe("resume and the grouping step", () => {
	it("runs the grouping step at the end of a resumed review (T495)", async () => {
		const repo = createHostRepo();
		const runId = await interruptedReviewRecord(repo, SEATS);
		const fake = createSdkSeatFake();
		const result = await resumeRun(
			loadResumable(repo, runId, TEST_RECORD_KEY),
			{
				recordKey: TEST_RECORD_KEY,
				config: ownerConfig("opus"),
				sessionFactory: fake.factory,
			},
		);
		const kinds = fake.runs.map((run) => run.input.spec.profile?.kind);
		expect(kinds).toEqual([undefined, "grouping"]);
		expect((result as RunReviewResult).grouping?.outcome.kind).toBe("grouped");
		const groups = recorded(result.recordPath);
		expect(
			groups.kind === "grouped"
				? groups.groups.flatMap((group) => group.findingIds)
				: groups,
		).toEqual(["F-1", "F-2"]);
		expect(existsSync(path.join(result.recordPath, COMPLETE_MARKER))).toBe(
			true,
		);
	});

	it("runs only the grouping step when every seat settled before the interruption", async () => {
		const repo = createHostRepo();
		const controller = new AbortController();
		const first = createSdkSeatFake(
			[{ kind: "default" }],
			[{ kind: "pending" }],
		);
		const interrupted = runReview(
			{
				repoDir: repo,
				baseRef: "HEAD~1",
				seats: SEATS,
				consolidator: planConsolidator(ownerConfig("opus")),
			},
			{
				abortSignal: controller.signal,
				recordKey: TEST_RECORD_KEY,
				sessionFactory: async (input) => {
					const session = await first.factory(input);
					if (input.spec.profile?.kind === "grouping") {
						controller.abort();
					}
					return session;
				},
			},
		);
		await expect(interrupted).rejects.toThrow(/cancel/i);
		const recordPath = onlyRecord(repo);
		expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);

		const loaded = loadResumable(
			repo,
			path.basename(recordPath),
			TEST_RECORD_KEY,
		);
		expect(loaded.missing).toEqual([]);
		const fake = createSdkSeatFake();
		const result = await resumeRun(loaded, {
			recordKey: TEST_RECORD_KEY,
			config: ownerConfig("opus"),
			sessionFactory: fake.factory,
		});
		expect(fake.runs.map((run) => run.input.spec.profile?.kind)).toEqual([
			"grouping",
		]);
		expect(result.resumedSeats).toEqual([]);
		expect((result as RunReviewResult).grouping?.seat.rosterId).toBe("opus");
		expect(recorded(recordPath).kind).toBe("grouped");
		expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
	});

	it("never keeps a grouping made before the interruption: without a consolidator the record has none", async () => {
		const repo = createHostRepo();
		const runId = await interruptedReviewRecord(repo, SEATS);
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		writeFileSync(
			path.join(recordPath, "groups.json"),
			JSON.stringify({
				version: 1,
				runId,
				groups: [{ id: "G-1", findingIds: ["F-1", "F-2"] }],
			}),
		);
		signGroups(recordPath);
		const result = await resumeRun(
			loadResumable(repo, runId, TEST_RECORD_KEY),
			{
				recordKey: TEST_RECORD_KEY,
				config: ownerConfig(),
				sessionFactory: createSdkSeatFake().factory,
			},
		);
		expect((result as RunReviewResult).grouping).toBeUndefined();
		expect(recorded(recordPath)).toEqual({
			kind: "none",
			why: "no grouping step ran",
		});
		expect(
			readFileSync(path.join(recordPath, "report.md"), "utf8"),
		).not.toContain("G-1");
	});

	it("keeps no grouping made before the interruption when the configured grouping seat fails, and reports the flat list (panel P-3)", async () => {
		const repo = createHostRepo();
		const runId = await interruptedReviewRecord(repo, SEATS);
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		writeFileSync(
			path.join(recordPath, "groups.json"),
			JSON.stringify({
				version: 1,
				runId,
				groups: [{ id: "G-1", findingIds: ["F-1", "F-2"] }],
			}),
		);
		signGroups(recordPath);
		const fake = createSdkSeatFake(
			[{ kind: "default" }],
			[{ kind: "failure", message: "provider down" }],
		);
		const result = await resumeRun(
			loadResumable(repo, runId, TEST_RECORD_KEY),
			{
				recordKey: TEST_RECORD_KEY,
				config: ownerConfig("opus"),
				sessionFactory: fake.factory,
			},
		);
		expect(fake.runs.map((run) => run.input.spec.profile?.kind)).toEqual([
			undefined,
			"grouping",
		]);
		expect((result as RunReviewResult).grouping?.outcome).toMatchObject({
			kind: "lost",
			class: "provider-error",
		});
		expect(recorded(recordPath)).toEqual({
			kind: "none",
			why: "its grouping was lost",
		});
		const report = readFileSync(path.join(recordPath, "report.md"), "utf8");
		expect(report).toContain(
			"Lost: grouping (opus, provider-error). The list below is not grouped.",
		);
		expect(report).not.toContain("G-1");
		expect(report).toMatch(/^### F-1 \[/m);
		expect(report).toMatch(/^### F-2 \[/m);
		expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
	});
});

/**
 * A `groups.json` and `groups.mac` as releases before T501 wrote them beside
 * a review, signed over the record's plan and its current `findings.json`.
 */
function plantOldGroupsPair(
	recordPath: string,
	groups: Array<{ id: string; findingIds: string[] }>,
): void {
	const runId = path.basename(recordPath);
	const bytes = `${JSON.stringify(
		{
			version: 1,
			runId,
			consolidator: {
				rosterId: "opus",
				provider: "anthropic",
				model: "claude-opus-5",
			},
			groups,
		},
		null,
		2,
	)}\n`;
	writeFileSync(path.join(recordPath, "groups.json"), bytes);
	writeFileSync(
		path.join(recordPath, "groups.mac"),
		testGroupsMac(
			runId,
			testPlanMac(
				runId,
				readFileSync(path.join(recordPath, "plan.json"), "utf8"),
			),
			readFileSync(path.join(recordPath, "findings.json"), "utf8"),
			bytes,
		),
	);
}

const sameFinding = (title: string) => ({
	file: "change.txt",
	line: 1,
	severity: "high" as const,
	title,
	evidence: `${title} evidence`,
});

/**
 * A review that groups F-1 and F-2 as G-1, then dies after the grouping step
 * and before COMPLETE. Every reviewer seat has settled, so a resume runs only
 * the grouping step again, over the same findings.
 */
async function crashAfterGrouping(repo: string): Promise<string> {
	await runReview(
		{
			repoDir: repo,
			baseRef: "HEAD~1",
			seats: SEATS,
			consolidator: planConsolidator(ownerConfig("opus")),
		},
		{
			recordKey: TEST_RECORD_KEY,
			sessionFactory: createSdkSeatFake(
				[
					{ kind: "findings", findings: [sameFinding("A0")] },
					{ kind: "findings", findings: [sameFinding("A1")] },
				],
				[
					{
						kind: "grouping",
						attempts: [{ groups: [{ findingIds: ["F-1", "F-2"] }] }],
					},
				],
			).factory,
			pinSnapshot: (dir, commit) => {
				const snapshot = pinSnapshot(dir, commit);
				return {
					worktreePath: snapshot.worktreePath,
					release: () => {
						snapshot.release();
						throw new Error("killed after grouping");
					},
				};
			},
		},
	).catch(() => undefined);
	const recordPath = onlyRecord(repo);
	expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);
	return recordPath;
}

/** Verify deps that record the F-ids verify was asked to check. */
function verifyDeps(seen: string[][]) {
	return {
		env: {},
		home: "/tmp/resume-grouping-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => ownerConfig("opus"),
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runVerify: async (input: RunVerifyInput) => {
			seen.push([...input.keptFindingIds]);
			throw new Error("stop after the ids are seen");
		},
	};
}

describe("G-ids expand only from the grouping in the signed execution.json (T501)", () => {
	it("a resume regroups the same findings differently; the old signed pair put back is ignored", async () => {
		const repo = createHostRepo();
		const recordPath = await crashAfterGrouping(repo);
		const runId = path.basename(recordPath);
		const result = await resumeRun(
			loadResumable(repo, runId, TEST_RECORD_KEY),
			{
				recordKey: TEST_RECORD_KEY,
				config: ownerConfig("opus"),
				sessionFactory: createSdkSeatFake(
					[{ kind: "default" }],
					[
						{
							kind: "grouping",
							attempts: [
								{ groups: [{ findingIds: ["F-1"] }, { findingIds: ["F-2"] }] },
							],
						},
					],
				).factory,
			},
		);
		expect(result.resumedSeats).toEqual([]);
		expect((result as RunReviewResult).grouping?.outcome).toEqual({
			kind: "grouped",
			groups: [
				{ id: "G-1", findingIds: ["F-1"] },
				{ id: "G-2", findingIds: ["F-2"] },
			],
		});
		expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
		// The grouping from before the crash, signed as earlier releases did,
		// over this very plan and these very findings bytes.
		plantOldGroupsPair(recordPath, [{ id: "G-1", findingIds: ["F-1", "F-2"] }]);
		git(repo, ["commit", "--allow-empty", "-m", "fix", "--quiet"]);
		const seen: string[][] = [];
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: runId,
					head: "HEAD",
					keptFindingIds: ["G-1"],
				},
				{ deps: verifyDeps(seen) },
			),
		).rejects.toThrow(/stop after the ids are seen/);
		// G-1 is the split the resumed reply showed, never the old pair's.
		expect(seen).toEqual([["F-1"]]);
	});

	it("a resume whose grouping is lost refuses G-ids, even with the old signed pair put back", async () => {
		const repo = createHostRepo();
		const recordPath = await crashAfterGrouping(repo);
		const runId = path.basename(recordPath);
		const result = await resumeRun(
			loadResumable(repo, runId, TEST_RECORD_KEY),
			{
				recordKey: TEST_RECORD_KEY,
				config: ownerConfig("opus"),
				sessionFactory: createSdkSeatFake(
					[{ kind: "default" }],
					[{ kind: "failure", message: "provider down" }],
				).factory,
			},
		);
		expect((result as RunReviewResult).grouping?.outcome.kind).toBe("lost");
		plantOldGroupsPair(recordPath, [{ id: "G-1", findingIds: ["F-1", "F-2"] }]);
		git(repo, ["commit", "--allow-empty", "-m", "fix", "--quiet"]);
		const seen: string[][] = [];
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: runId,
					head: "HEAD",
					keptFindingIds: ["G-1"],
				},
				{ deps: verifyDeps(seen) },
			),
		).rejects.toThrow(
			/Verify refused: G-ids need the review's signed grouping.*grouping was lost.*pass F-ids/,
		);
		expect(seen).toEqual([]);
	});
});
