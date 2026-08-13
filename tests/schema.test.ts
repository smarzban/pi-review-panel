import { describe, expect, it } from "vitest";

import { validateFindings } from "../src/seat/schema.js";

describe("validateFindings", () => {
	it("reports each invalid row with its index and field", () => {
		const result = validateFindings([
			{
				line: 1,
				severity: "high",
				title: "Missing file",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 2,
				severity: "critical",
				title: "Bad severity",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: "3",
				severity: "high",
				title: "Non-numeric line",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 0,
				severity: "high",
				title: "Zero line",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: -1,
				severity: "high",
				title: "Negative line",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 1.5,
				severity: "high",
				title: "Fractional line",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 4,
				endLine: 3,
				severity: "high",
				title: "Earlier end line",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 8,
				severity: "high",
				title: "Unknown field",
				evidence: "Evidence",
				extra: true,
			},
			{
				file: "src/example.ts",
				line: 9,
				severity: "high",
				title: "  \t ",
				evidence: "Evidence",
			},
			{
				file: "src/example.ts",
				line: 10,
				severity: "high",
				title: "Whitespace evidence",
				evidence: "\n  ",
			},
		]);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ row: 0, field: "file" }),
				expect.objectContaining({ row: 1, field: "severity" }),
				expect.objectContaining({ row: 2, field: "line" }),
				expect.objectContaining({ row: 3, field: "line" }),
				expect.objectContaining({ row: 4, field: "line" }),
				expect.objectContaining({ row: 5, field: "line" }),
				expect.objectContaining({ row: 6, field: "endLine" }),
				expect.objectContaining({ row: 7, field: "extra" }),
				expect.objectContaining({ row: 8, field: "title" }),
				expect.objectContaining({ row: 9, field: "evidence" }),
			]),
		);
		expect(result.errors).toHaveLength(10);
	});

	it("rejects non-own required fields and hidden or inherited unknown fields", () => {
		const inheritedRequired = Object.create({
			file: "src/example.ts",
			line: 1,
			severity: "high",
			title: "Title",
			evidence: "Evidence",
		});
		const nonEnumerableUnknown = {
			file: "src/example.ts",
			line: 1,
			severity: "high",
			title: "Title",
			evidence: "Evidence",
		};
		Object.defineProperty(nonEnumerableUnknown, "hidden", { value: true });
		const inheritedUnknown = Object.assign(
			Object.create({ inherited: true }),
			nonEnumerableUnknown,
		);

		const result = validateFindings([
			inheritedRequired,
			nonEnumerableUnknown,
			inheritedUnknown,
		]);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ row: 0, field: "file" }),
				expect.objectContaining({ row: 0, field: "line" }),
				expect.objectContaining({ row: 0, field: "severity" }),
				expect.objectContaining({ row: 0, field: "title" }),
				expect.objectContaining({ row: 0, field: "evidence" }),
				expect.objectContaining({ row: 1, field: "hidden" }),
				expect.objectContaining({ row: 2, field: "inherited" }),
			]),
		);
	});

	it("rejects invalid endLine values", () => {
		const result = validateFindings(
			[1.5, 0, -1, "2", undefined].map((endLine) => ({
				file: "src/example.ts",
				line: 1,
				endLine,
				severity: "high",
				title: "Title",
				evidence: "Evidence",
			})),
		);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		expect(result.errors).toEqual(
			expect.arrayContaining(
				[0, 1, 2, 3, 4].map((row) =>
					expect.objectContaining({ row, field: "endLine" }),
				),
			),
		);
	});

	it("accepts valid findings with and without endLine", () => {
		const result = validateFindings([
			{
				file: "src/seat/schema.ts",
				line: 12,
				severity: "high",
				title: "Title",
				evidence: "Evidence",
			},
			{
				file: "src/seat/schema.ts",
				line: 20,
				endLine: 22,
				severity: "low",
				title: "Another title",
				evidence: "Another evidence",
			},
		]);

		expect(result).toEqual({
			ok: true,
			findings: [
				{
					file: "src/seat/schema.ts",
					line: 12,
					severity: "high",
					title: "Title",
					evidence: "Evidence",
				},
				{
					file: "src/seat/schema.ts",
					line: 20,
					endLine: 22,
					severity: "low",
					title: "Another title",
					evidence: "Another evidence",
				},
			],
		});
	});

	it("accepts an empty array", () => {
		expect(validateFindings([])).toEqual({ ok: true, findings: [] });
	});
});
