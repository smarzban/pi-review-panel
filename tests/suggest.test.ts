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

	it("suggests tests when source changes with no recognized test additions", () => {
		const suggestions = computeSuggestions(changeset(["src/run.ts"]));
		expect(suggestions.map((row) => row.lens)).toContain("tests");
	});

	it("does not suggest tests when Rust tests/** files gain lines", () => {
		const suggestions = computeSuggestions(
			changeset(
				["src/lib.rs", "tests/pinned_preview.rs"],
				[
					{
						file: "tests/pinned_preview.rs",
						line: 1,
						text: "fn it_works() {}",
					},
				],
			),
		);
		expect(suggestions.map((row) => row.lens)).not.toContain("tests");
	});

	it("does not suggest tests when Go or Python test files gain lines", () => {
		const go = computeSuggestions(
			changeset(
				["pkg/api.go", "pkg/api_test.go"],
				[
					{
						file: "pkg/api_test.go",
						line: 1,
						text: "func TestX(t *testing.T) {}",
					},
				],
			),
		);
		const py = computeSuggestions(
			changeset(
				["mod.py", "test_mod.py"],
				[{ file: "test_mod.py", line: 1, text: "def test_ok(): pass" }],
			),
		);
		expect(go.map((row) => row.lens)).not.toContain("tests");
		expect(py.map((row) => row.lens)).not.toContain("tests");
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
