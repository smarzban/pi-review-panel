/**
 * Runs the built bin (`npm run build` first) as a user would, with the real
 * bundled Pi SDK. Every spawn gets a scrubbed environment and a temporary HOME,
 * so no test can read or write the owner's real Pi or review-panel folders.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = realpathSync(path.resolve(import.meta.dirname, "..", ".."));
const BIN = path.join(REPO, "dist", "src", "cli", "main.js");
const SIGINT_READY = path.join(
	REPO,
	"tests",
	"cli",
	"fixtures",
	"sigint-ready.mjs",
);
const CLI_VERSION = (
	JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as {
		version: string;
	}
).version;
const EXTENSION_FIXTURES = path.join(
	REPO,
	"tests",
	"fixtures",
	"extension-provider",
);

beforeAll(() => {
	if (!existsSync(BIN)) {
		throw new Error(
			`${BIN} is missing: the global setup (tests/cli/build-dist.ts) should have built it`,
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

	it("--version prints the package.json version", () => {
		const { code, stdout } = cli(tempHome(), ["--version"]);
		expect(code).toBe(0);
		expect(stdout).toBe(`${CLI_VERSION}\n`);
		expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("exits 2 on a usage error and 1 on comment without --owner-approved", () => {
		const home = tempHome();
		expect(cli(home, ["review", "--model", "x"]).code).toBe(2);
		const refused = cli(home, ["comment", "--prior-run-id", "r"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--owner-approved");
	});
});

describe("suggest on a hostile diff", () => {
	it("prints evidence as inert code spans at the real file and line, with no escape or CR byte", () => {
		const home = tempHome();
		writeConfig(home);
		const repo = tempRepo();
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git(["config", "user.email", "built@example.test"]);
		git(["config", "user.name", "Built Test"]);
		git(["commit", "--allow-empty", "-m", "base", "--quiet"]);
		mkdirSync(path.join(repo, "src"));
		const name = "src/[pwn](javascript:x)*b*.ts";
		writeFileSync(
			path.join(repo, name),
			[
				"++ b/evil\u001b[31mRED\u001b]52;c;eA==\u0007\r# Heading [x](http://e)",
				'require("child_process");',
				"",
			].join("\n"),
		);
		git(["add", "."]);
		git(["commit", "-m", "hostile", "--quiet"]);
		const { code, stdout, stderr } = cli(home, [
			"suggest",
			"--repo",
			repo,
			"--base",
			"HEAD~1",
			"--head",
			"HEAD",
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout.split("\n").slice(2, 4)).toEqual([
			"- security: added line(s) touch auth/crypto/subprocess/deserialization (`src/[pwn](javascript:x)*b*.ts:2`)",
			"- tests: code changed: check coverage, and that each added, edited, or deleted test can fail and is worth keeping (`src/[pwn](javascript:x)*b*.ts`)",
		]);
		expect(stdout).not.toContain("evil");
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about control characters
		expect(stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
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
		expect(diagnose.stdout).toContain(
			`review-panel ${CLI_VERSION} (Pi SDK 1.5.2)`,
		);
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

	it("a provider with only key login (baseten) takes a piped key without --api-key", () => {
		const home = tempHome();
		const agent = path.join(home, "agent");
		const result = cli(home, ["auth", "login", "baseten"], {
			env: { PI_CODING_AGENT_DIR: agent },
			input: "bt-from-stdin\n",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Saved the API key for Baseten");
		expect(
			JSON.parse(readFileSync(path.join(agent, "auth.json"), "utf8")).baseten,
		).toMatchObject({ type: "api_key", key: "bt-from-stdin" });
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

describe("usage errors never echo a token that could be a key", () => {
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
			["call", '{"action":"diagnose","KEY":1}'],
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

describe("skill install from the built bin", () => {
	it("finds Pi by its own folder, even when the CLI uses its own agent folder", () => {
		const home = tempHome();
		// Pi is installed but has no login, so the CLI itself uses
		// ~/.pi-review-panel/agent; the skill still belongs in ~/.pi/agent.
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		const { code, stdout } = cli(home, ["skill", "install", "--dry-run"]);
		expect(code).toBe(0);
		expect(stdout).toContain(
			`Pi: would link ${path.join(home, ".pi", "agent", "skills", "review-panel")}`,
		);
		expect(stdout).toContain(
			`Claude Code: not found (${path.join(home, ".claude")} does not exist)`,
		);
		expect(readdirSync(home)).toEqual([".pi"]);
		expect(readdirSync(path.join(home, ".pi", "agent"))).toEqual([]);
	});

	it("installs and uninstalls through CODEX_HOME and PI_CODING_AGENT_DIR, never the default folders (P-2)", () => {
		const home = tempHome();
		const elsewhere = tempHome();
		const codexHome = path.join(elsewhere, "codex");
		const piHome = path.join(elsewhere, "pi-agent");
		mkdirSync(codexHome);
		mkdirSync(piHome);
		// Decoys: the default folders exist too, and must not change.
		mkdirSync(path.join(home, ".codex"));
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		const env = { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piHome };
		const links = [codexHome, piHome].map((dir) =>
			path.join(dir, "skills", "review-panel"),
		);

		const installed = cli(home, ["skill", "install"], { env });
		expect(installed.code).toBe(0);
		for (const link of links) {
			expect(realpathSync(link)).toBe(
				path.join(REPO, "skills", "review-panel"),
			);
		}
		expect(readdirSync(path.join(home, ".codex"))).toEqual([]);
		expect(readdirSync(path.join(home, ".pi", "agent"))).toEqual([]);
		const diagnose = cli(home, ["diagnose"], { env });
		expect(diagnose.stdout).toContain(`- Codex: linked (${links[0]})`);
		expect(diagnose.stdout).toContain(`- Pi: linked (${links[1]})`);

		expect(cli(home, ["skill", "uninstall"], { env }).code).toBe(0);
		for (const link of links) {
			expect(existsSync(link)).toBe(false);
		}
		expect(readdirSync(path.join(home, ".codex"))).toEqual([]);
		expect(readdirSync(path.join(home, ".pi", "agent"))).toEqual([]);
	});

	it("finds no agent in an empty home, exits 1 and creates nothing", () => {
		const home = tempHome();
		const { code, stdout } = cli(home, ["skill", "install", "--dry-run"]);
		expect(code).toBe(1);
		expect(stdout).toContain("No coding agent found");
		expect(readdirSync(home)).toEqual([]);
	});

	it("links the package's own skill folder, and uninstall removes the link", () => {
		const home = tempHome();
		mkdirSync(path.join(home, ".claude"));
		expect(cli(home, ["skill", "install"]).code).toBe(0);
		const link = path.join(home, ".claude", "skills", "review-panel");
		expect(realpathSync(link)).toBe(path.join(REPO, "skills", "review-panel"));
		const diagnose = cli(home, ["diagnose"]);
		expect(diagnose.stdout).toContain(`- Claude Code: linked (${link})`);
		expect(cli(home, ["skill", "uninstall"]).code).toBe(0);
		expect(existsSync(link)).toBe(false);
		expect(
			existsSync(path.join(REPO, "skills", "review-panel", "SKILL.md")),
		).toBe(true);
	});
});

describe("the packed tarball", () => {
	it("is the public pi-review-panel package with the review-panel bin", () => {
		const manifest = JSON.parse(
			readFileSync(path.join(REPO, "package.json"), "utf8"),
		) as {
			name?: unknown;
			private?: unknown;
			bin?: Record<string, string>;
			dependencies?: Record<string, string>;
			peerDependencies?: unknown;
			pi?: Record<string, unknown>;
		};
		expect(manifest.name).toBe("pi-review-panel");
		expect(manifest.private).toBeUndefined();
		expect(manifest.bin).toEqual({ "review-panel": "dist/src/cli/main.js" });
		// The SDK runs the seats, so it is a real, exactly pinned dependency.
		expect(manifest.dependencies?.["@earendil-works/pi-coding-agent"]).toMatch(
			/^\d+\.\d+\.\d+$/,
		);
		expect(manifest.peerDependencies).toBeUndefined();
		// Pi still loads the skill from the package, and no extension.
		expect(manifest.pi).toEqual({ skills: ["./skills"] });
	});

	it("carries the built CLI, its prompts and the skill, and runs outside the repository", async () => {
		const out = tempHome();
		execFileSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", out],
			{ cwd: REPO, stdio: "ignore" },
		);
		const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
		expect(tarball).toBeDefined();
		execFileSync("tar", ["-xzf", path.join(out, tarball as string)], {
			cwd: out,
		});
		const root = path.join(out, "package");
		const dist = path.join(root, "dist");
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
		// No TypeScript source, tests or internal files ship.
		expect(existsSync(path.join(root, "src"))).toBe(false);
		expect(existsSync(path.join(root, "tests"))).toBe(false);
		expect(existsSync(path.join(root, "scripts"))).toBe(false);
		// The unpacked bin finds the package's own version.
		const version = spawnSync(
			process.execPath,
			[path.join(dist, "src", "cli", "main.js"), "--version"],
			{
				cwd: out,
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: out },
			},
		);
		expect(version.status).toBe(0);
		expect(version.stdout).toBe(`${CLI_VERSION}\n`);
	});
});

describe("the pack lifecycle (P-3)", () => {
	it("npm pack on a clean copy without dist/ builds it, and the unpacked package runs the SDK and installs the skill", () => {
		// A clean copy: the package's sources, no dist/. node_modules is the
		// checkout's, for the build tool only.
		const copy = tempHome();
		for (const entry of [
			"package.json",
			"package-lock.json",
			"LICENSE",
			"README.md",
			"scripts",
			"src",
			"prompts",
			"skills",
			"docs",
		]) {
			cpSync(path.join(REPO, entry), path.join(copy, entry), {
				recursive: true,
			});
		}
		symlinkSync(
			path.join(REPO, "node_modules"),
			path.join(copy, "node_modules"),
		);
		expect(existsSync(path.join(copy, "dist"))).toBe(false);

		const out = tempHome();
		execFileSync("npm", ["pack", "--pack-destination", out], {
			cwd: copy,
			stdio: "ignore",
		});
		expect(existsSync(path.join(copy, "dist", "src", "cli", "main.js"))).toBe(
			true,
		);
		const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
		execFileSync("tar", ["-xzf", path.join(out, tarball as string)], {
			cwd: out,
		});
		const unpacked = path.join(out, "package");
		const bin = path.join(unpacked, "dist", "src", "cli", "main.js");
		expect(existsSync(bin)).toBe(true);
		// The runtime dependencies, as an install would place them.
		symlinkSync(
			path.join(REPO, "node_modules"),
			path.join(unpacked, "node_modules"),
		);

		const home = tempHome();
		mkdirSync(path.join(home, ".claude"));
		const config = path.join(tempHome(), "config.json");
		writeFileSync(
			config,
			JSON.stringify({
				roster: [
					{ id: "opus", provider: "anthropic", model: "claude-opus-4-5" },
				],
				defaults: { seats: ["opus"] },
			}),
		);
		const repo = tempRepo();
		const run = (args: string[]) =>
			spawnSync(process.execPath, [bin, ...args], {
				cwd: repo,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					PI_REVIEW_PANEL_CONFIG: config,
				},
				timeout: 60_000,
			});

		// An SDK-backed, offline command: the version comes from the SDK, and
		// the readiness check resolves the roster's model through it.
		const diagnose = run(["diagnose"]);
		expect(diagnose.status).toBe(0);
		expect(diagnose.stdout).toMatch(/^review-panel \S+ \(Pi SDK 1\.5\.2\)$/m);
		expect(diagnose.stdout).toContain("# Review panel readiness");
		expect(diagnose.stdout).toContain(
			'authentication anthropic: Authenticate the Pi provider "anthropic"',
		);

		const install = run(["skill", "install"]);
		expect(install.status).toBe(0);
		expect(
			realpathSync(path.join(home, ".claude", "skills", "review-panel")),
		).toBe(realpathSync(path.join(unpacked, "skills", "review-panel")));
	});
});
