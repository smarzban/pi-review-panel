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
import type { ActionContext } from "../../src/actions/actions.js";
import * as actionsModule from "../../src/actions/actions.js";
import type { AuthSdk, AuthTerminal } from "../src/auth.js";
import {
	type ActionFunctions,
	EXIT_FAILED,
	EXIT_OK,
	EXIT_USAGE,
	type RunDeps,
	type RunIo,
	realActions,
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
		/** Replaces the default fake for one action. */
		action?: Partial<ActionFunctions>;
		deps?: Partial<RunDeps>;
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
		suggest: make("suggest"),
		...options.action,
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
		...options.deps,
	};
	return {
		run: (argv: string[]) => run(argv, io, deps),
		io,
		deps,
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

	it('coerces like the tool: a string list, JSON-text dismissed, ownerApproved "true"', async () => {
		const h = harness();
		expect(
			await h.run([
				"call",
				JSON.stringify({
					action: "comment",
					priorRunId: "r",
					ownerApproved: "true",
					lowAdvisory: "F-3",
					dismissed: '[{"id":"F-1","reason":"dup"}]',
				}),
			]),
		).toBe(EXIT_OK);
		expect(h.calls.comment?.[0]?.input).toMatchObject({
			ownerApproved: true,
			lowAdvisory: ["F-3"],
			dismissed: [{ id: "F-1", reason: "dup" }],
		});
		await h.run(["call", '{"action":"audit","seats":"sol"}']);
		expect(h.calls.audit?.[0]?.input).toMatchObject({ seats: ["sol"] });
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

	it("exits 1 when the action returned after Ctrl-C, still printing what it returned", async () => {
		const h = harness();
		h.controller.abort();
		expect(await h.run(["audit"])).toBe(EXIT_FAILED);
		expect(h.out()).toBe("audit report\n");
		expect(h.err()).toContain("interrupted");
	});

	it("exits 1, not 0, when the run was aborted", async () => {
		const h = harness({ throws: new Error("boom") });
		h.controller.abort();
		expect(await h.run(["audit"])).toBe(EXIT_FAILED);
		expect(h.err()).toBe("review-panel: aborted (boom)\n");
	});

	it("passes the abort signal to a running action, which stops, and exits 1", async () => {
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const h = harness({
			action: {
				review: (async (_input: unknown, context: ActionContext) => {
					started();
					await new Promise((resolve) => {
						context.signal?.addEventListener("abort", resolve);
					});
					throw context.signal?.reason;
				}) as unknown as ActionFunctions["review"],
			},
		});
		const code = h.run(["review", "--base", "main", "--head", "HEAD"]);
		await running;
		h.controller.abort(new Error("interrupted"));
		expect(await code).toBe(EXIT_FAILED);
		expect(h.err()).toBe("review-panel: aborted (interrupted)\n");
		expect(h.out()).toBe("");
	});

	it("reads stdin with the run's abort signal", async () => {
		const seen: AbortSignal[] = [];
		const h = harness();
		const io = {
			...h.io,
			readStdin: async (signal: AbortSignal) => {
				seen.push(signal);
				return '{"action":"diagnose"}';
			},
		};
		await run(["call", "-"], io, h.deps);
		expect(seen).toEqual([h.controller.signal]);
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
			"suggest",
			"call",
			"auth login",
			"auth logout",
			"auth status",
		]) {
			expect(h.out()).toContain(command);
		}
	});
});

describe("realActions", () => {
	it("maps each action to its own production function", () => {
		expect(Object.keys(realActions).sort()).toEqual([
			"audit",
			"comment",
			"diagnose",
			"resume",
			"review",
			"suggest",
			"verify",
		]);
		expect(realActions.diagnose).toBe(actionsModule.diagnoseAction);
		expect(realActions.review).toBe(actionsModule.reviewAction);
		expect(realActions.audit).toBe(actionsModule.auditAction);
		expect(realActions.verify).toBe(actionsModule.verifyAction);
		expect(realActions.resume).toBe(actionsModule.resumeAction);
		expect(realActions.comment).toBe(actionsModule.commentAction);
		expect(realActions.suggest).toBe(actionsModule.suggestAction);
	});
});

describe("auth status", () => {
	const roster = [
		{ id: "opus", provider: "anthropic", model: "claude-opus" },
		{
			id: "cc",
			provider: "claude-code",
			model: "opus",
			extraExtensionPaths: ["/ext.ts"],
		},
	];

	function statusHarness() {
		const loaded: unknown[] = [];
		const inspected: unknown[] = [];
		const h = harness({
			deps: {
				loadConfig: ((input: unknown) => {
					loaded.push(input);
					return { roster };
				}) as unknown as RunDeps["loadConfig"],
				authSdk: {
					createRuntime: async () => {
						throw new Error("unused");
					},
					deviceId: () => "",
					inspect: async (input) => {
						inspected.push(input);
						return input.provider === "anthropic"
							? {
									authenticated: true,
									check: { type: "api_key", source: "stored credential" },
									extensionFailures: [],
								}
							: { authenticated: false, extensionFailures: [] };
					},
				},
			},
		});
		return { h, loaded, inspected };
	}

	it("loads the owner config for the repository and prints each provider's login", async () => {
		const { h, loaded, inspected } = statusHarness();
		expect(await h.run(["auth", "status"])).toBe(EXIT_OK);
		expect(loaded).toEqual([
			{ env: {}, home: "/nonexistent-home", repoDir: REPO },
		]);
		expect(inspected).toEqual([
			{
				repoDir: REPO,
				agentDir: "/agent",
				provider: "anthropic",
				model: "claude-opus",
				extensionPaths: [],
			},
			{
				repoDir: REPO,
				agentDir: "/agent",
				provider: "claude-code",
				model: "opus",
				extensionPaths: ["/ext.ts"],
			},
		]);
		expect(h.out()).toBe(
			[
				"Agent folder: /agent",
				"anthropic [seats: opus]: logged in (api_key, stored credential)",
				"claude-code [seats: cc]: not logged in. Log in the way its extension documents",
				"",
			].join("\n"),
		);
	});

	it("--json prints the status object", async () => {
		const { h } = statusHarness();
		expect(await h.run(["auth", "status", "--json"])).toBe(EXIT_OK);
		const result = JSON.parse(h.out());
		expect(result.agentDir).toBe("/agent");
		expect(result.providers).toMatchObject([
			{ provider: "anthropic", seats: ["opus"], authenticated: true },
			{ provider: "claude-code", seats: ["cc"], authenticated: false },
		]);
	});
});

describe("usage errors never echo an argument that could be a key", () => {
	it.each(
		[
			["auth", "login", "-ksk-ant-abc123secret"],
			["auth", "login", "anthropic", "--sk-ant-api03-SECRET"],
			["auth", "sk-ant-abc123secret"],
			["sk-ant-abc123secret"],
			["call", "sk-ant-abc123secret"],
			["call", '{"key": sk-ant-abc123secret}'],
			["diagnose", "sk-ant-abc123secret"],
		].map((argv) => [argv.join(" "), argv] as const),
	)("%s", async (_name, argv) => {
		const h = harness();
		expect(await h.run(argv)).toBe(EXIT_USAGE);
		expect(h.err()).not.toContain("secret");
		expect(h.err()).not.toContain("SECRET");
	});

	it("still names a plain mistyped command or option", async () => {
		const h = harness();
		await h.run(["auth", "logn"]);
		await h.run(["review", "--modle", "x"]);
		expect(h.err()).toContain('auth: unknown command "logn"');
		expect(h.err()).toContain('review: unknown option "--modle"');
	});

	it.each([
		['{"action":"diagnose","sk-ant-api03-Abc9SECRET":1}', "diagnose"],
		[
			'{"action":"comment","ownerApproved":true,"priorRunId":"r","sk-ant-abc123secret":1}',
			"comment",
		],
	])(
		"call %s: an unknown argument name that could be a key",
		async (payload, action) => {
			const h = harness();
			expect(await h.run(["call", payload])).toBe(EXIT_USAGE);
			expect(h.err()).toContain(
				`${action} does not accept argument (not shown, in case it is a key)`,
			);
			expect(h.err()).not.toMatch(/secret/i);
			expect(h.calls).toEqual({});
		},
	);

	it("still names a plain unknown call argument", async () => {
		const h = harness();
		await h.run(["call", '{"action":"diagnose","modle":1}']);
		await h.run(["call", '{"action":"diagnose","priorRunId":"r"}']);
		expect(h.err()).toContain('diagnose does not accept argument "modle"');
		expect(h.err()).toContain('diagnose does not accept argument "priorRunId"');
	});
});

describe("suggest", () => {
	function git(cwd: string, args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf8" });
	}

	/** A repository whose last commit adds a source file that runs a subprocess. */
	function withRepository(test: (repo: string) => Promise<void>) {
		const root = mkdtempSync(path.join(tmpdir(), "cli-suggest-"));
		const repo = path.join(root, "repo");
		mkdirSync(path.join(repo, "src"), { recursive: true });
		git(repo, ["init", "-b", "main", "--quiet"]);
		git(repo, ["config", "user.email", "cli@example.test"]);
		git(repo, ["config", "user.name", "CLI Test"]);
		writeFileSync(path.join(repo, "base.txt"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base", "--quiet"]);
		writeFileSync(
			path.join(repo, "src", "run.ts"),
			'import { spawn } from "node:child_process";\n',
		);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "head", "--quiet"]);
		return test(realpathSync(repo)).finally(() =>
			rmSync(root, { recursive: true, force: true }),
		);
	}

	/** The real suggest action, with every runner and the record key refusing. */
	function realSuggest(): Partial<ActionFunctions> {
		const never = (name: string) => () => {
			throw new Error(`${name} must not be called by suggest`);
		};
		return {
			suggest: (input, context) =>
				actionsModule.suggestAction(input, {
					...context,
					deps: {
						env: {},
						home: "/nonexistent-home",
						loadConfig: () => ({
							roster: [{ id: "sol", provider: "openai", model: "gpt" }],
							defaults: { seats: ["sol"], lenses: ["tests"] },
						}),
						diagnose: never("diagnose") as never,
						runReview: never("runReview") as never,
						runAudit: never("runAudit") as never,
						runVerify: never("runVerify") as never,
						resumeRun: never("resumeRun") as never,
						postComment: never("postComment") as never,
						recordKey: never("recordKey") as never,
						checkRecordKey: never("checkRecordKey") as never,
					},
				}),
		};
	}

	it("maps --base and --head onto the tool's arguments", async () => {
		const h = harness();
		expect(await h.run(["suggest", "--base", "main", "--head", "HEAD"])).toBe(
			EXIT_OK,
		);
		expect(h.calls.suggest?.[0]?.input).toEqual({
			repoDir: REPO,
			base: "main",
			head: "HEAD",
		});
	});

	it("prints each lens with its reason and evidence, runs no seat, and exits 0", async () => {
		await withRepository(async (repo) => {
			const h = harness({ action: realSuggest() });
			const code = await h.run([
				"suggest",
				"--repo",
				repo,
				"--base",
				"main~1",
				"--head",
				"main",
			]);
			expect(h.err()).toBe("");
			expect(code).toBe(EXIT_OK);
			expect(h.out()).toBe(
				[
					"# Lens suggestions",
					"main~1...main · holistic always runs · owner default lenses: tests",
					"- security: added line(s) touch auth/crypto/subprocess/deserialization (src/run.ts:1)",
					"- tests (already on, owner default): code changed: check coverage, and that each added, edited, or deleted test can fail and is worth keeping (src/run.ts)",
					"",
					"No seat ran. Choose the lenses yourself, with a reason for each, and pass the extra ones to review as `lenses`.",
					"",
				].join("\n"),
			);
		});
	});

	it("refuses a bad ref with review's message and exits 1", async () => {
		await withRepository(async (repo) => {
			const h = harness({ action: realSuggest() });
			expect(
				await h.run([
					"suggest",
					"--repo",
					repo,
					"--base",
					"nope",
					"--head",
					"main",
				]),
			).toBe(EXIT_FAILED);
			expect(h.err()).toBe(
				"review-panel: failed: run refused: baseRef does not resolve to a commit: nope\n",
			);
			expect(h.out()).toBe("");
		});
	});

	it("refuses options and arguments suggest does not take", async () => {
		const h = harness();
		expect(
			await h.run(["suggest", "--base", "main", "--head", "HEAD", "--lenses", "x"]),
		).toBe(EXIT_USAGE);
		expect(h.err()).toContain('suggest: unknown option "--lenses"');
		expect(
			await h.run([
				"call",
				'{"action":"suggest","base":"main","head":"HEAD","seats":["a"]}',
			]),
		).toBe(EXIT_USAGE);
		expect(h.err()).toContain('suggest does not accept argument "seats"');
		expect(h.calls.suggest).toBeUndefined();
	});
});
