#!/usr/bin/env node
/**
 * The `review-panel` bin. It pins the agent folder in the environment first,
 * and only then loads the modules that may load the Pi SDK.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { applyAgentDir } from "./agent-dir.js";

// The environment as launched: `skill install` finds Pi's own folder from the
// user's PI_CODING_AGENT_DIR, not from the folder pinned below for the SDK.
const launchEnv = { ...process.env };
const agentDir = applyAgentDir({ env: process.env, home: homedir() });

/**
 * The nearest `pi-review-panel` package.json above this module, in the source
 * tree or in an installed package's dist/: the package root and its version.
 */
function findPackage(): { root: string; version: string } {
	let dir = import.meta.dirname;
	for (;;) {
		try {
			const manifest = JSON.parse(
				readFileSync(path.join(dir, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			if (
				manifest.name === "pi-review-panel" &&
				typeof manifest.version === "string"
			) {
				return { root: dir, version: manifest.version };
			}
		} catch {
			// Not here; keep walking up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return {
				root: path.resolve(import.meta.dirname, "..", ".."),
				version: "unknown",
			};
		}
		dir = parent;
	}
}

const pkg = findPackage();

const { realActions, run } = await import("./run.js");
const { realAuthSdk, realSetupSdk, sdkVersion } = await import("./sdk.js");
const { processTerminal, readAll } = await import("./terminal.js");

const controller = new AbortController();
let interrupts = 0;
const onInterrupt = () => {
	interrupts++;
	if (interrupts === 1) {
		process.stderr.write(
			"\nreview-panel: aborting (press Ctrl-C again to quit at once)\n",
		);
		controller.abort(new Error("interrupted"));
		return;
	}
	process.exit(1);
};
process.on("SIGINT", onInterrupt);

const code = await run(
	process.argv.slice(2),
	{
		cwd: process.cwd(),
		env: launchEnv,
		home: homedir(),
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		readStdin: (signal) => readAll(process.stdin, signal),
		readFile: (file) => readFileSync(file, "utf8"),
		signal: controller.signal,
		terminal: processTerminal(),
	},
	{
		agentDir,
		cliVersion: pkg.version,
		sdkVersion,
		actions: realActions,
		authSdk: realAuthSdk,
		setupSdk: realSetupSdk,
		skillSource: {
			dir: path.join(pkg.root, "skills", "review-panel"),
			version: pkg.version,
			platform: process.platform,
		},
	},
);
process.off("SIGINT", onInterrupt);
process.exitCode = code;
// The SDK can leave idle handles (keep-alive sockets, timers) open. Every
// credential write was settled above; give anything else ample time, then
// exit even if something still holds the loop.
setTimeout(() => process.exit(code), 30_000).unref();
