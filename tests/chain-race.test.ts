import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import { runVerify } from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import * as chainModule from "../src/run/verify-chain.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * L-2: a verify reads the chain once before it claims, and again once it
 * holds the claim. Here verify A finishes, and gives its claim back, between
 * verify B's first read and B's claim: B's first read is served from before
 * A signed. The read after the claim refuses B, naming A, before any seat
 * runs. Without it, B would run its seats on a stale prior.
 */

const reads = vi.hoisted(() => ({
	stale: undefined as undefined | (() => unknown),
}));

vi.mock("../src/run/verify-chain.js", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../src/run/verify-chain.js")>();
	return {
		...real,
		loadChainPrior: (...args: Parameters<typeof real.loadChainPrior>) => {
			const stale = reads.stale;
			if (stale !== undefined) {
				reads.stale = undefined;
				return stale();
			}
			return real.loadChainPrior(...args);
		},
	};
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const REVIEW = "2026-11-15T10-00-00-000Z-review";

const FINDING: StampedFinding = {
	id: "F-1",
	seat: { provider: "p", model: "m", lens: "holistic" },
	finding: {
		file: "src/a.ts",
		line: 1,
		severity: "high",
		title: "F-1 title",
		evidence: "F-1 evidence",
	},
};

const config: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

let root: string;
let repo: string;
let commits: string[];
let seats: number;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "chain-race-"));
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
		JSON.stringify([FINDING]),
	);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
	seats = 0;
});

afterEach(() => {
	reads.stale = undefined;
	rmSync(root, { recursive: true, force: true });
});

function verifyAt(head: string) {
	return runVerify(
		{
			repoDir: repo,
			config,
			priorRunId: REVIEW,
			headRevision: head,
			keptFindingIds: ["F-1"],
		},
		{
			recordKey: TEST_RECORD_KEY,
			pinSnapshot: () => ({
				worktreePath: repo,
				release: () => ({ ok: true }),
			}),
			runAdvisorySeat: async () => {
				seats += 1;
				return {
					outcome: {
						kind: "verification",
						result: {
							items: [{ id: "F-1", disposition: "still present" }],
							regressions: [],
						},
					},
				} as never;
			},
		},
	);
}

describe("the chain is read again once the claim is held (L-2)", () => {
	it("a verify that finished between B's first read and B's claim refuses B, naming it, before any seat runs", async () => {
		// B's first read, taken before A ran.
		const before = chainModule.loadChainPrior(repo, REVIEW, TEST_RECORD_KEY);
		const a = await verifyAt(commits[2] as string);
		const aRunId = path.basename(a.recordPath);
		expect(seats).toBe(1);
		reads.stale = () => before;
		await expect(verifyAt(commits[3] as string)).rejects.toThrow(
			`Verify refused: review "${REVIEW}" has been verified already; verify against the latest verify, "${aRunId}"`,
		);
		expect(seats).toBe(1);
		expect(
			chainModule
				.loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)
				.map((row) => row.runId),
		).toEqual([aRunId]);
	});
});
