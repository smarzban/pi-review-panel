// Packs this checkout the way `npm publish` does (prepack builds dist/),
// installs the tarball globally into a temporary prefix with production
// dependencies only (from the npm registry), then runs the installed
// `review-panel` outside the checkout with a scrubbed environment and a
// temporary HOME: an SDK-backed `diagnose` and a real `skill install`.
// Too slow and networked for the unit suite; CI runs it (`npm run smoke:installed`).
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-smoke-")));

function fail(message, result) {
	console.error(`smoke: ${message}`);
	if (result !== undefined) {
		console.error(`exit ${result.status}\n${result.stdout}\n${result.stderr}`);
	}
	process.exit(1);
}

try {
	const out = path.join(work, "pack");
	mkdirSync(out);
	execFileSync("npm", ["pack", "--pack-destination", out], {
		cwd: repo,
		stdio: ["ignore", "ignore", "inherit"],
	});
	const tarball = readdirSync(out).find((name) => name.endsWith(".tgz"));
	if (tarball === undefined) {
		fail("npm pack wrote no tarball");
	}

	const prefix = path.join(work, "prefix");
	execFileSync(
		"npm",
		[
			"install",
			"--global",
			"--prefix",
			prefix,
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			path.join(out, tarball),
		],
		{ cwd: work, stdio: ["ignore", "ignore", "inherit"] },
	);
	const bin = path.join(prefix, "bin");
	const installedSkill = path.join(
		prefix,
		"lib",
		"node_modules",
		"pi-review-panel",
		"skills",
		"review-panel",
	);

	const home = path.join(work, "home");
	mkdirSync(path.join(home, ".claude"), { recursive: true });
	const config = path.join(work, "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			roster: [{ id: "opus", provider: "anthropic", model: "claude-opus-4-5" }],
			defaults: { seats: ["opus"] },
		}),
	);
	const reviewed = path.join(work, "repo");
	mkdirSync(reviewed);
	execFileSync("git", ["init", "-q"], { cwd: reviewed });

	const run = (args) =>
		spawnSync("review-panel", args, {
			cwd: reviewed,
			encoding: "utf8",
			// Only what the command needs: no inherited agent folders or keys.
			env: {
				PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
					path.delimiter,
				),
				HOME: home,
				PI_REVIEW_PANEL_CONFIG: config,
			},
			timeout: 120_000,
		});

	const diagnose = run(["diagnose"]);
	if (
		diagnose.status !== 0 ||
		!/^review-panel \S+ \(Pi SDK \d+\.\d+\.\d+\)$/m.test(diagnose.stdout) ||
		!diagnose.stdout.includes(
			'authentication anthropic: Authenticate the Pi provider "anthropic"',
		)
	) {
		fail("diagnose from the installed package did not run the SDK", diagnose);
	}

	const install = run(["skill", "install"]);
	const link = path.join(home, ".claude", "skills", "review-panel");
	let linked = "";
	try {
		linked = realpathSync(link);
	} catch {
		// Reported below.
	}
	if (install.status !== 0 || linked !== realpathSync(installedSkill)) {
		fail("skill install did not link the installed package's skill", install);
	}

	const uninstall = run(["skill", "uninstall"]);
	if (uninstall.status !== 0 || readdirSync(path.dirname(link)).length > 0) {
		fail("skill uninstall did not remove the link", uninstall);
	}

	// Setup without Pi: a Pi extension package with a .ts entry, outside any
	// checkout, so its `@earendil-works/pi-ai` import resolves only through the
	// installed package's bundled SDK.
	const providers = run(["auth", "providers"]);
	if (
		providers.status !== 0 ||
		!/^anthropic\s+Anthropic\s+account or API key\s+not logged in$/m.test(
			providers.stdout,
		)
	) {
		fail("auth providers did not list the providers", providers);
	}
	const extension = path.join(work, "extension");
	mkdirSync(path.join(extension, "extensions"), { recursive: true });
	writeFileSync(
		path.join(extension, "package.json"),
		JSON.stringify({
			name: "smoke-extension",
			version: "1.0.0",
			pi: { extensions: ["./extensions/index.ts"] },
		}),
	);
	const entry = path.join(extension, "extensions", "index.ts");
	copyFileSync(
		path.join(
			repo,
			"tests",
			"fixtures",
			"extension-provider",
			"provider-extension.ts",
		),
		entry,
	);
	const installed = run(["extension", "install", extension]);
	if (
		installed.status !== 0 ||
		installed.stdout.trimEnd().split("\n").at(-1) !== `  ${entry}`
	) {
		fail("extension install did not print the entry path", installed);
	}
	const models = run(["models", "review-panel-fixture"]);
	if (
		models.status !== 0 ||
		!models.stdout.includes(
			`{"id":"fixture-model","provider":"review-panel-fixture","model":"fixture-model","extraExtensionPaths":[${JSON.stringify(entry)}]}`,
		)
	) {
		fail("models did not list the installed extension's provider", models);
	}
	const fixtureConfig = path.join(work, "fixture-config.json");
	writeFileSync(
		fixtureConfig,
		JSON.stringify({
			roster: [
				{
					id: "fixture",
					provider: "review-panel-fixture",
					model: "fixture-model",
					extraExtensionPaths: [entry],
				},
			],
			defaults: { seats: ["fixture"] },
		}),
	);
	const ready = spawnSync("review-panel", ["diagnose"], {
		cwd: reviewed,
		encoding: "utf8",
		env: {
			PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
				path.delimiter,
			),
			HOME: home,
			PI_REVIEW_PANEL_CONFIG: fixtureConfig,
		},
		timeout: 120_000,
	});
	if (
		ready.status !== 0 ||
		!ready.stdout.includes("- Status: ready") ||
		ready.stdout.includes("review-panel-fixture") ||
		ready.stdout.includes("extension ")
	) {
		fail("diagnose did not load the installed extension for its seat", ready);
	}
	if (existsSync(path.join(home, ".pi"))) {
		fail("the setup commands created ~/.pi");
	}
	console.log(
		`smoke: ${tarball} installed with production dependencies; diagnose ran the SDK; skill install and uninstall worked; auth providers, extension install, models and diagnose with the installed extension worked without Pi`,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}
