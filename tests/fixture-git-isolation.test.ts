/**
 * The extension-package fixture makes its Git repository without the
 * developer's Git setup: a global config that signs commits with a program
 * that fails, runs hooks or adds templates must neither break it nor run.
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeExtensionPackage } from "./fixtures/extension-package.js";

let root = "";

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("the extension-package fixture's Git repository (F-6, F-11)", () => {
	it("ignores a hostile HOME and global Git config: no signing, hooks or templates", () => {
		root = realpathSync(mkdtempSync(path.join(tmpdir(), "rp-fixture-git-")));
		const ran = path.join(root, "hook-ran");
		const hooks = path.join(root, "hooks");
		mkdirSync(hooks);
		for (const hook of ["pre-commit", "post-commit", "commit-msg"]) {
			writeFileSync(
				path.join(hooks, hook),
				`#!/bin/sh\ntouch "${ran}"\nexit 1\n`,
				{ mode: 0o755 },
			);
		}
		const config = [
			"[commit]",
			"\tgpgsign = true",
			"[gpg]",
			"\tprogram = false",
			"[core]",
			`\thooksPath = ${hooks}`,
			"[user]",
			"\temail = developer@example.test",
		].join("\n");
		const home = path.join(root, "home");
		mkdirSync(home);
		writeFileSync(path.join(home, ".gitconfig"), config);
		const globalConfig = path.join(root, "global.gitconfig");
		writeFileSync(globalConfig, config);
		vi.stubEnv("HOME", home);
		vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);

		const repo = path.join(root, "pkg");
		writeExtensionPackage(repo, { git: true });

		expect(existsSync(ran)).toBe(false);
		const show = (format: string) =>
			execFileSync("git", ["log", "-1", `--format=${format}`], {
				cwd: repo,
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: root },
			}).trim();
		expect(show("%ae")).toBe("fixture@example.test");
		expect(show("%G?")).toBe("N");
	});
});
