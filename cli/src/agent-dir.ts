/**
 * Which Pi agent folder (credentials, models, settings) the CLI uses.
 *
 * 1. `$PI_CODING_AGENT_DIR` when it is set, as Pi itself resolves it.
 * 2. `~/.pi/agent` when it holds `auth.json` or `models.json`: the user has Pi,
 *    and the CLI reuses their logins and models.
 * 3. Otherwise `~/.pi-review-panel/agent`, the CLI's own folder.
 *
 * The choice is written to `process.env.PI_CODING_AGENT_DIR` before the Pi SDK
 * is first imported, so that no SDK code path falls back to `~/.pi/agent` and
 * creates it on a machine without Pi. Credentials are never copied between
 * folders.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export type AgentDirSource = "environment" | "pi" | "review-panel";

export type AgentDirChoice = {
	dir: string;
	source: AgentDirSource;
};

export type AgentDirInput = {
	env: Record<string, string | undefined>;
	home: string;
};

/** Pi expands a leading `~` in `PI_CODING_AGENT_DIR`; so does the CLI. */
function expandTilde(value: string, home: string): string {
	if (value === "~") {
		return home;
	}
	if (value.startsWith("~/")) {
		return path.join(home, value.slice(2));
	}
	return value;
}

export function piAgentDir(home: string): string {
	return path.join(home, ".pi", "agent");
}

export function ownAgentDir(home: string): string {
	return path.join(home, ".pi-review-panel", "agent");
}

export function chooseAgentDir(input: AgentDirInput): AgentDirChoice {
	const fromEnv = input.env[AGENT_DIR_ENV];
	// Pi treats an empty value as unset.
	if (fromEnv !== undefined && fromEnv !== "") {
		return {
			dir: path.resolve(expandTilde(fromEnv, input.home)),
			source: "environment",
		};
	}
	const pi = piAgentDir(input.home);
	if (
		existsSync(path.join(pi, "auth.json")) ||
		existsSync(path.join(pi, "models.json"))
	) {
		return { dir: pi, source: "pi" };
	}
	return { dir: ownAgentDir(input.home), source: "review-panel" };
}

/** Chooses the folder and pins it in `env` for every later SDK call. */
export function applyAgentDir(input: AgentDirInput): AgentDirChoice {
	const choice = chooseAgentDir(input);
	input.env[AGENT_DIR_ENV] = choice.dir;
	return choice;
}

export function describeAgentDir(choice: AgentDirChoice): string {
	switch (choice.source) {
		case "environment":
			return `${choice.dir} (from ${AGENT_DIR_ENV})`;
		case "pi":
			return `${choice.dir} (your Pi agent folder)`;
		case "review-panel":
			return `${choice.dir} (review-panel's own folder; no Pi login found in ~/.pi/agent)`;
	}
}
