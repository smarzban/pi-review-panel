import { realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ActionContext } from "../../src/actions/actions.js";
import type { AuthSdk, AuthTerminal } from "../src/auth.js";
import {
	type ActionFunctions,
	EXIT_FAILED,
	EXIT_OK,
	EXIT_USAGE,
	type RunDeps,
	type RunIo,
	run,
} from "../src/run.js";

const REPO = realpathSync(path.resolve(import.meta.dirname, "..", ".."));

type Call = { input: Record<string, unknown>; context: ActionContext };

function harness(
	options: {
		stdin?: string;
		files?: Record<string, string>;
		result?: string;
		throws?: Error;
		cwd?: string;
	} = {},
) {
	const calls: Record<string, Call[]> = {};
	const make = (name: keyof ActionFunctions) =>
		vi.fn(async (input: Record<string, unknown>, context: ActionContext) => {
			calls[name] = [...(calls[name] ?? []), { input, context }];
			if (options.throws) {
				throw options.throws;
			}
			context.onProgress?.({
				phase: "review",
				event: "started",
				elapsedMs: 0,
				total: 1,
				completed: 0,
				active: 0,
				roster: "a",
			});
			return {
				content: [
					{ type: "text" as const, text: options.result ?? `${name} report` },
				],
			};
		});
	const actions = {
		diagnose: make("diagnose"),
		review: make("review"),
		audit: make("audit"),
		verify: make("verify"),
		resume: make("resume"),
		comment: make("comment"),
	} as unknown as ActionFunctions;
	let stdout = "";
	let stderr = "";
	const controller = new AbortController();
	const terminal: AuthTerminal = {
		interactive: false,
		write: () => {},
		question: async () => "",
		secret: async () => "",
		readStdin: async () => options.stdin ?? "",
	};
	const io: RunIo = {
		cwd: options.cwd ?? REPO,
		env: {},
		home: "/nonexistent-home",
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		readStdin: async () => options.stdin ?? "",
		readFile: (file) => {
			const text = options.files?.[file];
			if (text === undefined) {
				throw new Error("ENOENT");
			}
			return text;
		},
		signal: controller.signal,
		terminal,
	};
	const deps: RunDeps = {
		agentDir: { dir: "/agent", source: "pi" },
		cliVersion: "9.9.9",
		sdkVersion: async () => "1.5.2",
		actions,
		authSdk: {} as AuthSdk,
	};
	return {
		run: (argv: string[]) => run(argv, io, deps),
		calls,
		out: () => stdout,
		err: () => stderr,
		controller,
	};
}

describe("action commands map flags onto the tool's arguments", () => {
	it("review: --base, --head, --seats, --lenses, --scoping-note", async () => {
		const h = harness();
		const code = await h.run([
			"review",
			"--base",
			"main",
			"--head=HEAD",
			"--seats",
			"sol,opus",
			"--lenses",
			"tests",
			"--lenses",
			"security",
			"--scoping-note",
			"only the parser",
		]);
		expect(code).toBe(EXIT_OK);
		expect(h.calls.review?.[0]?.input).toEqual({
			repoDir: REPO,
			base: "main",
			head: "HEAD",
			seats: ["sol", "opus"],
			lenses: ["tests", "security"],
			scopingNote: "only the parser",
		});
		expect(h.out()).toBe("review report\n");
	});

	it("audit: --seats, --passes, --scoping-note", async () => {
		const h = harness();
		await h.run(["audit", "--passes", "security", "--seats", "sol"]);
		expect(h.calls.audit?.[0]?.input).toEqual({
			repoDir: REPO,
			seats: ["sol"],
			passes: ["security"],
		});
	});

	it("verify: --prior-run-id, --head, --kept-finding-ids (empty allowed)", async () => {
		const h = harness();
		await h.run([
			"verify",
			"--prior-run-id",
			"run-1",
			"--head",
			"HEAD",
			"--kept-finding-ids",
			"",
		]);
		expect(h.calls.verify?.[0]?.input).toEqual({
			repoDir: REPO,
			priorRunId: "run-1",
			head: "HEAD",
			keptFindingIds: [],
		});
	});

	it("resume: --prior-run-id", async () => {
		const h = harness();
		await h.run(["resume", "--prior-run-id", "run-2"]);
		expect(h.calls.resume?.[0]?.input).toEqual({
			repoDir: REPO,
			priorRunId: "run-2",
		});
	});

	it("comment: every flag, with --dismissed from a file", async () => {
		const file = path.join(REPO, "dismissed.json");
		const h = harness({
			files: { [file]: '[{"id":"F-2","reason":"by design"}]' },
		});
		const code = await h.run([
			"comment",
			"--prior-run-id",
			"run-3",
			"--owner-approved",
			"--pr",
			"22",
			"--verify-run-id",
			"run-4",
			"--head",
			"HEAD",
			"--low-advisory",
			"F-3,F-4",
			"--dismissed",
			"@dismissed.json",
		]);
		expect(code).toBe(EXIT_OK);
		expect(h.calls.comment?.[0]?.input).toEqual({
			repoDir: REPO,
			ownerApproved: true,
			priorRunId: "run-3",
			pr: 22,
			verifyRunId: "run-4",
			head: "HEAD",
			lowAdvisory: ["F-3", "F-4"],
			dismissed: [{ id: "F-2", reason: "by design" }],
		});
	});

	it("comment: --dismissed - reads stdin", async () => {
		const h = harness({ stdin: '[{"id":"F-1","reason":"dup"}]' });
		await h.run([
			"comment",
			"--prior-run-id",
			"r",
			"--owner-approved",
			"--dismissed",
			"-",
		]);
		expect(h.calls.comment?.[0]?.input.dismissed).toEqual([
			{ id: "F-1", reason: "dup" },
		]);
	});

	it("--repo resolves relative to the working folder and to its Git top-level", async () => {
		const h = harness({ cwd: path.join(REPO, "cli") });
		await h.run(["diagnose", "--repo", "src"]);
		expect(h.calls.diagnose?.[0]?.input).toEqual({ repoDir: REPO });
	});

	it("passes the abort signal and sends progress to stderr, not stdout", async () => {
		const h = harness();
		await h.run(["audit"]);
		expect(h.calls.audit?.[0]?.context.signal).toBe(h.controller.signal);
		expect(h.err()).toContain("review started");
		expect(h.out()).toBe("audit report\n");
	});
});

describe("call takes the tool's own object", () => {
	it("runs the same action with the same validation", async () => {
		const h = harness();
		const code = await h.run([
			"call",
			'{"action":"verify","priorRunId":"r","head":"HEAD","keptFindingIds":["F-1"]}',
		]);
		expect(code).toBe(EXIT_OK);
		expect(h.calls.verify?.[0]?.input).toEqual({
			repoDir: REPO,
			priorRunId: "r",
			head: "HEAD",
			keptFindingIds: ["F-1"],
		});
	});

	it("reads the object from stdin with -", async () => {
		const h = harness({ stdin: '{"action":"diagnose"}' });
		expect(await h.run(["call", "-"])).toBe(EXIT_OK);
		expect(h.calls.diagnose).toHaveLength(1);
	});

	it("honours repository in the object", async () => {
		const h = harness({ cwd: "/" });
		await h.run([
			"call",
			JSON.stringify({ action: "diagnose", repository: REPO }),
		]);
		expect(h.calls.diagnose?.[0]?.input).toEqual({ repoDir: REPO });
	});

	it("refuses --repo together with repository", async () => {
		const h = harness();
		expect(
			await h.run([
				"call",
				"--repo",
				".",
				JSON.stringify({ action: "diagnose", repository: REPO }),
			]),
		).toBe(EXIT_USAGE);
	});

	it("is a usage error for an unknown action or bad JSON", async () => {
		const h = harness();
		expect(await h.run(["call", '{"action":"merge"}'])).toBe(EXIT_USAGE);
		expect(await h.run(["call", "{nope"])).toBe(EXIT_USAGE);
		expect(await h.run(["call", "[]"])).toBe(EXIT_USAGE);
	});

	it("refuses comment without ownerApproved: true", async () => {
		const h = harness();
		expect(await h.run(["call", '{"action":"comment","priorRunId":"r"}'])).toBe(
			EXIT_FAILED,
		);
		expect(h.calls.comment).toBeUndefined();
	});
});

describe("exit codes never encode review content", () => {
	it("exits 0 whatever the report says", async () => {
		const h = harness({ result: "3 high findings. Status: needs setup" });
		expect(await h.run(["review", "--base", "a", "--head", "b"])).toBe(EXIT_OK);
	});

	it("refuses comment without --owner-approved with 1, before the action runs", async () => {
		const h = harness();
		expect(await h.run(["comment", "--prior-run-id", "r"])).toBe(EXIT_FAILED);
		expect(h.calls.comment).toBeUndefined();
		expect(h.err()).toContain("--owner-approved");
	});

	it("exits 1 when an action throws (a refusal or an operational failure)", async () => {
		const h = harness({
			throws: new Error(
				"Review refused: base and head resolve to the same commit",
			),
		});
		expect(await h.run(["review", "--base", "a", "--head", "a"])).toBe(
			EXIT_FAILED,
		);
		expect(h.err()).toContain("Review refused");
		expect(h.out()).toBe("");
	});

	it("exits 1 when --repo is not a Git repository, without falling back to the working folder", async () => {
		const h = harness();
		expect(await h.run(["diagnose", "--repo", "/"])).toBe(EXIT_FAILED);
		expect(await h.run(["diagnose", "--repo", "/tmp"])).toBe(EXIT_FAILED);
		expect(h.calls.diagnose).toBeUndefined();
	});

	it("exits 2 for a usage error, including the tool's own argument validation", async () => {
		const h = harness();
		expect(await h.run(["nonsense"])).toBe(EXIT_USAGE);
		expect(await h.run(["review", "--model", "x"])).toBe(EXIT_USAGE);
		expect(await h.run(["review", "--provider", "x"])).toBe(EXIT_USAGE);
		expect(await h.run(["review", "--head", "HEAD"])).toBe(EXIT_USAGE);
		expect(await h.run(["review", "--base", "a", "--base", "b"])).toBe(
			EXIT_USAGE,
		);
		expect(await h.run(["verify", "--prior-run-id", "r", "--head", "H"])).toBe(
			EXIT_USAGE,
		);
		expect(await h.run(["audit", "--seats", ""])).toBe(EXIT_USAGE);
		expect(await h.run(["diagnose", "extra"])).toBe(EXIT_USAGE);
		expect(
			await h.run([
				"comment",
				"--prior-run-id",
				"r",
				"--owner-approved",
				"--dismissed",
				"@missing.json",
			]),
		).toBe(EXIT_USAGE);
		expect(h.calls).toEqual({});
	});

	it("exits 1, not 0, when the run was aborted", async () => {
		const h = harness({ throws: new Error("aborted") });
		h.controller.abort();
		expect(await h.run(["audit"])).toBe(EXIT_FAILED);
		expect(h.err()).toContain("aborted");
	});
});

describe("output", () => {
	it("--json prints the result object", async () => {
		const h = harness();
		await h.run(["audit", "--json"]);
		expect(JSON.parse(h.out())).toEqual({
			content: [{ type: "text", text: "audit report" }],
		});
	});

	it("diagnose names the agent folder, the CLI version and the bundled SDK version", async () => {
		const h = harness();
		await h.run(["diagnose"]);
		expect(h.out()).toContain("review-panel 9.9.9 (Pi SDK 1.5.2)");
		expect(h.out()).toContain("Agent folder: /agent (your Pi agent folder)");
		expect(h.out()).toContain("diagnose report");
	});

	it("--help lists every command", async () => {
		const h = harness();
		expect(await h.run(["--help"])).toBe(EXIT_OK);
		for (const command of [
			"diagnose",
			"review",
			"audit",
			"verify",
			"resume",
			"comment",
			"call",
			"auth login",
			"auth logout",
			"auth status",
		]) {
			expect(h.out()).toContain(command);
		}
	});
});
