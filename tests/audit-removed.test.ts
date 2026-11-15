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
import { describe, expect, it, vi } from "vitest";

import {
	type ActionDependencies,
	commentAction,
	resumeAction,
	verifyAction,
} from "../src/actions/actions.js";
import {
	CallArgumentError,
	callAction,
	realActions,
} from "../src/actions/call.js";
import type { AuthSdk } from "../src/cli/auth.js";
import { EXIT_USAGE, type RunDeps, type RunIo, run } from "../src/cli/run.js";
import { loadResumable } from "../src/run/resume.js";
import {
	signPlan,
	signReviewRecord,
	TEST_RECORD_KEY,
} from "./fixtures/record-key.js";

/**
 * The repository audit was removed (T504). Asking for it gets a message that
 * says so, never a generic "unknown", and an audit record left in a
 * repository is refused by resume, verify and comment before any seat runs or
 * anything posts.
 */

const REMOVED = /audit was removed from review-panel/;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function withRepo(test: (repo: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "audit-removed-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "audit-removed@example.test"]);
	git(repo, ["config", "user.name", "Audit Removed Test"]);
	writeFileSync(path.join(repo, "a.txt"), "a\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "a", "--quiet"]);
	try {
		await test(realpathSync(repo));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A run id as an audit made one: its base ref was the literal `audit`. */
const AUDIT_RUN_ID = "2026-10-01T00-00-00-000Z-audit-0123456789abcdef";

/**
 * An interrupted audit record as an older review-panel wrote it: a signed
 * `kind: "audit"` plan with base and head both the snapshot commit, and no
 * seat settled yet.
 */
function interruptedAuditRecord(
	repo: string,
	lenses: string[] = ["code-health", "security"],
): string {
	const head = git(repo, ["rev-parse", "HEAD"]);
	const recordPath = path.join(repo, ".review-panel", "runs", AUDIT_RUN_ID);
	mkdirSync(recordPath, { recursive: true });
	const seats = lenses.map((lens, index) => ({
		rosterId: `seat-${index}`,
		lens,
		provider: "openai-codex",
		model: `gpt-5.6-${index}`,
	}));
	writeFileSync(
		path.join(recordPath, "panel.json"),
		`${JSON.stringify({ runId: AUDIT_RUN_ID, baseRef: "audit", seats }, null, 2)}\n`,
	);
	writeFileSync(
		path.join(recordPath, "plan.json"),
		`${JSON.stringify(
			{
				version: 1,
				kind: "audit",
				runId: AUDIT_RUN_ID,
				baseRef: "audit",
				baseOid: head,
				headOid: head,
				seats,
			},
			null,
			2,
		)}\n`,
	);
	signPlan(recordPath);
	return recordPath;
}

/** A complete audit record, signed in full as a review record would be. */
function completeAuditRecord(repo: string): void {
	const head = git(repo, ["rev-parse", "HEAD"]);
	const recordPath = interruptedAuditRecord(repo);
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId: AUDIT_RUN_ID,
			baseRef: "audit",
			baseOid: head,
			headOid: head,
		}),
	);
	writeFileSync(path.join(recordPath, "findings.json"), "[]");
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	signReviewRecord(recordPath);
}

function deps(overrides: ActionDependencies = {}): ActionDependencies {
	return {
		env: {},
		home: "/tmp/audit-removed-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => ({
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			],
			defaults: { seats: ["terra"] },
		}),
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh: () => "[]",
		...overrides,
	};
}

function cli() {
	let stdout = "";
	let stderr = "";
	const actions = Object.fromEntries(
		Object.keys(realActions).map((name) => [
			name,
			vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] })),
		]),
	) as unknown as RunDeps["actions"];
	const io: RunIo = {
		cwd: "/nonexistent-repo",
		env: {},
		home: "/nonexistent-home",
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		readStdin: async () => "",
		readFile: () => {
			throw new Error("ENOENT");
		},
		signal: new AbortController().signal,
		terminal: {
			interactive: false,
			write: () => {},
			question: async () => "",
			secret: async () => "",
			readStdin: async () => "",
		},
	};
	const runDeps: RunDeps = {
		agentDir: { dir: "/agent", source: "pi" },
		cliVersion: "9.9.9",
		sdkVersion: async () => "1.5.2",
		actions,
		authSdk: {} as AuthSdk,
		skillSource: {
			dir: "/nonexistent-skill",
			version: "9.9.9",
			platform: "darwin",
		},
	};
	return {
		run: (argv: string[]) => run(argv, io, runDeps),
		actions: actions as unknown as Record<string, ReturnType<typeof vi.fn>>,
		out: () => stdout,
		err: () => stderr,
	};
}

describe("the audit command was removed", () => {
	it.each([
		[["audit"]],
		[["audit", "--passes", "security", "--seats", "sol"]],
		[["audit", "--help"]],
		[["call", '{"action":"audit"}']],
		[["call", '{"action":"audit","seats":"sol"}']],
	])(
		"review-panel %j says audit was removed and exits non-zero",
		async (argv) => {
			const h = cli();
			expect(await h.run(argv)).toBe(EXIT_USAGE);
			expect(h.err()).toMatch(REMOVED);
			expect(h.err()).not.toMatch(/unknown/);
			expect(h.out()).toBe("");
			for (const action of Object.values(h.actions)) {
				expect(action).not.toHaveBeenCalled();
			}
		},
	);

	it("callAction refuses action audit with the same message", async () => {
		const actions = Object.fromEntries(
			Object.keys(realActions).map((name) => [name, vi.fn()]),
		) as unknown as typeof realActions;
		const call = callAction(
			{ action: "audit" },
			{
				cwd: "/nonexistent-repo",
				repoDir: "/nonexistent-repo",
				context: {},
				actions,
			},
		);
		await expect(call).rejects.toBeInstanceOf(CallArgumentError);
		await expect(call).rejects.toThrow(REMOVED);
	});

	it("is no action any more", () => {
		expect(Object.keys(realActions)).not.toContain("audit");
	});
});

describe("an audit record left in a repository", () => {
	it("is refused by loadResumable as no longer resumable", async () => {
		await withRepo(async (repo) => {
			interruptedAuditRecord(repo);
			expect(() => loadResumable(repo, AUDIT_RUN_ID, TEST_RECORD_KEY)).toThrow(
				`Resume refused: run "${AUDIT_RUN_ID}" is an audit record; audit records can no longer be resumed, because audit was removed from review-panel.`,
			);
		});
	});

	it("is refused as an audit record, not by a review panel's seat caps", async () => {
		await withRepo(async (repo) => {
			// An audit ran one pass on up to three seats; a review lens on at most two.
			interruptedAuditRecord(repo, ["security", "security", "security"]);
			expect(() => loadResumable(repo, AUDIT_RUN_ID, TEST_RECORD_KEY)).toThrow(
				/is an audit record; audit records can no longer be resumed/,
			);
		});
	});

	it("is refused by resume before any seat runs", async () => {
		await withRepo(async (repo) => {
			interruptedAuditRecord(repo);
			const resumeRun = vi.fn();
			await expect(
				resumeAction(
					{ repoDir: repo, priorRunId: AUDIT_RUN_ID },
					{ deps: deps({ resumeRun }) },
				),
			).rejects.toThrow(/audit records can no longer be resumed/);
			expect(resumeRun).not.toHaveBeenCalled();
		});
	});

	it("is refused by verify before any seat runs", async () => {
		await withRepo(async (repo) => {
			completeAuditRecord(repo);
			const runVerify = vi.fn();
			await expect(
				verifyAction(
					{
						repoDir: repo,
						priorRunId: AUDIT_RUN_ID,
						head: "HEAD",
						keptFindingIds: [],
					},
					{ deps: deps({ runVerify }) },
				),
			).rejects.toThrow(/plan\.json is not a review plan/);
			expect(runVerify).not.toHaveBeenCalled();
		});
	});

	it("is refused by comment before anything posts", async () => {
		await withRepo(async (repo) => {
			completeAuditRecord(repo);
			const postComment = vi.fn();
			await expect(
				commentAction(
					{
						repoDir: repo,
						ownerApproved: true,
						priorRunId: AUDIT_RUN_ID,
						dismissed: [],
						lowAdvisory: [],
					},
					{ deps: deps({ postComment }) },
				),
			).rejects.toThrow(/plan\.json is not a review plan/);
			expect(postComment).not.toHaveBeenCalled();
		});
	});
});
