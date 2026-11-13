/**
 * The real device-id handoff: an account login asks for the installation's
 * device id, and `realAuthSdk.deviceId` must answer from the selected agent
 * folder's `settings.json`, through the bundled Pi SDK. The login runtime is a
 * fake, so nothing signs in. HOME and PI_CODING_AGENT_DIR point at decoy
 * folders, so even a broken handoff cannot reach the owner's Pi folder.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type AuthSdk,
	type AuthTerminal,
	type LoginRuntime,
	login,
} from "../src/auth.js";
import { realAuthSdk } from "../src/sdk.js";

const saved = {
	HOME: process.env.HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let root: string;
let decoyAgentDir: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-device-")));
	decoyAgentDir = path.join(root, "decoy-agent");
	process.env.HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = decoyAgentDir;
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

/** A login runtime whose account login only records the device id it gets. */
function deviceRecordingRuntime(seen: string[]): LoginRuntime {
	return {
		getProviders: () => [
			{ id: "openai-codex", name: "ChatGPT", auth: { oauth: {} } },
		],
		login: async (_provider, _type, _interaction, options) => {
			seen.push(options?.getDeviceId?.() ?? "(no getDeviceId)");
		},
		logout: async () => {},
		listCredentials: async () => [],
		settleCredentialWrites: async () => {},
	};
}

/** The real SDK loads (as `createRuntime` does), then the fake logs in. */
function sdkWithRealDeviceId(seen: string[]): AuthSdk {
	return {
		...realAuthSdk,
		createRuntime: async (agentDir) => {
			await realAuthSdk.createRuntime(agentDir);
			return deviceRecordingRuntime(seen);
		},
	};
}

const terminal: AuthTerminal = {
	interactive: true,
	write: () => {},
	question: async () => "",
	secret: async () => "",
	readStdin: async () => "",
};

function folders(name: string) {
	const agentDir = path.join(root, name, "agent");
	const cwd = path.join(root, name, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { agentDir, cwd, settings: path.join(agentDir, "settings.json") };
}

async function loginOnce(agentDir: string, cwd: string, seen: string[]) {
	await login({
		provider: "openai-codex",
		apiKey: false,
		agentDir,
		cwd,
		sdk: sdkWithRealDeviceId(seen),
		terminal,
		signal: new AbortController().signal,
	});
}

describe("the device id an account login gets", () => {
	it("is the one stored in the selected agent folder's settings.json", async () => {
		const { agentDir, cwd, settings } = folders("stored");
		const stored = JSON.stringify({ deviceId: "device-from-agent-folder" });
		writeFileSync(settings, stored);
		const seen: string[] = [];

		await loginOnce(agentDir, cwd, seen);
		await loginOnce(agentDir, cwd, seen);

		expect(seen).toEqual([
			"device-from-agent-folder",
			"device-from-agent-folder",
		]);
		expect(readFileSync(settings, "utf8")).toBe(stored);
		expect(existsSync(decoyAgentDir)).toBe(false);
		expect(existsSync(path.join(cwd, ".pi"))).toBe(false);
	});

	it("is created once in the selected agent folder, then reused", async () => {
		const { agentDir, cwd, settings } = folders("fresh");
		const seen: string[] = [];

		await loginOnce(agentDir, cwd, seen);
		await loginOnce(agentDir, cwd, seen);

		expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(seen[1]).toBe(seen[0]);
		expect(JSON.parse(readFileSync(settings, "utf8")).deviceId).toBe(seen[0]);
		expect(existsSync(decoyAgentDir)).toBe(false);
		expect(existsSync(path.join(cwd, ".pi"))).toBe(false);
	});
});
