/**
 * Runs the built bin (`npm run build` first) as a user would, with the real
 * bundled Pi SDK. Every spawn gets a scrubbed environment and a temporary HOME,
 * so no test can read or write the owner's real Pi or review-panel folders.
 */
import { execFileSync, spawnSync } from "node:child_process";
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

beforeAll(() => {
	if (!existsSync(BIN)) {
		throw new Error(`${BIN} is missing: the global setup (tests/build-dist.ts) should have built it`);
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
