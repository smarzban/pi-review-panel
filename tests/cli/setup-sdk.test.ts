/**
 * The setup SDK against the real bundled Pi SDK: provider logins, the model
 * catalog, and extension packages installed by Pi's own package manager. HOME
 * and PI_CODING_AGENT_DIR point at temporary folders, the extension sources are
 * a local folder and a local Git repository (a `git:` URL rewritten to it), and
 * npm runs offline, so nothing reaches the owner's folders or the network.
 */
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { realSetupSdk } from "../../src/cli/sdk.js";
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

	it("never lists or loads the working folder's Pi project settings or extensions", async () => {
		const listed = await realSetupSdk.listExtensions({ agentDir });
		expect(listed).toEqual([]);
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
