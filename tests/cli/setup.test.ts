/**
 * The no-Pi setup commands (`auth providers`, `models`, `extension ...`)
 * through `run()`, against a fake setup SDK. The real SDK is exercised in
 * `setup-sdk.test.ts` and from the built bin in `built.test.ts`.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AgentDirChoice } from "../../src/cli/agent-dir.js";
import type { AuthSdk, AuthTerminal } from "../../src/cli/auth.js";
import {
	EXIT_FAILED,
	EXIT_OK,
	EXIT_USAGE,
	type RunDeps,
	type RunIo,
	run,
} from "../../src/cli/run.js";
import type {
	InstalledExtension,
	ModelGroup,
	SetupSdk,
} from "../../src/cli/setup.js";

const HOME = "/home/user";
const PI_FOLDER: AgentDirChoice = {
	dir: path.join(HOME, ".pi", "agent"),
	source: "pi",
};
const OWN_FOLDER: AgentDirChoice = {
	dir: path.join(HOME, ".pi-review-panel", "agent"),
	source: "review-panel",
};

const CLAUDE_CODE_ENTRY =
	"/home/user/.pi-review-panel/agent/git/github.com/earendil-works/pi-claude-code/extensions/index.ts";

function model(
	provider: string,
	id: string,
	available: boolean,
	extra: Partial<ModelGroup["models"][number]> = {},
): ModelGroup["models"][number] {
	return {
		provider,
		model: id,
		name: id,
		contextWindow: 200_000,
		maxTokens: 32_000,
		thinking: true,
		images: false,
		available,
		...extra,
	};
}

const BASE: ModelGroup = {
	registeredProviders: [],
	extensionFailures: [],
	models: [
		model("anthropic", "claude-sonnet-5", true),
		model("anthropic", "claude-opus-5", true, {
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			images: true,
		}),
		model("openai-codex", "gpt-5.6-terra", false, { thinking: false }),
	],
};

/** An extension group: it registers claude-code and also re-lists a built-in. */
const CLAUDE_CODE: ModelGroup = {
	registeredProviders: ["claude-code"],
	extensionFailures: [],
	models: [
		model("claude-code", "opus", true),
		model("anthropic", "claude-opus-5", true),
	],
};

const INSTALLED: InstalledExtension[] = [
	{
		source: "git:github.com/earendil-works/pi-claude-code",
		installedPath:
			"/home/user/.pi-review-panel/agent/git/github.com/earendil-works/pi-claude-code",
		filtered: false,
		entries: [CLAUDE_CODE_ENTRY],
	},
];

function fakeSdk(overrides: Partial<SetupSdk> = {}) {
	const modelCalls: (readonly string[])[] = [];
	const installs: { source: string; agentDir: string }[] = [];
	const removals: string[] = [];
	const sdk: SetupSdk = {
		providers: async () => [
			{
				id: "anthropic",
				name: "Anthropic",
				logins: ["account", "api-key"],
				loggedIn: true,
				how: "stored credential",
			},
			{
				id: "openai-codex",
				name: "OpenAI Codex",
				logins: ["account"],
				loggedIn: false,
			},
			{ id: "baseten", name: "Baseten", logins: ["api-key"], loggedIn: false },
			{
				id: "ollama",
				name: "Ollama",
				logins: [],
				loggedIn: true,
				how: "models.json key",
			},
		],
		models: vi.fn(async (input) => {
			modelCalls.push(input.extensionPaths);
			if (input.extensionPaths.length === 0) {
				return BASE;
			}
			if (input.extensionPaths[0] === CLAUDE_CODE_ENTRY) {
				return CLAUDE_CODE;
			}
			return { registeredProviders: [], extensionFailures: [], models: [] };
		}),
		listExtensions: async () => INSTALLED,
		installExtension: vi.fn(async (input) => {
			installs.push({ source: input.source, agentDir: input.agentDir });
			input.progress(`Installing ${input.source}...`);
			return {
				source: input.source,
				installedPath: "/installed/at",
				filtered: false,
				entries: ["/installed/at/extensions/a.ts", "/installed/at/b.js"],
			};
		}),
		removeExtension: vi.fn(async (input) => {
			removals.push(input.source);
			return INSTALLED.some((entry) => entry.source === input.source);
		}),
		...overrides,
	};
	return { sdk, modelCalls, installs, removals };
}

function harness(
	options: {
		sdk?: SetupSdk;
		agentDir?: AgentDirChoice;
		cwd?: string;
		extensionTimeoutMs?: number;
	} = {},
) {
	let stdout = "";
	let stderr = "";
	const terminal: AuthTerminal = {
		interactive: false,
		write: () => {},
		question: async () => "",
		secret: async () => "",
		readStdin: async () => "",
	};
	const io: RunIo = {
		cwd: options.cwd ?? "/work",
		env: {},
		home: HOME,
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
		terminal,
	};
	const deps: RunDeps = {
		agentDir: options.agentDir ?? OWN_FOLDER,
		cliVersion: "9.9.9",
		sdkVersion: async () => "1.5.2",
		actions: {} as RunDeps["actions"],
		authSdk: {} as AuthSdk,
		setupSdk: options.sdk ?? fakeSdk().sdk,
		...(options.extensionTimeoutMs === undefined
			? {}
			: { extensionTimeoutMs: options.extensionTimeoutMs }),
		skillSource: { dir: "/skill", version: "9.9.9", platform: "darwin" },
	};
	return {
		run: (argv: string[]) => run(argv, io, deps),
		out: () => stdout,
		err: () => stderr,
	};
}

describe("auth providers", () => {
	it("lists every provider with its login kinds and whether it is logged in", async () => {
		const h = harness();
		expect(await h.run(["auth", "providers"])).toBe(EXIT_OK);
		const lines = h.out().split("\n");
		expect(lines[0]).toBe(
			`Agent folder: ${OWN_FOLDER.dir} (review-panel's own folder; no Pi login found in ~/.pi/agent)`,
		);
		const row = (id: string) =>
			lines.find((line) => line.startsWith(`${id} `)) ?? "";
		expect(row("anthropic")).toMatch(
			/^anthropic\s+Anthropic\s+account or API key\s+logged in \(stored credential\)$/,
		);
		expect(row("openai-codex")).toMatch(
			/^openai-codex\s+OpenAI Codex\s+account\s+not logged in$/,
		);
		expect(row("baseten")).toMatch(
			/^baseten\s+Baseten\s+API key\s+not logged in$/,
		);
		expect(row("ollama")).toMatch(
			/^ollama\s+Ollama\s+none\s+configured \(models\.json key\)$/,
		);
		expect(h.out()).toContain("review-panel auth login <provider>");
		expect(h.out()).toContain(
			"review-panel auth login <provider> --api-key < key-file",
		);
		// auth login loads no extension, so extension providers are pointed elsewhere.
		expect(h.out()).toContain("review-panel extension list");
	});

	it("--json prints the agent folder and the provider objects", async () => {
		const h = harness({ agentDir: PI_FOLDER });
		expect(await h.run(["auth", "providers", "--json"])).toBe(EXIT_OK);
		const result = JSON.parse(h.out());
		expect(result.agentDir).toBe(PI_FOLDER.dir);
		expect(result.providers[0]).toEqual({
			id: "anthropic",
			name: "Anthropic",
			logins: ["account", "api-key"],
			loggedIn: true,
			how: "stored credential",
		});
	});

	it("refuses arguments it does not take", async () => {
		const h = harness();
		expect(await h.run(["auth", "providers", "anthropic"])).toBe(EXIT_USAGE);
		expect(h.err()).toContain(
			'auth providers: unexpected argument "anthropic"',
		);
	});
});

describe("models", () => {
	it("lists the models available with the current logins, built-ins and installed extensions each loaded on their own", async () => {
		const { sdk, modelCalls } = fakeSdk();
		const h = harness({ sdk });
		expect(await h.run(["models"])).toBe(EXIT_OK);
		// The base runtime, then each installed package's entries in isolation.
		expect(modelCalls).toEqual([[], [CLAUDE_CODE_ENTRY]]);
		const lines = h.out().split("\n");
		const header = lines.findIndex((line) => line.startsWith("provider "));
		expect(lines[header]).toMatch(
			/^provider\s+model\s+context\s+max-out\s+thinking\s+images\s+extension$/,
		);
		const rows = lines.slice(header + 1, header + 4);
		expect(rows[0]).toMatch(
			/^anthropic\s+claude-opus-5\s+1M\s+128K\s+yes\s+yes\s*$/,
		);
		expect(rows[1]).toMatch(
			/^anthropic\s+claude-sonnet-5\s+200K\s+32K\s+yes\s+no\s*$/,
		);
		expect(rows[2]).toMatch(
			/^claude-code\s+opus\s+200K\s+32K\s+yes\s+no\s+git:github\.com\/earendil-works\/pi-claude-code$/,
		);
		// Not logged in: not listed without a provider or --all.
		expect(h.out()).not.toContain("gpt-5.6-terra");
		// A built-in an extension re-lists is not repeated as that extension's.
		expect(lines.filter((line) => line.startsWith("anthropic ")).length).toBe(
			2,
		);
	});

	it("prints a ready-to-copy roster row for the first model", async () => {
		const h = harness();
		await h.run(["models"]);
		const json = h
			.out()
			.split("\n")
			.find((line) => line.trim().startsWith('{"id"'));
		expect(JSON.parse(json ?? "")).toEqual({
			id: "claude-opus-5",
			provider: "anthropic",
			model: "claude-opus-5",
		});
	});

	it("the roster row for an extension's model names its extraExtensionPaths", async () => {
		const h = harness();
		expect(await h.run(["models", "claude-code"])).toBe(EXIT_OK);
		const json = h
			.out()
			.split("\n")
			.find((line) => line.trim().startsWith('{"id"'));
		expect(JSON.parse(json ?? "")).toEqual({
			id: "opus",
			provider: "claude-code",
			model: "opus",
			extraExtensionPaths: [CLAUDE_CODE_ENTRY],
		});
	});

	it("one provider lists all its models, and says when it is not logged in", async () => {
		const h = harness();
		expect(await h.run(["models", "openai-codex"])).toBe(EXIT_OK);
		expect(h.out()).toMatch(
			/^openai-codex\s+gpt-5\.6-terra\s+200K\s+32K\s+no\s+no/m,
		);
		expect(h.out()).not.toContain("claude-opus-5 ");
		expect(h.out()).toContain(
			"Not logged in to openai-codex. Run: review-panel auth login openai-codex",
		);
	});

	it("--all lists models without a login too; --search keeps rows matching every word", async () => {
		const all = harness();
		await all.run(["models", "--all"]);
		expect(all.out()).toContain("gpt-5.6-terra");

		const searched = harness();
		await searched.run(["models", "--all", "--search", "ANTHROPIC opus"]);
		expect(searched.out()).toContain("claude-opus-5");
		expect(searched.out()).not.toContain("claude-sonnet-5");
		expect(searched.out()).not.toContain("gpt-5.6-terra");
	});

	it("--extension loads a path, resolved from the working folder, as its own group", async () => {
		const { sdk, modelCalls } = fakeSdk({ listExtensions: async () => [] });
		const h = harness({ sdk, cwd: "/work" });
		await h.run(["models", "--extension", "ext/provider.ts"]);
		expect(modelCalls).toEqual([[], ["/work/ext/provider.ts"]]);
	});

	it("names an extension that failed to load, and a load that did not finish, and still lists the rest", async () => {
		const { sdk } = fakeSdk({
			listExtensions: async () => [
				...INSTALLED,
				{
					source: "../hangs",
					installedPath: "/hangs",
					filtered: false,
					entries: ["/hangs/index.ts"],
				},
				{
					source: "../broken",
					installedPath: "/broken",
					filtered: false,
					entries: ["/broken/index.ts"],
				},
			],
		});
		const models = sdk.models;
		sdk.models = async (input) => {
			if (input.extensionPaths[0] === "/hangs/index.ts") {
				return new Promise(() => {});
			}
			if (input.extensionPaths[0] === "/broken/index.ts") {
				return {
					registeredProviders: [],
					models: [],
					extensionFailures: [
						{ extension: "/broken/index.ts", message: "refuses to load" },
					],
				};
			}
			return models(input);
		};
		const h = harness({ sdk, extensionTimeoutMs: 50 });
		expect(await h.run(["models"])).toBe(EXIT_OK);
		expect(h.out()).toContain("claude-opus-5");
		expect(h.out()).toContain(
			"Extension /broken/index.ts failed to load: refuses to load",
		);
		expect(h.out()).toContain(
			"Extension ../hangs (/hangs/index.ts) did not finish loading within 0.05 s; its models are not listed",
		);
	});

	it("an unknown provider is refused without echoing a token that could be a key", async () => {
		const h = harness();
		expect(await h.run(["models", "sk-ant-abc123"])).toBe(EXIT_FAILED);
		expect(h.err()).not.toContain("sk-ant-abc123");
		expect(h.err()).toContain("review-panel auth providers");
	});

	it("says how to log in when nothing is available", async () => {
		const { sdk } = fakeSdk({
			listExtensions: async () => [],
			models: async () => ({
				registeredProviders: [],
				extensionFailures: [],
				models: [model("anthropic", "claude-opus-5", false)],
			}),
		});
		const h = harness({ sdk });
		expect(await h.run(["models"])).toBe(EXIT_OK);
		expect(h.out()).toContain(
			"No model is available with the logins in this agent folder.",
		);
		expect(h.out()).toContain("review-panel auth providers");
	});

	it("--json prints every listed row with its extension paths and the roster row", async () => {
		const h = harness();
		expect(await h.run(["models", "--json"])).toBe(EXIT_OK);
		const result = JSON.parse(h.out());
		expect(result.agentDir).toBe(OWN_FOLDER.dir);
		expect(result.models).toContainEqual({
			provider: "claude-code",
			model: "opus",
			name: "opus",
			contextWindow: 200_000,
			maxTokens: 32_000,
			thinking: true,
			images: false,
			available: true,
			extensionPaths: [CLAUDE_CODE_ENTRY],
			extensionSource: "git:github.com/earendil-works/pi-claude-code",
		});
		expect(result.rosterRow).toEqual({
			id: "claude-opus-5",
			provider: "anthropic",
			model: "claude-opus-5",
		});
		expect(result.problems).toEqual([]);
	});

	it("refuses a second positional", async () => {
		const h = harness();
		expect(await h.run(["models", "anthropic", "openai"])).toBe(EXIT_USAGE);
		expect(h.err()).toContain(
			'models takes at most one provider id; unexpected argument "openai"',
		);
	});
});

describe("extension install, list and remove", () => {
	it("install prints the entry paths for extraExtensionPaths as its last lines", async () => {
		const { sdk, installs } = fakeSdk();
		const h = harness({ sdk });
		expect(
			await h.run([
				"extension",
				"install",
				"git:github.com/earendil-works/pi-claude-code",
			]),
		).toBe(EXIT_OK);
		expect(installs).toEqual([
			{
				source: "git:github.com/earendil-works/pi-claude-code",
				agentDir: OWN_FOLDER.dir,
			},
		]);
		expect(h.err()).toContain(
			"Installing git:github.com/earendil-works/pi-claude-code...",
		);
		const lines = h.out().trimEnd().split("\n");
		expect(lines.slice(-2)).toEqual([
			"  /installed/at/extensions/a.ts",
			"  /installed/at/b.js",
		]);
		expect(h.out()).toContain(
			"Installed git:github.com/earendil-works/pi-claude-code at /installed/at",
		);
		// Installing does not give a seat the extension: the roster row does.
		expect(h.out()).toContain("extraExtensionPaths");
		expect(h.out()).not.toContain("Pi now loads");
	});

	it("in Pi's own agent folder, install says that Pi loads the package too", async () => {
		const h = harness({ agentDir: PI_FOLDER });
		expect(await h.run(["extension", "install", "npm:some-ext"])).toBe(EXIT_OK);
		expect(h.out()).toContain(
			`${PI_FOLDER.dir} is Pi's own agent folder: Pi now loads npm:some-ext in every Pi session too`,
		);
	});

	it("so does an agent folder named by PI_CODING_AGENT_DIR that is ~/.pi/agent", async () => {
		const h = harness({
			agentDir: { dir: PI_FOLDER.dir, source: "environment" },
		});
		await h.run(["extension", "install", "npm:some-ext"]);
		expect(h.out()).toContain("is Pi's own agent folder");
	});

	it("any other folder named by PI_CODING_AGENT_DIR is shared with a Pi started with that variable", async () => {
		const h = harness({ agentDir: { dir: "/custom", source: "environment" } });
		await h.run(["extension", "install", "npm:some-ext"]);
		expect(h.out()).not.toContain("is Pi's own agent folder");
		expect(h.out()).toContain(
			"A Pi started with the same PI_CODING_AGENT_DIR loads npm:some-ext too.",
		);
	});

	it("a local source is resolved from the working folder", async () => {
		const { sdk, installs } = fakeSdk();
		const h = harness({ sdk, cwd: "/work" });
		await h.run(["extension", "install", "./my-ext"]);
		expect(installs[0]?.source).toBe("/work/my-ext");
	});

	it("says so when the package holds no extension", async () => {
		const { sdk } = fakeSdk({
			installExtension: async (input) => ({
				source: input.source,
				installedPath: "/x",
				filtered: false,
				entries: [],
			}),
		});
		const h = harness({ sdk });
		expect(await h.run(["extension", "install", "npm:skills-only"])).toBe(
			EXIT_FAILED,
		);
		expect(h.err()).toContain("declares no extension");
	});

	it("list prints each source, where it is installed and its entry paths", async () => {
		const h = harness();
		expect(await h.run(["extension", "list"])).toBe(EXIT_OK);
		expect(h.out()).toBe(
			[
				`Agent folder: ${OWN_FOLDER.dir} (review-panel's own folder; no Pi login found in ~/.pi/agent)`,
				"git:github.com/earendil-works/pi-claude-code",
				`  installed at ${INSTALLED[0]?.installedPath}`,
				"  extraExtensionPaths entries:",
				`    ${CLAUDE_CODE_ENTRY}`,
				"",
			].join("\n"),
		);
	});

	it("list --json prints the installed packages", async () => {
		const h = harness();
		expect(await h.run(["extension", "list", "--json"])).toBe(EXIT_OK);
		expect(JSON.parse(h.out())).toEqual({
			agentDir: OWN_FOLDER.dir,
			extensions: INSTALLED,
		});
	});

	it("list says how to install when nothing is installed", async () => {
		const { sdk } = fakeSdk({ listExtensions: async () => [] });
		const h = harness({ sdk });
		await h.run(["extension", "list"]);
		expect(h.out()).toContain("No extension is installed in this agent folder");
	});

	it("remove takes the source exactly as list prints it, even a relative local one", async () => {
		const { sdk, removals } = fakeSdk({
			listExtensions: async () => [
				{
					source: "../ext",
					installedPath: "/home/user/.pi-review-panel/ext",
					filtered: false,
					entries: [],
				},
			],
			removeExtension: async (input) => {
				removals.push(input.source);
				return true;
			},
		});
		const h = harness({ sdk, cwd: "/work" });
		expect(await h.run(["extension", "remove", "../ext"])).toBe(EXIT_OK);
		expect(removals).toEqual(["../ext"]);
		expect(h.out()).toContain("Removed ../ext");
		expect(h.out()).toContain("extraExtensionPaths");
	});

	it("remove resolves any other local source from the working folder", async () => {
		const { sdk, removals } = fakeSdk({
			removeExtension: async (input) => {
				removals.push(input.source);
				return true;
			},
		});
		const h = harness({ sdk, cwd: "/work" });
		await h.run(["extension", "remove", "./my-ext"]);
		expect(removals).toEqual(["/work/my-ext"]);
	});

	it("remove of a source that is not installed exits 1", async () => {
		const h = harness();
		expect(await h.run(["extension", "remove", "npm:not-there"])).toBe(
			EXIT_FAILED,
		);
		expect(h.err()).toContain("review-panel extension list");
	});

	it("usage errors: no subcommand source, an unknown subcommand", async () => {
		const cases: [string[], string][] = [
			[["extension", "install"], "extension install takes one source"],
			[["extension", "remove"], "extension remove takes one source"],
			[
				["extension", "update"],
				'extension: unknown command "update"; use install, list or remove',
			],
			[["extension", "list", "x"], 'extension list: unexpected argument "x"'],
		];
		for (const [argv, text] of cases) {
			const h = harness();
			expect(await h.run(argv)).toBe(EXIT_USAGE);
			expect(h.err()).toContain(text);
		}
	});
});

describe("help", () => {
	it("lists the setup commands", async () => {
		const h = harness();
		await h.run(["--help"]);
		for (const command of [
			"auth providers",
			"models [<provider>]",
			"extension install <source>",
			"extension list",
			"extension remove <source>",
		]) {
			expect(h.out()).toContain(command);
		}
	});
});
