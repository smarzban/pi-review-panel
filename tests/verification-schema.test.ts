import { describe, expect, it } from "vitest";

import { validateVerification } from "../src/seat/verification-schema.js";

const expectedIds = ["src-1", "src-2"];

const validSubmission = {
	items: [
		{
			id: "src-1",
			disposition: "resolved",
			evidence: {
				file: "src/a.ts",
				explanation: "The repaired code guards the input.",
			},
		},
		{ id: "src-2", disposition: "still present" },
	],
	regressions: [],
};

describe("validateVerification", () => {
	it("accepts a complete submission covering every expected id exactly once", () => {
		expect(validateVerification(validSubmission, expectedIds, 1)).toEqual({
			ok: true,
			result: {
				items: validSubmission.items,
				regressions: [],
			},
		});
	});

	it("accepts all three dispositions and stamps trusted ids on regressions without model-authored ids", () => {
		const submission = {
			items: [
				{
					id: "src-1",
					disposition: "resolved",
					evidence: { file: "src/a.ts", explanation: "guarded now" },
				},
				{ id: "src-2", disposition: "inconclusive" },
			],
			regressions: [
				{
					file: "src/a.ts",
					line: 40,
					title: "Repair broke the fast path",
					evidence: "The new guard rejects previously valid input.",
				},
			],
		};

		const result = validateVerification(submission, expectedIds, 1);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result.regressions).toEqual([
				{
					regressionId: "regression-1-1",
					file: "src/a.ts",
					line: 40,
					title: "Repair broke the fast path",
					evidence: "The new guard rejects previously valid input.",
				},
			]);
		}
	});

	it("stamps loop-unique regression ids across cycles: same ordinal in later cycles never collides (AC-42)", () => {
		const regression = {
			file: "src/a.ts",
			line: 40,
			title: "Repair broke the fast path",
			evidence: "The new guard rejects previously valid input.",
		};
		const submission = {
			items: [
				{
					id: "src-1",
					disposition: "resolved",
					evidence: { file: "src/a.ts", explanation: "guarded now" },
				},
				{ id: "src-2", disposition: "still present" },
			],
			regressions: [regression],
		};

		const cycle1 = validateVerification(submission, expectedIds, 1);
		const cycle2 = validateVerification(submission, expectedIds, 2);
		const cycle3 = validateVerification(
			{ ...submission, regressions: [regression, regression] },
			expectedIds,
			3,
		);

		expect(cycle1.ok && cycle1.result.regressions[0].regressionId).toBe(
			"regression-1-1",
		);
		expect(cycle2.ok && cycle2.result.regressions[0].regressionId).toBe(
			"regression-2-1",
		);
		expect(
			cycle3.ok && cycle3.result.regressions.map((row) => row.regressionId),
		).toEqual(["regression-3-1", "regression-3-2"]);
	});

	it("refuses a resolved item without code evidence", () => {
		const result = validateVerification(
			{
				items: [
					{ id: "src-1", disposition: "resolved" },
					{ id: "src-2", disposition: "still present" },
				],
				regressions: [],
			},
			expectedIds,
			1,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.path.includes("evidence"))).toBe(true);
		}
	});

	it("refuses code evidence on a non-resolved item", () => {
		const result = validateVerification(
			{
				items: [
					{
						id: "src-1",
						disposition: "still present",
						evidence: { file: "src/a.ts", explanation: "not resolved" },
					},
					{ id: "src-2", disposition: "inconclusive" },
				],
				regressions: [],
			},
			expectedIds,
			1,
		);

		expect(result.ok).toBe(false);
	});

	it("refuses malformed code evidence", () => {
		const cases = [
			{
				name: "empty file",
				evidence: { file: " ", explanation: "a" },
			},
			{
				name: "empty explanation",
				evidence: { file: "src/a.ts", explanation: "  " },
			},
			{
				name: "unknown evidence field",
				evidence: { file: "src/a.ts", explanation: "a", proof: "x" },
			},
		];

		for (const testCase of cases) {
			const result = validateVerification(
				{
					items: [
						{
							id: "src-1",
							disposition: "resolved",
							evidence: testCase.evidence,
						},
						{ id: "src-2", disposition: "inconclusive" },
					],
					regressions: [],
				},
				expectedIds,
				1,
			);
			expect(result.ok, testCase.name).toBe(false);
		}
	});

	it("refuses missing, duplicate, or unknown item ids", () => {
		const base = {
			id: "src-1",
			disposition: "resolved",
			evidence: { file: "a", explanation: "b" },
		};

		const missing = validateVerification(
			{ items: [base], regressions: [] },
			expectedIds,
			1,
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.errors.some((e) => e.message.includes("missing"))).toBe(
				true,
			);
		}

		const duplicate = validateVerification(
			{
				items: [
					base,
					{ id: "src-1", disposition: "still present" },
					{ id: "src-2", disposition: "inconclusive" },
				],
				regressions: [],
			},
			expectedIds,
			1,
		);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) {
			expect(
				duplicate.errors.some((e) => e.message.includes("duplicate")),
			).toBe(true);
		}

		const unknown = validateVerification(
			{
				items: [
					base,
					{ id: "src-2", disposition: "inconclusive" },
					{ id: "nope", disposition: "still present" },
				],
				regressions: [],
			},
			expectedIds,
			1,
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) {
			expect(unknown.errors.some((e) => e.message.includes("unknown"))).toBe(
				true,
			);
		}
	});

	it("refuses an invalid disposition", () => {
		const result = validateVerification(
			{
				items: [
					{ id: "src-1", disposition: "fixed" },
					{ id: "src-2", disposition: "inconclusive" },
				],
				regressions: [],
			},
			expectedIds,
			1,
		);

		expect(result.ok).toBe(false);
	});

	it("refuses regression rows carrying model-authored ids", () => {
		const result = validateVerification(
			{
				...validSubmission,
				regressions: [
					{ id: "src-9", file: "src/a.ts", line: 1, title: "t", evidence: "e" },
				],
			},
			expectedIds,
			1,
		);

		expect(result.ok).toBe(false);
	});

	it("refuses malformed regression rows", () => {
		const cases = [
			{
				name: "zero line",
				row: { file: "src/a.ts", line: 0, title: "t", evidence: "e" },
			},
			{
				name: "fractional line",
				row: { file: "src/a.ts", line: 1.5, title: "t", evidence: "e" },
			},
			{
				name: "empty title",
				row: { file: "src/a.ts", line: 1, title: " ", evidence: "e" },
			},
			{
				name: "empty evidence",
				row: { file: "src/a.ts", line: 1, title: "t", evidence: "\t" },
			},
			{
				name: "missing file",
				row: { line: 1, title: "t", evidence: "e" },
			},
			{
				name: "unknown field",
				row: { file: "src/a.ts", line: 1, title: "t", evidence: "e", extra: 1 },
			},
		];

		for (const testCase of cases) {
			const result = validateVerification(
				{ ...validSubmission, regressions: [testCase.row] },
				expectedIds,
				1,
			);
			expect(result.ok, testCase.name).toBe(false);
		}
	});

	it("refuses prose or malformed payloads", () => {
		expect(validateVerification([], expectedIds, 1).ok).toBe(false);
		expect(validateVerification({ items: "nope" }, expectedIds, 1).ok).toBe(
			false,
		);
		expect(
			validateVerification({ items: validSubmission.items }, expectedIds, 1).ok,
		).toBe(false);
		expect(validateVerification(null, expectedIds, 1).ok).toBe(false);
	});
});
