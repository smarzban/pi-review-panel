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

import {
	FIXTURE_GIT_SOURCE,
	gitSourceEnv,
	writeExtensionPackage,
} from "../fixtures/extension-package.js";

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
	options: { input?: string; env?: Record<string, string>; cwd?: string } = {},
) {
	const result = spawnSync(process.execPath, [BIN, ...args], {
		cwd: options.cwd ?? REPO,
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
	options: {
		cwd?: string;
		env?: Record<string, string>;
		/** Press Ctrl-C only once stderr also holds this text. */
		after?: string;
	} = {},
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
		if (
			!sent &&
			stderr.includes("<sigint-handler-ready>") &&
			(options.after === undefined || stderr.includes(options.after))
		) {
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

describe("setting up without Pi, from an empty home", () => {
	it("auth providers, auth login, models, extension install from a git source, then diagnose with the installed path", () => {
		const home = tempHome();
		const repo = tempRepo();
		const source = realpathSync(
			mkdtempSync(path.join(tmpdir(), "rp-ext-src-")),
		);
		writeExtensionPackage(source, { git: true });
		// The git: source clones from the local repository, and npm stays offline.
		const env = gitSourceEnv(source);
		const agent = path.join(home, ".pi-review-panel", "agent");

		const providers = cli(home, ["auth", "providers"], { env });
		expect(providers.code).toBe(0);
		expect(providers.stdout).toContain(
			`Agent folder: ${agent} (review-panel's own folder`,
		);
		expect(providers.stdout).toMatch(
			/^anthropic\s+Anthropic\s+account or API key\s+not logged in$/m,
		);

		expect(
			cli(home, ["auth", "login", "anthropic", "--api-key"], {
				env,
				input: "sk-ant-fake\n",
			}).code,
		).toBe(0);
		const anthropic = cli(home, ["models", "anthropic"], { env });
		expect(anthropic.code).toBe(0);
		expect(anthropic.stdout).toMatch(/^anthropic\s+claude-\S+\s+\d/m);
		expect(anthropic.stdout).toMatch(
			/^ {2}\{"id":"[^"]+","provider":"anthropic","model":"[^"]+"\}$/m,
		);

		const install = cli(home, ["extension", "install", FIXTURE_GIT_SOURCE], {
			env,
		});
		expect(install.code).toBe(0);
		const clone = path.join(
			agent,
			"git",
			"example.invalid",
			"fixture",
			"pi-ext",
		);
		const entry = path.join(clone, "extensions", "index.ts");
		expect(install.stdout.trimEnd().split("\n").at(-1)).toBe(`  ${entry}`);
		expect(install.stdout).not.toContain("Pi now loads");

		const listed = cli(home, ["extension", "list", "--json"], { env });
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout).extensions).toEqual([
			{
				source: FIXTURE_GIT_SOURCE,
				installedPath: clone,
				filtered: false,
				entries: [entry],
			},
		]);

		const models = cli(home, ["models", "review-panel-fixture"], { env });
		expect(models.code).toBe(0);
		expect(models.stdout).toMatch(
			new RegExp(
				`^review-panel-fixture\\s+fixture-model\\s+8K\\s+1K\\s+no\\s+no\\s+${FIXTURE_GIT_SOURCE}$`,
				"m",
			),
		);
		const row = JSON.parse(
			models.stdout
				.split("\n")
				.find((line) => line.startsWith('  {"id"'))
				?.trim() ?? "",
		);
		expect(row).toEqual({
			id: "fixture-model",
			provider: "review-panel-fixture",
			model: "fixture-model",
			extraExtensionPaths: [entry],
		});

		const config = path.join(home, ".pi-review-panel", "config.json");
		writeFileSync(
			config,
			JSON.stringify({
				roster: [
					{ ...row, id: "fixture" },
					{ id: "opus", provider: "anthropic", model: "claude-opus-4-5" },
				],
				defaults: { seats: ["fixture", "opus"] },
			}),
		);
		const diagnose = cli(home, ["diagnose", "--repo", repo], { env });
		expect(diagnose.code).toBe(0);
		expect(diagnose.stdout).toContain("- Status: ready");
		expect(diagnose.stdout).not.toContain("extension ");
		expect(diagnose.stdout).not.toContain("model review-panel-fixture");
		expect(diagnose.stdout).not.toContain(
			"authentication review-panel-fixture",
		);
		expect(diagnose.stdout).not.toContain("authentication anthropic");
		expect(existsSync(path.join(home, ".pi"))).toBe(false);

		const removed = cli(home, ["extension", "remove", FIXTURE_GIT_SOURCE], {
			env,
		});
		expect(removed.code).toBe(0);
		expect(existsSync(clone)).toBe(false);
		// About ten spawns of the bin, each loading the SDK, plus a git clone and an
		// npm install: far more than one spawn's default bound (F-9).
	}, 300_000);
});

describe("an installed extension that never finishes loading", () => {
	function hangingSetup() {
		const home = tempHome();
		const source = realpathSync(
			mkdtempSync(path.join(tmpdir(), "rp-ext-hang-")),
		);
		writeExtensionPackage(source, { extension: "hanging-load-extension.ts" });
		const env = { PI_CODING_AGENT_DIR: path.join(home, "agent") };
		expect(cli(home, ["extension", "install", source], { env }).code).toBe(0);
		return { home, env };
	}

	it("models waits out its 30 s bound, names it, and still lists the catalog (F-1)", () => {
		const { home, env } = hangingSetup();
		const models = cli(home, ["models", "--all", "--json"], { env });
		expect(models.code).toBe(0);
		const result = JSON.parse(models.stdout);
		expect(
			result.models.some(
				(row: { provider: string }) => row.provider === "anthropic",
			),
		).toBe(true);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]).toContain("did not finish loading within 30 s");
	}, 120_000);

	it("the first Ctrl-C ends models at once (R-4)", async () => {
		const { home, env } = hangingSetup();
		const result = await interrupted(home, ["models"], { env });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("aborted");
		expect(result.ms).toBeLessThan(20_000);
	}, 120_000);
});

describe("credentials in an extension source (N-1, regression-1-1)", () => {
	const SECRET = "tok-SECRET-5678";
	// Scheme-less git: forms that Pi's own parser keeps the token in: in the
	// clone URL and in the install path it computes.
	const FORMS = [
		`git:user:${SECRET}@example.invalid/fixture/pi-ext`,
		`git:${SECRET}@example.invalid/fixture/pi-ext`,
		`git:example.invalid/fixture/pi-ext?private_token=${SECRET}`,
	];

	/** Each form clones from the local fixture repository if it ever reaches git. */
	function formEnv(repo: string): Record<string, string> {
		const urls = [
			`https://user:${SECRET}@example.invalid/fixture/pi-ext`,
			`https://${SECRET}@example.invalid/fixture/pi-ext`,
		];
		return {
			...gitSourceEnv(repo),
			GIT_CONFIG_COUNT: String(urls.length + 1),
			...Object.fromEntries(
				urls.flatMap((url, index) => [
					[`GIT_CONFIG_KEY_${index + 1}`, `url.${repo}.insteadOf`],
					[`GIT_CONFIG_VALUE_${index + 1}`, url],
				]),
			),
		};
	}

	it.each(FORMS)(
		"install refuses %s: no clone, nothing in settings.json",
		(source) => {
			const home = tempHome();
			const repo = realpathSync(
				mkdtempSync(path.join(tmpdir(), "rp-ext-cred-")),
			);
			writeExtensionPackage(repo, { git: true });
			const agent = path.join(home, "agent");
			const result = cli(home, ["extension", "install", source], {
				env: { ...formEnv(repo), PI_CODING_AGENT_DIR: agent },
			});
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("credential helper");
			expect(result.stdout + result.stderr).not.toContain(SECRET);
			expect(existsSync(path.join(agent, "git"))).toBe(false);
			expect(existsSync(path.join(agent, "settings.json"))).toBe(false);
		},
		120_000,
	);

	it("a source Pi installed earlier with a token is listed redacted, and removed by the printed source", () => {
		const home = tempHome();
		const agent = path.join(home, "agent");
		const source = FORMS[0] as string;
		// The folder Pi's own parser computes for this source (host keeps the user info).
		const clone = path.join(
			agent,
			"git",
			`user:${SECRET}@example.invalid`,
			"fixture",
			"pi-ext",
		);
		const entry = writeExtensionPackage(clone);
		writeFileSync(
			path.join(agent, "settings.json"),
			JSON.stringify({ packages: [source] }),
		);
		const env = { PI_CODING_AGENT_DIR: agent };

		const listed = cli(home, ["extension", "list", "--json"], { env });
		expect(listed.code).toBe(0);
		expect(listed.stdout).not.toContain(SECRET);
		const [extension] = JSON.parse(listed.stdout).extensions;
		expect(extension.source).toBe("git:***@example.invalid/fixture/pi-ext");
		expect(extension.entries).toEqual([
			entry.replace(`user:${SECRET}@`, "***@"),
		]);
		const text = cli(home, ["extension", "list"], { env });
		expect(text.stdout).not.toContain(SECRET);
		const models = cli(home, ["models", "--all", "--json"], { env });
		expect(models.code).toBe(0);
		expect(models.stdout).not.toContain(SECRET);
		expect(models.stdout).toContain("review-panel-fixture");

		const removed = cli(home, ["extension", "remove", extension.source], {
			env,
		});
		expect(removed.code).toBe(0);
		expect(removed.stdout + removed.stderr).not.toContain(SECRET);
		expect(existsSync(clone)).toBe(false);
		expect(
			JSON.parse(readFileSync(path.join(agent, "settings.json"), "utf8"))
				.packages,
		).toEqual([]);
	}, 120_000);
});

describe("an install stopped by Ctrl-C (N-3)", () => {
	it("exits at once and never records the source afterwards", async () => {
		const home = tempHome();
		const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-ext-slow-")));
		writeExtensionPackage(repo, { git: true });
		// A git that takes 4 s, so the clone is still running at Ctrl-C.
		const bin = path.join(home, "slow-bin");
		mkdirSync(bin);
		const realGit = execFileSync("sh", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nsleep 4\nexec "${realGit}" "$@"\n`,
			{ mode: 0o755 },
		);
		const agent = path.join(home, "agent");
		const result = await interrupted(
			home,
			["extension", "install", FIXTURE_GIT_SOURCE],
			{
				env: {
					...gitSourceEnv(repo),
					PI_CODING_AGENT_DIR: agent,
					PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				},
				// Ctrl-C while the slowed git clone runs.
				after: `Installing ${FIXTURE_GIT_SOURCE}...`,
			},
		);
		expect(result.code).toBe(1);
		expect(result.ms).toBeLessThan(3_000);
		expect(result.stderr).toContain(`${FIXTURE_GIT_SOURCE} was not recorded`);
		// Long after the slowed clone would have finished.
		await new Promise((resolve) => setTimeout(resolve, 7_000));
		const settings = path.join(agent, "settings.json");
		const packages = existsSync(settings)
			? (JSON.parse(readFileSync(settings, "utf8")).packages ?? [])
			: [];
		expect(packages).toEqual([]);
	}, 60_000);
});

describe("setup commands run from a hostile working folder", () => {
	it("never list or load the folder's Pi project settings or extensions", () => {
		const home = tempHome();
		const hostile = tempRepo();
		mkdirSync(path.join(hostile, ".pi", "extensions"), { recursive: true });
		const evil = path.join(hostile, "evil");
		writeExtensionPackage(evil);
		writeFileSync(
			path.join(hostile, ".pi", "settings.json"),
			JSON.stringify({ packages: ["../evil"], extensions: ["./extensions"] }),
		);
		writeFileSync(
			path.join(hostile, ".pi", "extensions", "x.ts"),
			"export default function () { throw new Error('the hostile extension ran'); }",
		);
		const source = realpathSync(
			mkdtempSync(path.join(tmpdir(), "rp-ext-local-")),
		);
		const entry = writeExtensionPackage(source);
		const env = { PI_CODING_AGENT_DIR: path.join(home, "agent") };

		const install = cli(home, ["extension", "install", source], {
			env,
			cwd: hostile,
		});
		expect(install.code).toBe(0);
		const listed = cli(home, ["extension", "list", "--json"], {
			env,
			cwd: hostile,
		});
		expect(listed.code).toBe(0);
		expect(
			JSON.parse(listed.stdout).extensions.map(
				(extension: { entries: string[] }) => extension.entries,
			),
		).toEqual([[entry]]);

		const models = cli(home, ["models", "--all", "--json"], {
			env,
			cwd: hostile,
		});
		expect(models.code).toBe(0);
		const result = JSON.parse(models.stdout);
		expect(result.problems).toEqual([]);
		const fromExtensions = result.models.filter(
			(row: { extensionPaths: string[] }) => row.extensionPaths.length > 0,
		);
		expect(fromExtensions.length).toBeGreaterThan(0);
		expect(
			fromExtensions.every(
				(row: { extensionPaths: string[] }) =>
					JSON.stringify(row.extensionPaths) === JSON.stringify([entry]),
			),
		).toBe(true);
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
		expect(lenses.loadLensTable().size).toBeGreaterThan(0);
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
