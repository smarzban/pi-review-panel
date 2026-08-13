// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EXAMPLE_CONFIG } from "../src/config/load.js";
import { validateConfig } from "../src/config/schema.js";

/** Package root, resolved from this test file's own module location. */
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

const GUIDE_PATH = path.join(PACKAGE_ROOT, "docs", "configuration.md");
const README_PATH = path.join(PACKAGE_ROOT, "README.md");

/**
 * Extraction-marker convention: docs/configuration.md marks its canonical
 * copyable example with an HTML comment line `<!-- config-example -->` placed
 * immediately before the fenced ```json block. The test locates the marker,
 * then takes the inner bytes of the block that follows it (content between
 * the opening ```json fence line and the closing ``` fence line, trailing
 * newline stripped). The marker pins the oracle to the marked block so that a
 * later JSON snippet elsewhere in the guide can never become the example.
 */
const CONFIG_EXAMPLE_MARKER = "<!-- config-example -->";

function extractConfigExample(docBytes: string): string {
	const lines = docBytes.split("\n");
	const markerIndex = lines.findIndex(
		(line) => line.trim() === CONFIG_EXAMPLE_MARKER,
	);
	expect(
		markerIndex,
		"guide marks the canonical example",
	).toBeGreaterThanOrEqual(0);
	const openIndex = lines.findIndex(
		(line, index) => index > markerIndex && line.trim() === "```json",
	);
	expect(openIndex, "```json fence follows the marker").toBeGreaterThanOrEqual(
		0,
	);
	const closeIndex = lines.findIndex(
		(line, index) => index > openIndex && line.trim() === "```",
	);
	expect(
		closeIndex,
		"closing fence follows the opening",
	).toBeGreaterThanOrEqual(0);
	// Slicing drops both fence lines; a trailing blank line before the closing
	// fence (an editor artifact) would otherwise append a stray newline, so
	// strip exactly one trailing newline to recover the byte-exact example.
	return lines
		.slice(openIndex + 1, closeIndex)
		.join("\n")
		.replace(/\n$/, "");
}

describe("owner configuration guide", () => {
	it("publishes the marked copyable example byte-equal to EXAMPLE_CONFIG (AC-28)", () => {
		const docBytes = readFileSync(GUIDE_PATH, "utf8");
		const extracted = extractConfigExample(docBytes);
		expect(extracted).toBe(EXAMPLE_CONFIG);
	});

	it("example parses and the production validator accepts it (AC-28)", () => {
		const docBytes = readFileSync(GUIDE_PATH, "utf8");
		const parsed = JSON.parse(extractConfigExample(docBytes)) as unknown;
		const result = validateConfig(parsed);
		expect(result.ok).toBe(true);
	});

	it("README links the guide with a relative link that resolves and exists (AC-28)", () => {
		const readmeBytes = readFileSync(README_PATH, "utf8");
		const relativeTargets: string[] = [];
		for (const match of readmeBytes.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1];
			if (/^(https?:|mailto:|#)/.test(target)) {
				continue;
			}
			relativeTargets.push(target);
		}
		const resolved = relativeTargets.map((target) =>
			path.resolve(PACKAGE_ROOT, target),
		);
		expect(resolved, "README links docs/configuration.md").toContain(
			GUIDE_PATH,
		);
		expect(existsSync(GUIDE_PATH), "the linked guide exists").toBe(true);
	});

	it("the marked example has no loopPolicy and rejects a fixer field", () => {
		const docBytes = readFileSync(GUIDE_PATH, "utf8");
		const parsed = JSON.parse(extractConfigExample(docBytes)) as Record<
			string,
			unknown
		>;
		expect(parsed).not.toHaveProperty("loopPolicy");
		const withFixer = {
			...parsed,
			loopPolicy: { fixer: "orchestrator" },
		};
		const result = validateConfig(withFixer);
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.errors.map(({ field }) => field)).toContain("loopPolicy");
	});
});
