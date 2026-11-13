#!/usr/bin/env node
/**
 * The `review-panel` bin. It pins the agent folder in the environment first,
 * and only then loads the modules that may load the Pi SDK.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { applyAgentDir } from "./agent-dir.js";

const agentDir = applyAgentDir({ env: process.env, home: homedir() });

/** The nearest `review-panel` package.json, in the source tree or in dist. */
function cliVersion(): string {
	let dir = import.meta.dirname;
	for (;;) {
		try {
			const manifest = JSON.parse(
				readFileSync(path.join(dir, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			if (
				manifest.name === "review-panel" &&
				typeof manifest.version === "string"
			) {
				return manifest.version;
			}
		} catch {
			// Not here; keep walking up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return "unknown";
		}
		dir = parent;
	}
}

const { realActions, run } = await import("./run.js");
const { realAuthSdk, sdkVersion } = await import("./sdk.js");
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
		env: process.env,
		home: homedir(),
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		readStdin: () => readAll(process.stdin),
		readFile: (file) => readFileSync(file, "utf8"),
		signal: controller.signal,
		terminal: processTerminal(),
	},
	{
		agentDir,
		cliVersion: cliVersion(),
		sdkVersion,
		actions: realActions,
		authSdk: realAuthSdk,
	},
);
process.off("SIGINT", onInterrupt);
process.exitCode = code;
// The SDK can leave idle handles (keep-alive sockets, timers) open. Give
// pending writes a moment, then exit even if something still holds the loop.
setTimeout(() => process.exit(code), 3_000).unref();
