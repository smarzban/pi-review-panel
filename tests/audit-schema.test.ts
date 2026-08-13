import { describe, expect, it } from "vitest";

import { validateAudit } from "../src/seat/audit-schema.js";

const expectedIds = ["claim-1", "claim-2", "claim-3"];

const validRows = [
	{
		id: "claim-1",
		holds: true,
		rationale: "The dismissal reason matches the code.",
	},
	{
		id: "claim-2",
		holds: false,
		rationale: "The code contradicts the dismissal reason.",
	},
	{
		id: "claim-3",
		holds: true,
		rationale: "The dismissed concern is out of scope.",
	},
];

describe("validateAudit", () => {
	it("accepts a complete submission with exactly one row per expected id", () => {
		expect(validateAudit(validRows, expectedIds)).toEqual({
			ok: true,
			rows: validRows,
		});
	});

	it("accepts an empty submission for an empty expected set", () => {
		expect(validateAudit([], [])).toEqual({ ok: true, rows: [] });
	});

	it("refuses a submission missing an expected id", () => {
		const result = validateAudit(
			[
				{ id: "run-1/f-1", holds: true, rationale: "a" },
				{ id: "run-1/f-2", holds: true, rationale: "b" },
			],
			expectedIds,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.message.includes("missing"))).toBe(
				true,
			);
		}
	});

	it("refuses a duplicate id", () => {
		const result = validateAudit(
			[
				{ id: "claim-1", holds: true, rationale: "a" },
				{ id: "claim-1", holds: false, rationale: "b" },
				{ id: "claim-2", holds: true, rationale: "c" },
				{ id: "claim-3", holds: true, rationale: "d" },
			],
			expectedIds,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.message.includes("duplicate"))).toBe(
				true,
			);
		}
	});

	it("refuses an unknown id", () => {
		const result = validateAudit(
			[
				{ id: "run-1/f-1", holds: true, rationale: "a" },
				{ id: "run-1/f-2", holds: true, rationale: "b" },
				{ id: "run-1/f-3", holds: true, rationale: "c" },
				{ id: "mystery", holds: true, rationale: "d" },
			],
			expectedIds,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.message.includes("unknown"))).toBe(
				true,
			);
		}
	});

	it("refuses prose that is not an array", () => {
		const result = validateAudit({ holds: true }, expectedIds);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]?.message).toContain("array");
		}
	});

	it("refuses malformed rows and required-field violations", () => {
		const cases = [
			{
				name: "null row",
				rows: [null],
			},
			{
				name: "non-object row",
				rows: ["run-1/f-1"],
			},
			{
				name: "non-boolean holds",
				rows: [{ id: "run-1/f-1", holds: "yes", rationale: "a" }],
			},
			{
				name: "missing holds",
				rows: [{ id: "run-1/f-1", rationale: "a" }],
			},
			{
				name: "empty rationale",
				rows: [{ id: "run-1/f-1", holds: true, rationale: " \t" }],
			},
			{
				name: "missing rationale",
				rows: [{ id: "run-1/f-1", holds: true }],
			},
			{
				name: "non-string id",
				rows: [{ id: 7, holds: true, rationale: "a" }],
			},
			{
				name: "unknown field",
				rows: [{ id: "run-1/f-1", holds: true, rationale: "a", extra: 1 }],
			},
		];

		for (const testCase of cases) {
			const result = validateAudit(testCase.rows, expectedIds);
			expect(result.ok, testCase.name).toBe(false);
		}
	});
});
