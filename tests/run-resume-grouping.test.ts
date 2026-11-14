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

import type { Config } from "../src/config/schema.js";
import {
	GROUPS_FILE,
	GROUPS_MAC_FILE,
	planConsolidator,
	readSignedGroups,
} from "../src/run/grouping.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { loadResumable, resumeRun } from "../src/run/resume.js";
import { type RunReviewResult, runReview } from "../src/run/run-review.js";
import {
	interruptedReviewRecord,
	plannedSeats,
} from "./fixtures/interrupted-run.js";
import { signGroups, TEST_RECORD_KEY } from "./fixtures/record-key.js";
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
		expect(
			readSignedGroups(result.recordPath, TEST_RECORD_KEY)?.flatMap(
				(group) => group.findingIds,
			),
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
		expect(existsSync(path.join(recordPath, GROUPS_FILE))).toBe(true);
		expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
	});

	it("never keeps a grouping made before the interruption: without a consolidator it is removed", async () => {
		const repo = createHostRepo();
		const runId = await interruptedReviewRecord(repo, SEATS);
		const recordPath = path.join(repo, ".review-panel", "runs", runId);
		writeFileSync(
			path.join(recordPath, GROUPS_FILE),
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
		expect(existsSync(path.join(recordPath, GROUPS_FILE))).toBe(false);
		expect(existsSync(path.join(recordPath, GROUPS_MAC_FILE))).toBe(false);
		expect(
			readFileSync(path.join(recordPath, "report.md"), "utf8"),
		).not.toContain("G-1");
	});
});
