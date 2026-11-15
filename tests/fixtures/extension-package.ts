/**
 * Writes a Pi package that holds the provider fixture extension as a `.ts`
 * entry, the way `pi-claude-code` ships, into a folder outside this checkout:
 * there `@earendil-works/pi-ai` resolves only through the Pi SDK's extension
 * loader, as it does for a user without Pi. Optionally makes it a Git
 * repository, and gives the environment that makes a `git:` source for it
 * clone from that local repository, so no test reaches the network.
 */
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";

const EXTENSION_FIXTURES = path.join(import.meta.dirname, "extension-provider");

/** The `git:` source that `gitSourceEnv` rewrites to the local repository. */
export const FIXTURE_GIT_SOURCE = "git:example.invalid/fixture/pi-ext";
export const FIXTURE_GIT_URL = "https://example.invalid/fixture/pi-ext";

export function writeExtensionPackage(
	dir: string,
	options: {
		git?: boolean;
		/** A file in tests/fixtures/extension-provider; the provider fixture by default. */
		extension?: string;
		/** Also make this branch at the commit (with `git`). */
		branch?: string;
	} = {},
): string {
	mkdirSync(path.join(dir, "extensions"), { recursive: true });
	writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify({
			name: "review-panel-fixture-ext",
			version: "1.0.0",
			pi: { extensions: ["./extensions/index.ts"] },
		})}\n`,
	);
	copyFileSync(
		path.join(EXTENSION_FIXTURES, options.extension ?? "provider-extension.ts"),
		path.join(dir, "extensions", "index.ts"),
	);
	if (options.git) {
		// Nothing of the developer's Git setup applies: no global or system
		// config (signing, hooks, templates), a throwaway HOME, a fixed author.
		const home = mkdtempSync(path.join(tmpdir(), "rp-fixture-git-home-"));
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			GIT_CONFIG_GLOBAL: os.devNull,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.test",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.test",
		};
		const git = (args: string[]) =>
			execFileSync(
				"git",
				[
					"-c",
					`core.hooksPath=${os.devNull}`,
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd: dir, stdio: "ignore", env },
			);
		try {
			git(["init", "-q", "--template="]);
			git(["add", "."]);
			git(["commit", "-qm", "fixture"]);
			if (options.branch !== undefined) {
				git(["branch", options.branch]);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}
	return path.join(dir, "extensions", "index.ts");
}

/**
 * Git and npm settings that clone `FIXTURE_GIT_URL` from `repo` and keep npm
 * offline, for the `npm install` Pi runs in a cloned package.
 */
export function gitSourceEnv(repo: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`,
		GIT_CONFIG_VALUE_0: FIXTURE_GIT_URL,
		GIT_CONFIG_NOSYSTEM: "1",
		npm_config_offline: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
}
