import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { type RunVerifyResult, runVerify } from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import type { VerificationProfile } from "../src/seat/channel-profile.js";
import { replaySeat } from "../src/seat/replay.js";
import {
	runAdvisorySeat,
	runSeatForReplay,
	type SeatRunResult,
} from "../src/seat/run-seat.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

/**
 * F-3/F-4: the undo guard reaches the seat's own submission tool. Nothing
 * here supplies a seat's answer past the channel: the real
 * `runAdvisorySeat` builds the real `submit_verification` tool from the
 * spec, and an SDK session fake calls it, so a row whose `undoes` is not
 * one of the ids an earlier round resolved is refused by
 * `validateVerification` itself. Dropping `undoableIds` anywhere on the way
 * (run-verify's spec, run-seat's `createSeatTools`, the seat extension or
 * the verification channel) refuses the accepted row too.
 */

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const REVIEW = "2026-11-15T10-00-00-000Z-review";

function finding(id: string, severity: "high" | "medium"): StampedFinding {
	return {
		id,
		seat: { provider: "p", model: "m", lens: "holistic" },
		finding: {
			file: `src/${id}.ts`,
			line: 1,
			severity,
			title: `${id} title`,
			evidence: `${id} evidence`,
		},
	};
}

const config: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

let root: string;
let repo: string;
let commits: string[];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "undo-guard-wiring-"));
	repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "test@example.test"]);
	git(repo, ["config", "user.name", "Test"]);
	commits = [];
	for (const name of ["base", "head", "fix1", "fix2"]) {
		writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", name, "--quiet"]);
		commits.push(git(repo, ["rev-parse", "HEAD"]));
	}
	const recordPath = path.join(repo, ".review-panel", "runs", REVIEW);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId: REVIEW,
			baseRef: "main",
			baseOid: commits[0],
			headOid: commits[1],
		}),
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify([finding("F-1", "high"), finding("F-2", "medium")]),
	);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A regression row; `undoes` names the fix it says this change undid. */
function regression(undoes: string) {
	return {
		file: "src/F-1.ts",
		line: 2,
		title: `this change undoes ${undoes}`,
		evidence: "the guard is gone again",
		undoes,
	};
}

/** Refused: F-2 was dismissed, never resolved. Then accepted: F-1. */
const TWO_TRIES = [
	{ regressions: [regression("F-2")] },
	{ regressions: [regression("F-1")] },
];

/** Runs a verify through the real seat runner and the SDK session fake. */
async function verifyThroughChannel(
	input: {
		priorRunId: string;
		headRevision: string;
		keptFindingIds: string[];
		final?: true;
		dismissed?: Array<{ id: string; reason: string }>;
	},
	fake: ReturnType<typeof createSdkSeatFake>,
	seats: Array<SeatRunResult<VerificationProfile>> = [],
): Promise<RunVerifyResult> {
	return await runVerify(
		{ repoDir: repo, config, ...input },
		{
			recordKey: TEST_RECORD_KEY,
			pinSnapshot: () => ({
				worktreePath: repo,
				release: () => ({ ok: true }),
			}),
			runAdvisorySeat: async (spec, options) => {
				const result = await runAdvisorySeat(spec, {
					...options,
					sessionFactory: fake.factory,
				});
				seats.push(result);
				return result;
			},
		},
	);
}

/** Verify 1: F-1 resolved through the channel, F-2 dismissed. */
async function firstRound(): Promise<RunVerifyResult> {
	return await verifyThroughChannel(
		{
			priorRunId: REVIEW,
			headRevision: commits[2] as string,
			keptFindingIds: ["F-1"],
			dismissed: [{ id: "F-2", reason: "by design" }],
		},
		createSdkSeatFake([{ kind: "verification" }]),
	);
}

function undoesOf(result: RunVerifyResult): Array<string | undefined> {
	return result.outcomes.flatMap((row) =>
		row.outcome.kind === "voted"
			? row.outcome.result.regressions.map((item) => item.undoes)
			: [],
	);
}

describe("the undo guard reaches the seat's submission tool (F-3, F-4)", () => {
	it("a chained round: an undoes id outside the resolved ids is refused by the tool, one inside is accepted", async () => {
		const v1 = await firstRound();
		const fake = createSdkSeatFake([
			{ kind: "verification", attempts: TWO_TRIES },
		]);
		const v2 = await verifyThroughChannel(
			{
				priorRunId: path.basename(v1.recordPath),
				headRevision: commits[3] as string,
				keptFindingIds: [],
			},
			fake,
		);
		expect(fake.runs[0]?.refusals).toHaveLength(1);
		expect(fake.runs[0]?.refusals[0]).toMatch(
			/^regressions\[0\]\.undoes must be one of/u,
		);
		expect(undoesOf(v2)).toEqual(["F-1"]);
	});

	it("the final check: the same guard, every resolved id, through the same tool (S-6)", async () => {
		const v1 = await firstRound();
		const fake = createSdkSeatFake([
			{ kind: "verification", attempts: TWO_TRIES },
		]);
		const check = await verifyThroughChannel(
			{
				priorRunId: path.basename(v1.recordPath),
				headRevision: commits[2] as string,
				keptFindingIds: [],
				final: true,
			},
			fake,
		);
		expect(fake.runs[0]?.input.spec.undoableIds).toEqual(["F-1"]);
		expect(fake.runs[0]?.refusals).toHaveLength(1);
		expect(fake.runs[0]?.refusals[0]).toMatch(
			/^regressions\[0\]\.undoes must be one of/u,
		);
		expect(undoesOf(check)).toEqual(["F-1"]);
		expect(check.final).toBe(true);
	});

	it("a replay of the recorded seat keeps the guard", async () => {
		const v1 = await firstRound();
		const seats: Array<SeatRunResult<VerificationProfile>> = [];
		await verifyThroughChannel(
			{
				priorRunId: path.basename(v1.recordPath),
				headRevision: commits[3] as string,
				keptFindingIds: [],
			},
			createSdkSeatFake([{ kind: "verification" }]),
			seats,
		);
		const recorded = seats[0]?.replay;
		expect(recorded?.undoableIds).toEqual(["F-1"]);
		const fake = createSdkSeatFake([
			{ kind: "verification", attempts: TWO_TRIES },
		]);
		const replayed = await replaySeat(
			recorded as NonNullable<typeof recorded>,
			(spec) => runSeatForReplay(spec, { sessionFactory: fake.factory }),
		);
		expect(fake.runs[0]?.refusals).toHaveLength(1);
		expect(replayed.outcome.kind).toBe("verification");
		const result =
			replayed.outcome.kind === "verification"
				? replayed.outcome.result
				: undefined;
		expect(result?.regressions.map((row) => row.undoes)).toEqual(["F-1"]);
	});
});
