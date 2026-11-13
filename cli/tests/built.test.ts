/**
 * Runs the built bin (`npm run build` first) as a user would, with the real
 * bundled Pi SDK. Every spawn gets a scrubbed environment and a temporary HOME,
 * so no test can read or write the owner's real Pi or review-panel folders.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(import.meta.dirname, "..");
const REPO = realpathSync(path.resolve(CLI_DIR, ".."));
const BIN = path.join(CLI_DIR, "dist", "cli", "src", "main.js");
const SIGINT_READY = path.join(
	CLI_DIR,
	"tests",
	"fixtures",
	"sigint-ready.mjs",
);
const EXTENSION_FIXTURES = path.join(
	REPO,
	"tests",
	"fixtures",
	"extension-provider",
);

beforeAll(() => {
	if (!existsSync(BIN)) {
		throw new Error(
			`${BIN} is missing: the global setup (tests/build-dist.ts) should have built it`,
		);
	}
});

function tempHome(): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), "rp-built-")));
}

function writeConfig(home: string): string {
	const file = path.join(home, ".pi-review-panel", "config.json");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			roster: [{ id: "opus", provider: "anthropic", model: "claude-opus-4-5" }],
			defaults: { seats: ["opus"] },
		}),
	);
	return file;
}

function cli(
	home: string,
	args: string[],
	options: { input?: string; env?: Record<string, string> } = {},
) {
	const result = spawnSync(process.execPath, [BIN, ...args], {
		cwd: REPO,
		input: options.input ?? "",
		encoding: "utf8",
		// Only what the CLI needs: no inherited API keys, agent folder or config.
		env: { PATH: process.env.PATH ?? "", HOME: home, ...options.env },
		timeout: 60_000,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A throwaway Git repository to run commands in. */
function tempRepo(): string {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-repo-")));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	return dir;
}

/**
 * Runs the bin with stdin held open, and presses Ctrl-C (SIGINT) once its
 * SIGINT handler is installed. stdin closes only after the bin has exited.
 */
function interrupted(
	home: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	ms: number;
}> {
	const started = Date.now();
	const child = spawn(
		process.execPath,
		["--import", pathToFileURL(SIGINT_READY).href, BIN, ...args],
		{
			cwd: options.cwd ?? REPO,
			env: { PATH: process.env.PATH ?? "", HOME: home, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	let sent = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (!sent && stderr.includes("<sigint-handler-ready>")) {
			sent = true;
			child.kill("SIGINT");
		}
	});
	const guard = setTimeout(() => child.kill("SIGKILL"), 45_000);
	return new Promise((resolve) => {
		child.on("close", (code, signal) => {
			clearTimeout(guard);
			child.stdin.end();
			resolve({
				code,
				signal,
				stdout,
				stderr: stderr.replaceAll("<sigint-handler-ready>\n", ""),
				ms: Date.now() - started,
			});
		});
	});
}

describe("the built bin", () => {
	it("--help lists every command", () => {
		const home = tempHome();
		const { code, stdout } = cli(home, ["--help"]);
		expect(code).toBe(0);
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
			expect(stdout).toContain(command);
		}
	});

	it("exits 2 on a usage error and 1 on comment without --owner-approved", () => {
		const home = tempHome();
		expect(cli(home, ["review", "--model", "x"]).code).toBe(2);
		const refused = cli(home, ["comment", "--prior-run-id", "r"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--owner-approved");
	});
});

describe("agent folder selection", () => {
	it("without Pi, uses ~/.pi-review-panel/agent and never creates ~/.pi", () => {
		const home = tempHome();
		writeConfig(home);
		const diagnose = cli(home, ["diagnose"]);
		expect(diagnose.code).toBe(0);
		expect(diagnose.stdout).toContain(
			`Agent folder: ${path.join(home, ".pi-review-panel", "agent")} (review-panel's own folder`,
		);
		expect(diagnose.stdout).toMatch(/review-panel \S+ \(Pi SDK 1\.5\.2\)/);
		expect(cli(home, ["auth", "status"]).code).toBe(0);
		expect(
			cli(home, ["auth", "login", "anthropic", "--api-key"], { input: "k" })
				.code,
		).toBe(0);
		expect(cli(home, ["auth", "logout", "anthropic"]).code).toBe(0);
		expect(existsSync(path.join(home, ".pi"))).toBe(false);
	});

	it("with Pi's auth.json in ~/.pi/agent, reuses that folder", () => {
		const home = tempHome();
		writeConfig(home);
		const pi = path.join(home, ".pi", "agent");
		mkdirSync(pi, { recursive: true });
		writeFileSync(path.join(pi, "auth.json"), "{}");
		const { stdout } = cli(home, ["diagnose"]);
		expect(stdout).toContain(`Agent folder: ${pi} (your Pi agent folder)`);
		expect(existsSync(path.join(home, ".pi-review-panel", "agent"))).toBe(
			false,
		);
	});

	it("PI_CODING_AGENT_DIR wins over both", () => {
		const home = tempHome();
		writeConfig(home);
		const custom = path.join(home, "custom-agent");
		const { stdout } = cli(home, ["diagnose"], {
			env: { PI_CODING_AGENT_DIR: custom },
		});
		expect(stdout).toContain(
			`Agent folder: ${custom} (from PI_CODING_AGENT_DIR)`,
		);
	});
});

describe("auth against a temporary agent folder", () => {
	it("login --api-key stores the key from stdin, status sees it, logout removes it", () => {
		const home = tempHome();
		writeConfig(home);
		const agent = path.join(home, "agent");
		const env = { PI_CODING_AGENT_DIR: agent };

		const before = cli(home, ["auth", "status", "--json"], { env });
		expect(before.code).toBe(0);
		expect(JSON.parse(before.stdout).providers[0]).toMatchObject({
			provider: "anthropic",
			seats: ["opus"],
			authenticated: false,
		});

		const loggedIn = cli(home, ["auth", "login", "anthropic", "--api-key"], {
			env,
			input: "sk-ant-from-stdin\n",
		});
		expect(loggedIn.code).toBe(0);
		expect(loggedIn.stdout).toContain(
			`Saved the API key for Anthropic. Credentials are in ${agent}/auth.json`,
		);
		const auth = JSON.parse(
			readFileSync(path.join(agent, "auth.json"), "utf8"),
		);
		expect(auth.anthropic).toMatchObject({
			type: "api_key",
			key: "sk-ant-from-stdin",
		});

		const after = cli(home, ["auth", "status"], { env });
		expect(after.stdout).toContain(
			"anthropic [seats: opus]: logged in (api_key, stored credential)",
		);

		const out = cli(home, ["auth", "logout", "anthropic"], { env });
		expect(out.code).toBe(0);
		expect(
			JSON.parse(readFileSync(path.join(agent, "auth.json"), "utf8")).anthropic,
		).toBeUndefined();
	});

	it("refuses a key on the command line", () => {
		const home = tempHome();
		const result = cli(home, [
			"auth",
			"login",
			"anthropic",
			"--api-key=sk-on-argv",
		]);
		expect(result.code).toBe(2);
		expect(existsSync(path.join(home, ".pi-review-panel", "agent"))).toBe(
			false,
		);
	});
});

describe("Ctrl-C", () => {
	it.each([
		["call -", ["call", "-"]],
		["auth login --api-key", ["auth", "login", "anthropic", "--api-key"]],
		[
			"comment --dismissed -",
			[
				"comment",
				"--prior-run-id",
				"r",
				"--owner-approved",
				"--dismissed",
				"-",
			],
		],
	])(
		"the first Ctrl-C aborts %s while it reads an open stdin, and exits 1",
		async (_name, args) => {
			const home = tempHome();
			const result = await interrupted(home, args, {
				env: { PI_CODING_AGENT_DIR: path.join(home, "agent") },
			});
			expect(result.signal).toBeNull();
			expect(result.code).toBe(1);
			expect(result.stderr).toBe(
				"\nreview-panel: aborting (press Ctrl-C again to quit at once)\nreview-panel: aborted (interrupted)\n",
			);
			// Not held open by stdin until the 30-second exit timer.
			expect(result.ms).toBeLessThan(20_000);
			const auth = path.join(home, "agent", "auth.json");
			if (existsSync(auth)) {
				expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({});
			}
		},
	);
});

describe("errors never echo an argument that could be a key", () => {
	const KEYS = ["sk-ant-api03-Abc9XyZ0SECRET", "sk-ant-abc123secret"];

	it.each(KEYS)("auth login -k<key> (%s)", (key) => {
		const home = tempHome();
		const result = cli(home, ["auth", "login", `-k${key}`]);
		expect(result.code).toBe(2);
		expect(`${result.stdout}${result.stderr}`).not.toContain(key);
		expect(`${result.stdout}${result.stderr}`).not.toContain("secret");
	});

	it.each(KEYS)("auth login <key> --api-key (%s)", (key) => {
		const home = tempHome();
		const result = cli(home, ["auth", "login", key, "--api-key"], {
			input: "k",
			env: { PI_CODING_AGENT_DIR: path.join(home, "agent") },
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unknown provider");
		expect(`${result.stdout}${result.stderr}`).not.toContain(key);
		expect(`${result.stdout}${result.stderr}`).not.toContain("secret");
	});

	it.each(
		[
			["auth", "logout", "KEY"],
			["auth", "status", "KEY"],
			["auth", "KEY"],
			["KEY"],
			["call", "KEY"],
			["auth", "login", "anthropic", "--KEY"],
		].map((argv) => [argv.join(" "), argv] as const),
	)("%s", (_name, argv) => {
		for (const key of KEYS) {
			const home = tempHome();
			const result = cli(
				home,
				argv.map((arg) => arg.replace("KEY", key)),
				{ env: { PI_CODING_AGENT_DIR: path.join(home, "agent") } },
			);
			expect(`${result.stdout}${result.stderr}`).not.toContain(key);
			expect(`${result.stdout}${result.stderr}`).not.toContain("secret");
		}
	});
});

describe("a provider registered by an extension", () => {
	it("auth status and diagnose load the row's extensions through the real SDK", () => {
		const home = tempHome();
		const repo = tempRepo();
		const extension = path.join(EXTENSION_FIXTURES, "provider-extension.ts");
		const file = path.join(home, ".pi-review-panel", "config.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				roster: [
					{
						id: "fixture",
						provider: "review-panel-fixture",
						model: "fixture-model",
						extraExtensionPaths: [extension],
					},
					{
						id: "unauthed",
						provider: "review-panel-fixture-unauthed",
						model: "fixture-model",
						extraExtensionPaths: [extension],
					},
				],
				defaults: { seats: ["fixture"] },
			}),
		);
		const env = { PI_CODING_AGENT_DIR: path.join(home, "agent") };

		const status = cli(home, ["auth", "status", "--json", "--repo", repo], {
			env,
		});
		expect(status.code).toBe(0);
		const providers = JSON.parse(status.stdout).providers;
		expect(providers[0]).toMatchObject({
			provider: "review-panel-fixture",
			seats: ["fixture"],
			authenticated: true,
			check: { type: "api_key", source: "review-panel fixture" },
			extensionFailures: [],
		});
		expect(providers[1]).toMatchObject({
			provider: "review-panel-fixture-unauthed",
			authenticated: false,
		});

		const diagnose = cli(home, ["diagnose", "--repo", repo], { env });
		expect(diagnose.code).toBe(0);
		expect(diagnose.stdout).toContain(
			'authentication review-panel-fixture-unauthed: Authenticate the Pi provider "review-panel-fixture-unauthed"',
		);
		expect(diagnose.stdout).not.toContain(
			"authentication review-panel-fixture:",
		);
	});
});

describe("the packed tarball", () => {
	it("carries its own prompts, outside the repository", async () => {
		const out = tempHome();
		execFileSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", out],
			{ cwd: CLI_DIR, stdio: "ignore" },
		);
		const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
		expect(tarball).toBeDefined();
		execFileSync("tar", ["-xzf", path.join(out, tarball as string)], {
			cwd: out,
		});
		const dist = path.join(out, "package", "dist");
		const lenses = await import(
			pathToFileURL(path.join(dist, "src", "config", "lenses.js")).href
		);
		const passes = await import(
			pathToFileURL(path.join(dist, "src", "config", "audit-passes.js")).href
		);
		expect(lenses.loadLensTable().size).toBeGreaterThan(0);
		expect(passes.loadAuditPassTable().size).toBeGreaterThan(0);
		expect(existsSync(path.join(dist, "prompts"))).toBe(true);
		expect(existsSync(path.join(dist, "src", "tool", "review-panel.js"))).toBe(
			false,
		);
	});
});
