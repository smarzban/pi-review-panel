/**
 * The setup SDK against the real bundled Pi SDK: provider logins, the model
 * catalog, and extension packages installed by Pi's own package manager. HOME
 * and PI_CODING_AGENT_DIR point at temporary folders, the extension sources are
 * a local folder and a local Git repository (a `git:` URL rewritten to it), and
 * npm runs offline, so nothing reaches the owner's folders or the network.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { providerRows, realSetupSdk } from "../../src/cli/sdk.js";
import {
	resolveSeatRuntime,
	type SeatServicesSdk,
} from "../../src/seat/seat-runtime.js";
import {
	FIXTURE_GIT_SOURCE,
	gitSourceEnv,
	writeExtensionPackage,
} from "../fixtures/extension-package.js";

const ENV_NAMES = [
	"HOME",
	"PI_CODING_AGENT_DIR",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_KEY_0",
	"GIT_CONFIG_VALUE_0",
	"npm_config_offline",
	"npm_config_audit",
	"npm_config_fund",
	"npm_config_update_notifier",
	"GIT_TERMINAL_PROMPT",
	"PATH",
];
const saved = Object.fromEntries(
	ENV_NAMES.map((name) => [name, process.env[name]]),
);

let root = "";
let agentDir = "";
/** A folder outside this checkout holding the extension package. */
let localPackage = "";
let gitRepo = "";
/** A hostile working folder: Pi project settings and an auto-discovered extension. */
let hostileCwd = "";

beforeAll(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-setup-sdk-")));
	process.env.HOME = path.join(root, "home");
	mkdirSync(process.env.HOME, { recursive: true });
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_OAUTH_TOKEN;
	localPackage = path.join(root, "local-ext");
	writeExtensionPackage(localPackage);
	gitRepo = path.join(root, "git-ext");
	writeExtensionPackage(gitRepo, { git: true });
	Object.assign(process.env, gitSourceEnv(gitRepo));

	hostileCwd = path.join(root, "hostile");
	mkdirSync(path.join(hostileCwd, ".pi", "extensions"), { recursive: true });
	writeExtensionPackage(path.join(hostileCwd, "evil"));
	writeFileSync(
		path.join(hostileCwd, ".pi", "settings.json"),
		JSON.stringify({ packages: ["../evil"] }),
	);
	writeFileSync(
		path.join(hostileCwd, ".pi", "extensions", "x.ts"),
		"export default function () { throw new Error('the hostile extension ran'); }",
	);
});

beforeEach(() => {
	agentDir = path.join(
		root,
		`agent-${Math.random().toString(36).slice(2, 10)}`,
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	rmSync(root, { recursive: true, force: true });
});

const progress = () => {};

describe("providers", () => {
	it("lists each provider's login kinds and whether it is logged in", async () => {
		const before = await realSetupSdk.providers(agentDir);
		const anthropic = before.find((row) => row.id === "anthropic");
		expect(anthropic).toEqual({
			id: "anthropic",
			name: "Anthropic",
			logins: ["account", "api-key"],
			loggedIn: false,
		});
		expect(before.find((row) => row.id === "openai-codex")?.logins).toEqual([
			"account",
		]);
		expect(before.find((row) => row.id === "baseten")?.logins).toEqual([
			"api-key",
		]);

		writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "not-a-key" } }),
		);
		const after = await realSetupSdk.providers(agentDir);
		expect(after.find((row) => row.id === "anthropic")).toMatchObject({
			loggedIn: true,
			how: "stored credential",
		});
	});
});

describe("models", () => {
	it("lists the catalog offline, with availability from the logins", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "not-a-key" } }),
		);
		const base = await realSetupSdk.models({
			agentDir,
			cwd: hostileCwd,
			extensionPaths: [],
		});
		expect(base.registeredProviders).toEqual([]);
		expect(base.extensionFailures).toEqual([]);
		const anthropic = base.models.filter((row) => row.provider === "anthropic");
		expect(anthropic.length).toBeGreaterThan(0);
		expect(anthropic.every((row) => row.available)).toBe(true);
		expect(anthropic[0]).toMatchObject({
			contextWindow: expect.any(Number),
			maxTokens: expect.any(Number),
			thinking: expect.any(Boolean),
			images: expect.any(Boolean),
		});
		const codex = base.models.filter((row) => row.provider === "openai-codex");
		expect(codex.length).toBeGreaterThan(0);
		expect(codex.some((row) => row.available)).toBe(false);
	});
});

describe("extension packages through Pi's package manager", () => {
	it("installs a local folder, lists its .ts entry, and its provider's models load from it", async () => {
		mkdirSync(agentDir, { recursive: true });
		// Pi keeps the device id and other settings here; install must keep them.
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ deviceId: "keep-me", theme: "dark" }),
		);
		const installed = await realSetupSdk.installExtension({
			agentDir,
			source: localPackage,
			progress,
		});
		const entry = path.join(localPackage, "extensions", "index.ts");
		expect(installed.entries).toEqual([entry]);
		expect(installed.installedPath).toBe(localPackage);
		const settings = JSON.parse(
			readFileSync(path.join(agentDir, "settings.json"), "utf8"),
		);
		expect(settings).toMatchObject({ deviceId: "keep-me", theme: "dark" });
		expect(settings.packages).toEqual([path.relative(agentDir, localPackage)]);

		const listed = await realSetupSdk.listExtensions({ agentDir });
		expect(listed).toEqual([
			{
				source: path.relative(agentDir, localPackage),
				installedPath: localPackage,
				filtered: false,
				entries: [entry],
			},
		]);

		const group = await realSetupSdk.models({
			agentDir,
			cwd: hostileCwd,
			extensionPaths: [entry],
		});
		expect(group.extensionFailures).toEqual([]);
		expect(group.registeredProviders).toContain("review-panel-fixture");
		expect(
			group.models.find((row) => row.provider === "review-panel-fixture"),
		).toMatchObject({ model: "fixture-model", available: true });
		expect(
			group.models.find(
				(row) => row.provider === "review-panel-fixture-unauthed",
			),
		).toMatchObject({ model: "fixture-model", available: false });

		// The source exactly as list printed it removes it again.
		expect(
			await realSetupSdk.removeExtension({
				agentDir,
				source: listed[0]?.source ?? "",
				progress,
			}),
		).toBe(true);
		expect(await realSetupSdk.listExtensions({ agentDir })).toEqual([]);
		expect(existsSync(localPackage)).toBe(true);
	});

	it("clones a git: source into <agentDir>/git/<host>/<path>, where a seat loads its .ts entry with the bundled SDK", async () => {
		const installed = await realSetupSdk.installExtension({
			agentDir,
			source: FIXTURE_GIT_SOURCE,
			progress,
		});
		const clone = path.join(
			agentDir,
			"git",
			"example.invalid",
			"fixture",
			"pi-ext",
		);
		expect(installed.installedPath).toBe(clone);
		expect(installed.entries).toEqual([
			path.join(clone, "extensions", "index.ts"),
		]);

		const sdk = (await import(
			"@earendil-works/pi-coding-agent"
		)) as unknown as SeatServicesSdk;
		const seat = await resolveSeatRuntime({
			sdk,
			cwd: hostileCwd,
			agentDir,
			provider: "review-panel-fixture",
			model: "fixture-model",
			extensionPaths: installed.entries,
		});
		expect(seat.extensionFailures).toEqual([]);
		expect(seat.model).toBeDefined();
		expect(seat.authenticated).toBe(true);

		expect(
			await realSetupSdk.removeExtension({
				agentDir,
				source: FIXTURE_GIT_SOURCE,
				progress,
			}),
		).toBe(true);
		expect(existsSync(clone)).toBe(false);
	});

	// extension list takes no working folder at all; the built-bin test runs it
	// from a hostile folder.
	it("models never loads the working folder's Pi project settings or extensions", async () => {
		const base = await realSetupSdk.models({
			agentDir,
			cwd: hostileCwd,
			extensionPaths: [],
		});
		expect(base.extensionFailures).toEqual([]);
		expect(base.registeredProviders).toEqual([]);
	});

	it("remove of a source that is not installed answers false", async () => {
		expect(
			await realSetupSdk.removeExtension({
				agentDir,
				source: "npm:not-installed-here",
				progress,
			}),
		).toBe(false);
	});
});

describe("offline: no request lists models or checks a login (F-8)", () => {
	it("auth providers and models make no network request", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "not-a-key" } }),
		);
		const requests: string[] = [];
		const fetchSentinel = vi.fn(async (input: unknown) => {
			requests.push(String(input instanceof Request ? input.url : input));
			throw new Error("the setup commands must not reach the network");
		});
		vi.stubGlobal("fetch", fetchSentinel);
		try {
			await realSetupSdk.providers(agentDir);
			const listed = await realSetupSdk.models({
				agentDir,
				cwd: hostileCwd,
				extensionPaths: [],
			});
			expect(listed.models.length).toBeGreaterThan(0);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(requests).toEqual([]);
	});
});

describe("git never prompts for a password (R-4)", () => {
	it("install runs git with GIT_TERMINAL_PROMPT=0", async () => {
		const bin = path.join(root, "git-recorder");
		mkdirSync(bin, { recursive: true });
		const record = path.join(root, "git-prompt.txt");
		const realGit = execFileSync("sh", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT" >> "${record}"\nexec "${realGit}" "$@"\n`,
			{ mode: 0o755 },
		);
		delete process.env.GIT_TERMINAL_PROMPT;
		process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
		try {
			await realSetupSdk.installExtension({
				agentDir,
				source: FIXTURE_GIT_SOURCE,
				progress,
			});
		} finally {
			process.env.PATH = saved.PATH;
		}
		const lines = readFileSync(record, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(0);
		expect(new Set(lines)).toEqual(new Set(["prompt=0"]));
	});
});

describe("one provider's failing check does not hide the others (R-5)", () => {
	function fakeRuntime() {
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				auth: { oauth: {}, apiKey: { login: () => {} } },
			},
			{ id: "broken", name: "Broken", auth: { apiKey: { login: () => {} } } },
			{ id: "env", name: "Env", auth: { apiKey: { login: () => {} } } },
			{ id: "none", name: "None", auth: { apiKey: { login: () => {} } } },
		];
		return {
			getProviders: () => providers,
			listCredentials: async () => [
				{ providerId: "anthropic", type: "api_key" },
			],
			// The whole availability pass fails when any one check throws.
			getAvailable: async () => {
				throw new Error("API key auth check failed for provider broken");
			},
			getProviderAuthStatus: () => ({ configured: false }),
			checkAuth: async (id: string) => {
				if (id === "broken") {
					throw new Error("API key auth check failed for provider broken");
				}
				return id === "env"
					? { type: "api_key", source: "ENV_API_KEY" }
					: undefined;
			},
		};
	}

	it("checks each provider on its own and marks only the failing one", async () => {
		const rows = await providerRows(
			fakeRuntime() as unknown as Parameters<typeof providerRows>[0],
		);
		expect(rows).toEqual([
			{
				id: "anthropic",
				name: "Anthropic",
				logins: ["account", "api-key"],
				loggedIn: true,
				how: "stored credential",
			},
			{
				id: "broken",
				name: "Broken",
				logins: ["api-key"],
				loggedIn: false,
				checkError: "API key auth check failed for provider broken",
			},
			{
				id: "env",
				name: "Env",
				logins: ["api-key"],
				loggedIn: true,
				how: "ENV_API_KEY",
			},
			{ id: "none", name: "None", logins: ["api-key"], loggedIn: false },
		]);
	});
});
