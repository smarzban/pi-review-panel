import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	COMPLETE_MARKER,
	PLAN_FILE,
	RUN_LOCK_FILE,
	SEATS_DIR,
} from "../src/run/record.js";
import { loadResumable, resumeRun } from "../src/run/resume.js";
import { runAudit } from "../src/run/run-audit.js";
import { runReview } from "../src/run/run-review.js";
import { runVerify } from "../src/run/run-verify.js";
import type { PlannedSeat } from "../src/run/types.js";
import type { SdkSessionFactory } from "../src/seat/run-seat.js";
import {
	createSdkSeatFake,
	type FakeResponse,
} from "./fixtures/sdk-seat-fake.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createHostRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "run-resume-host-"));
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "run@example.test"]);
	git(repo, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(repo, "committed.txt"), "committed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	writeFileSync(path.join(repo, "change.txt"), "change\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "change", "--quiet"]);
	return repo;
}

function threeSeats(): PlannedSeat[] {
	return ["correctness", "security", "tests"].map((lens, index) => ({
		rosterId: `roster-${index}`,
		provider: "openai-codex",
		model: `gpt-5.3-codex-${index}`,
		lens,
		lensPrompt: `Review this change through a ${lens} lens.`,
	}));
}

function worktreeCount(repo: string): number {
	return git(repo, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
}

function onlyRecord(repo: string): string {
	const runsDir = path.join(repo, ".review-panel", "runs");
	const ids = readdirSync(runsDir);
	expect(ids).toHaveLength(1);
	return path.join(runsDir, ids[0] as string);
}

/** A factory that counts sessions and records each seat's lens and snapshot head. */
function countingFactory(responses: FakeResponse[] = [{ kind: "default" }]): {
	factory: SdkSessionFactory;
	lenses: string[];
	heads: string[];
} {
	const fake = createSdkSeatFake(responses);
	const lenses: string[] = [];
	const heads: string[] = [];
	return {
		lenses,
		heads,
		factory: async (input) => {
			lenses.push(input.spec.lens);
			heads.push(git(input.spec.worktree, ["rev-parse", "HEAD"]).trim());
			return fake.factory(input);
		},
	};
}

/**
 * Starts a three-seat review whose first seat answers at once while the other
 * two hang, and aborts the run as soon as the first seat has settled.
 */
async function interruptedReview(repo: string): Promise<string> {
	const controller = new AbortController();
	const fake = createSdkSeatFake([
		{ kind: "default" },
		{ kind: "pending" },
		{ kind: "pending" },
	]);
	const pending = runReview(
		{ repoDir: repo, baseRef: "origin/main", seats: threeSeats() },
		{
			abortSignal: controller.signal,
			sessionFactory: fake.factory,
			onProgress: (event) => {
				if (
					event.kind === "seat-finished" &&
					event.seat.lens === "correctness"
				) {
					// The per-seat file is on disk before this event fires.
					const recordPath = onlyRecord(repo);
					expect(existsSync(path.join(recordPath, SEATS_DIR, "0.json"))).toBe(
						true,
					);
					controller.abort();
				}
			},
		},
	);
	await expect(pending).rejects.toThrow(/cancel/i);
	return onlyRecord(repo);
}

describe("durable seat outcomes", () => {
	it("writes a settled seat to the record before the run ends, and never an aborted one", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(false);
			const seatFiles = readdirSync(path.join(recordPath, SEATS_DIR)).sort();
			expect(seatFiles).toEqual(["0.json"]);
			const settled = JSON.parse(
				readFileSync(path.join(recordPath, SEATS_DIR, "0.json"), "utf8"),
			);
			expect(settled.index).toBe(0);
			expect(settled.facts.seat.lens).toBe("correctness");
			expect(settled.facts.outcome.kind).toBe("voted");
			const plan = JSON.parse(
				readFileSync(path.join(recordPath, PLAN_FILE), "utf8"),
			);
			expect(plan.kind).toBe("review");
			expect(plan.headOid).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
			expect(plan.baseOid).toBe(git(repo, ["rev-parse", "origin/main"]).trim());
			expect(plan.seats).toHaveLength(3);
			// The run lock is released when the run ends, even by cancellation.
			expect(existsSync(path.join(recordPath, RUN_LOCK_FILE))).toBe(false);
			expect(worktreeCount(repo)).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume", () => {
	it("re-runs only the unsettled seats at the record's head and reports every planned seat", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const recordedHead = git(repo, ["rev-parse", "HEAD"]).trim();
			// The host moves on; resume must still review the recorded head.
			writeFileSync(path.join(repo, "late.txt"), "late\n");
			git(repo, ["add", "."]);
			git(repo, ["commit", "-m", "late", "--quiet"]);

			const loaded = loadResumable(repo, path.basename(recordPath));
			expect(loaded.plan.kind).toBe("review");
			expect(loaded.missing.map((seat) => seat.lens)).toEqual([
				"security",
				"tests",
			]);
			const counter = countingFactory();
			const result = await resumeRun(loaded, {
				sessionFactory: counter.factory,
			});

			expect(counter.lenses.sort()).toEqual(["security", "tests"]);
			expect(counter.heads).toEqual([recordedHead, recordedHead]);
			expect(result.recordPath).toBe(recordPath);
			expect(result.outcomes.map((facts) => facts.seat.lens)).toEqual([
				"correctness",
				"security",
				"tests",
			]);
			expect(result.resumedSeats.map((seat) => seat.lens)).toEqual([
				"security",
				"tests",
			]);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
			const report = readFileSync(path.join(recordPath, "report.md"), "utf8");
			expect(report).toContain("3 planned seats: 3 voted, 0 failed.");
			expect(report).toContain("## Resumed run");
			expect(report).toContain(
				"- Re-run: openai-codex/gpt-5.3-codex-1 (security)",
			);
			expect(report).toContain(
				"- Kept from the interrupted run: openai-codex/gpt-5.3-codex-0 (correctness)",
			);
			expect(report).toContain(`HEAD OID: \`${recordedHead}\``);
			expect(report).not.toMatch(/verdict|approve/i);
			const findings = JSON.parse(
				readFileSync(path.join(recordPath, "findings.json"), "utf8"),
			);
			expect(findings.map((row: { id: string }) => row.id)).toEqual([
				"F-1",
				"F-2",
				"F-3",
			]);
			const meta = JSON.parse(
				readFileSync(path.join(recordPath, "meta.json"), "utf8"),
			);
			expect(meta.headOid).toBe(recordedHead);
			const execution = JSON.parse(
				readFileSync(path.join(recordPath, "execution.json"), "utf8"),
			);
			expect(execution.cancelled).toBe(false);
			expect(execution.resumedSeats).toEqual([
				"openai-codex/gpt-5.3-codex-1/security",
				"openai-codex/gpt-5.3-codex-2/tests",
			]);
			expect(worktreeCount(repo)).toBe(1);
			expect(existsSync(path.join(recordPath, RUN_LOCK_FILE))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reports a resumed seat that fails again as lost coverage", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const counter = countingFactory([
				{ kind: "failure", message: "provider down" },
			]);
			const result = await resumeRun(
				loadResumable(repo, path.basename(recordPath)),
				{ sessionFactory: counter.factory },
			);
			expect(result.outcomes.map((facts) => facts.outcome.kind)).toEqual([
				"voted",
				"failed",
				"failed",
			]);
			const execution = JSON.parse(
				readFileSync(path.join(recordPath, "execution.json"), "utf8"),
			);
			expect(execution.lostCoverage).toEqual([
				"openai-codex/gpt-5.3-codex-1/security",
				"openai-codex/gpt-5.3-codex-2/tests",
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("finalizes without scheduling when every seat settled before the interruption", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const counter = countingFactory();
			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				sessionFactory: counter.factory,
			});
			// Strip completion so the record looks like a run that died in render.
			rmSync(path.join(recordPath, COMPLETE_MARKER));
			const again = countingFactory();
			const loaded = loadResumable(repo, path.basename(recordPath));
			expect(loaded.missing).toEqual([]);
			const result = await resumeRun(loaded, { sessionFactory: again.factory });
			expect(again.lenses).toEqual([]);
			expect(result.outcomes).toHaveLength(3);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("treats a corrupt or mismatched seat file as unsettled", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			writeFileSync(path.join(recordPath, SEATS_DIR, "1.json"), "{not json");
			const zero = JSON.parse(
				readFileSync(path.join(recordPath, SEATS_DIR, "0.json"), "utf8"),
			);
			zero.facts.seat.model = "someone-else";
			writeFileSync(
				path.join(recordPath, SEATS_DIR, "0.json"),
				JSON.stringify(zero),
			);
			const loaded = loadResumable(repo, path.basename(recordPath));
			expect(loaded.missing.map((seat) => seat.lens)).toEqual([
				"correctness",
				"security",
				"tests",
			]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("resumes an interrupted audit record", async () => {
		const repo = createHostRepo();
		try {
			const controller = new AbortController();
			const fake = createSdkSeatFake([
				{ kind: "default" },
				{ kind: "pending" },
			]);
			const seats = threeSeats().slice(0, 2);
			await expect(
				runAudit(
					{ repoDir: repo, seats },
					{
						abortSignal: controller.signal,
						sessionFactory: fake.factory,
						onProgress: (event) => {
							if (event.kind === "seat-finished") {
								controller.abort();
							}
						},
					},
				),
			).rejects.toThrow(/cancel/i);
			const recordPath = onlyRecord(repo);
			const loaded = loadResumable(repo, recordPath);
			expect(loaded.plan.kind).toBe("audit");
			const counter = countingFactory();
			const result = await resumeRun(loaded, {
				sessionFactory: counter.factory,
			});
			expect(counter.lenses).toEqual(["security"]);
			expect(result.kind).toBe("audit");
			const report = readFileSync(path.join(recordPath, "report.md"), "utf8");
			expect(report).toContain("# Repository audit");
			expect(report).toContain("2 planned seats: 2 voted, 0 failed.");
			expect(report).toContain("## Resumed run");
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume refusals", () => {
	it("refuses an unknown run id", () => {
		const repo = createHostRepo();
		try {
			expect(() =>
				loadResumable(repo, "2026-01-01T00-00-00-000Z-nope"),
			).toThrow(
				/Resume refused: run "2026-01-01T00-00-00-000Z-nope" was not found/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a complete record", async () => {
		const repo = createHostRepo();
		try {
			const result = await runReview(
				{ repoDir: repo, baseRef: "origin/main", seats: threeSeats() },
				{ sessionFactory: createSdkSeatFake().factory },
			);
			expect(() => loadResumable(repo, result.recordPath)).toThrow(
				/Resume refused: run ".*" is already complete/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a record whose head commit cannot be resolved", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const planPath = path.join(recordPath, PLAN_FILE);
			const plan = JSON.parse(readFileSync(planPath, "utf8"));
			plan.headOid = "0123456789abcdef0123456789abcdef01234567";
			writeFileSync(planPath, JSON.stringify(plan));
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: head commit 0123456789abcdef0123456789abcdef01234567 of run ".*" cannot be resolved/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a record that has no resume plan", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rmSync(path.join(recordPath, PLAN_FILE));
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" has no resume plan/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a record whose run is still live", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			writeFileSync(
				path.join(recordPath, RUN_LOCK_FILE),
				`${JSON.stringify({ pid: process.pid })}\n`,
			);
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" is still in progress/,
			);
			// A lock left by a dead process does not block resume.
			const dead = spawnSync(process.execPath, ["-e", ""]).pid;
			writeFileSync(
				path.join(recordPath, RUN_LOCK_FILE),
				`${JSON.stringify({ pid: dead })}\n`,
			);
			expect(
				loadResumable(repo, path.basename(recordPath)).missing,
			).toHaveLength(2);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a verify record with the reason", async () => {
		const repo = createHostRepo();
		try {
			const review = await runReview(
				{ repoDir: repo, baseRef: "origin/main", seats: threeSeats() },
				{ sessionFactory: createSdkSeatFake().factory },
			);
			writeFileSync(path.join(repo, "fix.txt"), "fix\n");
			git(repo, ["add", "."]);
			git(repo, ["commit", "-m", "fix", "--quiet"]);
			const head = git(repo, ["rev-parse", "HEAD"]).trim();
			const verify = await runVerify(
				{
					repoDir: repo,
					config: {
						roster: [
							{ id: "sol", provider: "openai-codex", model: "gpt-5.3-codex" },
						],
						defaults: { seats: ["sol"] },
					} as never,
					priorRunId: path.basename(review.recordPath),
					headRevision: head,
					keptFindingIds: [],
				},
				{
					sessionFactory: createSdkSeatFake([{ kind: "verification" }]).factory,
				},
			);
			rmSync(path.join(verify.recordPath, COMPLETE_MARKER));
			expect(() => loadResumable(repo, verify.recordPath)).toThrow(
				/Resume refused: run ".*" is a verify run; start a new verify instead/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
