/**
 * Writes a Pi package that holds the provider fixture extension as a `.ts`
 * entry, the way `pi-claude-code` ships, into a folder outside this checkout:
 * there `@earendil-works/pi-ai` resolves only through the Pi SDK's extension
 * loader, as it does for a user without Pi. Optionally makes it a Git
 * repository, and gives the environment that makes a `git:` source for it
 * clone from that local repository, so no test reaches the network.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROVIDER_EXTENSION = path.join(
	import.meta.dirname,
	"extension-provider",
	"provider-extension.ts",
);

/** The `git:` source that `gitSourceEnv` rewrites to the local repository. */
export const FIXTURE_GIT_SOURCE = "git:example.invalid/fixture/pi-ext";
export const FIXTURE_GIT_URL = "https://example.invalid/fixture/pi-ext";

export function writeExtensionPackage(
	dir: string,
	options: { git?: boolean } = {},
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
	copyFileSync(PROVIDER_EXTENSION, path.join(dir, "extensions", "index.ts"));
	if (options.git) {
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		git(["init", "-q"]);
		git(["add", "."]);
		git([
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"user.name=Fixture",
			"commit",
			"-qm",
			"fixture",
		]);
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
		npm_config_offline: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
}
