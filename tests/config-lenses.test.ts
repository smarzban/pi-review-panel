// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { readdirSync, readFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadLensTable } from "../src/config/lenses.js";

/**
 * The P5 lens prompts refreshed for the F4 role catalog, pinned verbatim. These
 * hardcoded strings are the byte-level regression oracles: the three files on
 * disk, the values loadLensTable() hands out, and the package contents must
 * all match these exact bytes. The bytes are the specialist-lens subset of the
 * shipped prompt roles.
 */
const EXPECTED_LENSES: Record<string, string> = {
	correctness:
		"You review this change through a generic correctness lens. Focus on logic errors, wrong edge-case handling, incorrect assumptions about how surrounding code behaves, and mismatches between what the code does and what comments, tests, or docs claim it does. Stay in this lens: do not file races, cache invalidation, or clock bugs. Confirm suspicions by reading full files, not just the diff hunks. Report only issues in the changed code you are confident are real; do not report style preferences or speculative concerns. Submit a finding only when you can name a concrete failure scenario and an actual consumer that would hit it. Hypothetical or unnamed consumers are not enough.",
	security:
		"You review this change through a security lens. Focus on attacker-controlled inputs and trust boundaries: path traversal, injection through tool arguments or prompt text, unsafe file creation and symlink handling, TOCTOU races, and failures to confine untrusted input. Stay in this lens: do not file style, coverage, or generic logic issues unless they create an attacker-controlled path. Confirm suspicions by reading full files, not just the diff hunks. Report only issues in the changed code you are confident are real; do not report speculative concerns. Submit a finding only when you can name a concrete failure scenario and an actual consumer that would hit it. Hypothetical or unnamed consumers are not enough.",
	tests:
		"You review this change through a tests lens. Focus on behavioral coverage and assertion quality: behavior the change introduces that has no test, assertions that do not verify the claimed behavior, tests that would still pass if the code were broken, untested failure paths, and each new production handoff. Map each new production handoff to a test that would fail if that wiring were deleted or swapped for the default. Stay in this lens: do not comment on production style or architecture unless it prevents a useful test. Confirm suspicions by reading full files, not just the diff hunks. Report only gaps you are confident are real; do not report speculative concerns. Submit a finding only when you can name a concrete failure scenario and an actual consumer that would hit it. Hypothetical or unnamed consumers are not enough.",
};

/** Package root, resolved from this test file's own module location. */
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Every production TypeScript source under src/, recursively. The scan is
 * deliberately restricted to src/ so this test file's own oracle bytes and
 * the prompts/ files are never counted (AC-13).
 */
function readProductionSources(): string[] {
	const sources: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".ts")) {
				sources.push(readFileSync(full, "utf8"));
			}
		}
	};
	walk(path.join(PACKAGE_ROOT, "src"));
	return sources;
}

describe("config lens registry", () => {
	it("ships the three prompt files byte-for-byte with no trailing newline", () => {
		for (const [lens, expected] of Object.entries(EXPECTED_LENSES)) {
			const bytes = readFileSync(
				fileURLToPath(new URL(`../prompts/${lens}.md`, import.meta.url)),
				"utf8",
			);
			expect(bytes, `${lens}.md bytes match the P5 prompt`).toBe(expected);
			expect(bytes.endsWith("\n"), `${lens}.md has no trailing newline`).toBe(
				false,
			);
			expect(bytes.endsWith("\r"), `${lens}.md has no trailing CR`).toBe(false);
		}
	});

	it("loads holistic plus specialist extras with byte-identical prompt values", () => {
		const table = loadLensTable();
		expect(table).toBeInstanceOf(Map);
		expect(table.has("holistic")).toBe(true);
		expect([...table.keys()]).toEqual(
			expect.arrayContaining(["holistic", "correctness", "security", "tests"]),
		);
		for (const [lens, expected] of Object.entries(EXPECTED_LENSES)) {
			expect(table.get(lens), `map value for ${lens}`).toBe(expected);
		}
	});

	it("does not resolve prototype-chain hostile lens names", () => {
		const table = loadLensTable();
		expect(table.get("constructor")).toBeUndefined();
		expect(table.get("__proto__")).toBeUndefined();
		expect(table.has("constructor")).toBe(false);
		expect(table.has("__proto__")).toBe(false);
	});

	it("keeps the P5 prompt bytes out of production source (AC-13)", () => {
		const sources = readProductionSources();
		for (const [lens, prompt] of Object.entries(EXPECTED_LENSES)) {
			for (const [index, bytes] of sources.entries()) {
				expect(
					bytes.includes(prompt),
					`src/ must not duplicate the ${lens} lens prompt (source ${index})`,
				).toBe(false);
			}
		}
	});

	it("ships the runtime resources and no internal artifacts inside the npm package contents", () => {
		const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
		});
		const parsed: unknown = JSON.parse(output);
		const packaged = Array.isArray(parsed) ? parsed : [parsed];
		const shipped = new Set(
			packaged.flatMap(
				(entry) =>
					(entry as { files?: Array<{ path: string }> }).files?.map(
						(file) => file.path,
					) ?? [],
			),
		);
		// Shipped runtime resources and public package documentation. Keep this
		// inventory broad, so a T-1 entry-point replacement cannot silently drop
		// unrelated loop, run, config, or seat sources from the tarball.
		const required = [
			"prompts/holistic.md",
			"prompts/correctness.md",
			"prompts/security.md",
			"prompts/tests.md",
			"prompts/contracts.md",
			"prompts/privacy.md",
			"prompts/migrations.md",
			"prompts/subtle-correctness.md",
			"prompts/simplification.md",
			"prompts/performance.md",
			"prompts/infrastructure.md",
			"prompts/specification-conformance.md",
			"prompts/fix-verification.md",
			"prompts/audit-code-health.md",
			"prompts/audit-docs.md",
			"prompts/audit-tests.md",
			"prompts/audit-security.md",
			"prompts/audit-over-engineering.md",
			"prompts/audit-observability.md",
			"prompts/audit-operability.md",
			"prompts/audit-ux.md",
			"docs/configuration.md",
			"src/config/roles.ts",
			"src/config/audit-passes.ts",
			"src/config/audit-panel.ts",
			"src/config/load.ts",
			"src/config/schema.ts",
			"src/config/lenses.ts",
			"src/config/panel.ts",
			"src/config/readiness.ts",
			"src/tool/review-panel.ts",
			"src/tool/closeout-comment.ts",
			"src/tool/closeout-post.ts",
			"src/tool/closeout-from-run.ts",
			"src/run/run-review.ts",
			"src/run/run-audit.ts",
			"src/run/render-audit.ts",
			"src/seat/seat-extension.ts",
			"skills/review-panel/SKILL.md",
			"host-skills/pi-review/SKILL.md",
			"package.json",
			"README.md",
			"LICENSE",
		];
		for (const file of required) {
			expect(shipped.has(file), `npm package contains ${file}`).toBe(true);
		}
		expect(shipped.has("src/tool/review-panel.ts")).toBe(true);
		// Internal process artifacts, specs, and tests never ship.
		const internalPrefixes = [
			".agent-sdlc/",
			".review-panel/",
			".worktrees/",
			"tests/",
			"docs/specs/",
		];
		for (const file of shipped) {
			for (const prefix of internalPrefixes) {
				expect(
					file.startsWith(prefix),
					`npm package must not contain ${file}`,
				).toBe(false);
			}
		}
	});
});
