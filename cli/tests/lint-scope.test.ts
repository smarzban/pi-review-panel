/**
 * The root package's `npm run check` must not lint `cli/`: the Pi package's
 * gate covers only what it ships. The CLI lints itself with its own config.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI_DIR = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(CLI_DIR, "..");

/** The files a Biome run checked, as `--verbose` lists them. */
function checkedFiles(cwd: string, args: string[]): string[] {
	const biome = path.join(cwd, "node_modules", ".bin", "biome");
	if (!existsSync(biome)) {
		throw new Error(`${biome} is missing: run "npm ci" in ${cwd} first`);
	}
	const result = spawnSync(biome, ["check", "--verbose", ...args], {
		cwd,
		encoding: "utf8",
	});
	return `${result.stdout}${result.stderr}`
		.split("\n")
		.map((line) => /^\s+- (\S+)$/.exec(line)?.[1])
		.filter((file): file is string => file !== undefined);
}

describe("lint scope", () => {
	it("the root check lints nothing under cli/", () => {
		const files = checkedFiles(ROOT, ["."]);
		expect(files).toContain("src/actions/actions.ts");
		expect(files.filter((file) => file.startsWith("cli/"))).toEqual([]);
	});

	it("the CLI's own check lints the CLI's sources, tests and config", () => {
		const files = checkedFiles(CLI_DIR, ["--config-path=biome.cli.json", "."]);
		for (const file of [
			"src/main.ts",
			"tests/lint-scope.test.ts",
			"build.mjs",
			"package.json",
			"biome.cli.json",
		]) {
			expect(files).toContain(file);
		}
		expect(files.some((file) => file.startsWith("../"))).toBe(false);
	});
});
