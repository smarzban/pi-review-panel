import { describe, expect, it } from "vitest";

import { parseAddedLines } from "../src/run/changeset.js";
import { type Changeset, computeSuggestions } from "../src/run/suggest.js";

function changeset(
	files: string[],
	addedLines: Changeset["addedLines"] = [],
): Changeset {
	return { files, addedLines };
}

describe("computeSuggestions", () => {
	it("suggests migrations for SQL and migration directories", () => {
		const suggestions = computeSuggestions(
			changeset(["src/app.ts", "migrations/20260812_add.sql"]),
		);
		expect(suggestions.map((row) => row.lens)).toContain("migrations");
	});

	it("suggests security from added subprocess lines", () => {
		const suggestions = computeSuggestions(
			changeset(
				["src/run.ts"],
				[
					{
						file: "src/run.ts",
						line: 12,
						text: "child_process.execSync('git', args)",
					},
				],
			),
		);
		expect(suggestions.map((row) => row.lens)).toContain("security");
	});

	it("suggests tests when a code file changes", () => {
		const suggestions = computeSuggestions(changeset(["src/run.ts"]));
		expect(suggestions.map((row) => row.lens)).toContain("tests");
	});

	it("suggests tests when a change only adds or deletes test files", () => {
		for (const file of [
			"tests/pinned_preview.rs",
			"pkg/api_test.go",
			"test_mod.py",
		]) {
			const suggestions = computeSuggestions(changeset([file]));
			expect(
				suggestions.map((row) => row.lens),
				file,
			).toContain("tests");
		}
	});

	it("suggests tests when only a snapshot file changes", () => {
		const suggestions = computeSuggestions(
			changeset(["src/__snapshots__/render.test.ts.snap"]),
		);
		expect(suggestions.map((row) => row.lens)).toContain("tests");
	});

	it("gives a reason that holds when tests live inside source files", () => {
		const row = computeSuggestions(
			changeset(
				["src/lib.rs"],
				[{ file: "src/lib.rs", line: 40, text: "#[cfg(test)]" }],
			),
		).find((suggestion) => suggestion.lens === "tests");
		expect(row?.reason).toBe(
			"code changed: check coverage, and that each added, edited, or deleted test can fail and is worth keeping",
		);
	});

	it("does not suggest tests for docs or fixture-only changes", () => {
		const suggestions = computeSuggestions(
			changeset(["README.md", "tests/fixtures/run.json"]),
		);
		expect(suggestions.map((row) => row.lens)).not.toContain("tests");
	});

	it("suggests infrastructure, contracts, privacy, and specification paths", () => {
		const suggestions = computeSuggestions(
			changeset([
				".github/workflows/ci.yml",
				"openapi.yaml",
				"docs/privacy-policy.md",
				"docs/specs/feature.md",
			]),
		);
		expect(suggestions.map((row) => row.lens).sort()).toEqual([
			"contracts",
			"infrastructure",
			"privacy",
			"specification-conformance",
		]);
	});

	it("never emits a performance suggestion", () => {
		const suggestions = computeSuggestions(
			changeset(["src/hot.ts"], [{ file: "src/hot.ts", line: 1, text: "for" }]),
		);
		expect(suggestions.map((row) => row.lens)).not.toContain("performance");
	});
});

describe("parseAddedLines", () => {
	it("reads added lines and line numbers from a unified hunk", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -10,0 +11,2 @@",
			"+first",
			"+second",
			"",
		].join("\n");
		expect(parseAddedLines(diff)).toEqual([
			{ file: "src/a.ts", line: 11, text: "first" },
			{ file: "src/a.ts", line: 12, text: "second" },
		]);
	});
});
