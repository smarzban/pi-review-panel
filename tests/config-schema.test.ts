// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateConfig } from "../src/config/schema.js";

const absolutePath = path.resolve("provider-extension.ts");

type ValidConfig = {
	roster: Array<Record<string, unknown>>;
	defaults: Record<string, unknown>;
};

function validConfig(): ValidConfig {
	return {
		roster: [
			{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			{
				id: "claude",
				provider: "anthropic",
				model: "claude-opus-5",
				extraExtensionPaths: [absolutePath],
			},
		],
		defaults: {
			seats: ["terra", "claude"],
			lenses: ["correctness", "security", "tests"],
			seatBudgetMs: 1200000,
		},
	};
}

function without(
	document: Record<string, unknown>,
	...keys: string[]
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(document).filter(([key]) => !keys.includes(key)),
	);
}

type InvalidCase = {
	name: string;
	document: unknown;
	errors: Array<{ row: number; field: string }>;
};

const invalidCases: InvalidCase[] = [
	// Root container
	{
		name: "rejects a non-object document",
		document: "config",
		errors: [{ row: -1, field: "config" }],
	},
	{
		name: "rejects a null document",
		document: null,
		errors: [{ row: -1, field: "config" }],
	},
	{
		name: "rejects an array document",
		document: [],
		errors: [{ row: -1, field: "config" }],
	},
	// Root required and typed fields
	{
		name: "rejects a document missing roster",
		document: without(validConfig(), "roster"),
		errors: [{ row: -1, field: "roster" }],
	},
	{
		name: "rejects a string roster",
		document: { ...validConfig(), roster: "terra" },
		errors: [{ row: -1, field: "roster" }],
	},
	{
		name: "rejects an empty roster",
		document: { ...validConfig(), roster: [] },
		errors: [{ row: -1, field: "roster" }],
	},
	{
		name: "rejects a document missing defaults",
		document: without(validConfig(), "defaults"),
		errors: [{ row: -1, field: "defaults" }],
	},
	{
		name: "rejects a string defaults",
		document: { ...validConfig(), defaults: "config" },
		errors: [{ row: -1, field: "defaults" }],
	},
	{
		name: "rejects an array defaults",
		document: { ...validConfig(), defaults: [] },
		errors: [{ row: -1, field: "defaults" }],
	},
	{
		name: "rejects an empty defaults object",
		document: { ...validConfig(), defaults: {} },
		errors: [{ row: -1, field: "defaults.seats" }],
	},
	// Roster rows
	{
		name: "rejects a non-object roster row",
		document: { ...validConfig(), roster: [42] },
		errors: [{ row: 0, field: "roster[0]" }],
	},
	{
		name: "rejects a null roster row",
		document: { ...validConfig(), roster: [null] },
		errors: [{ row: 0, field: "roster[0]" }],
	},
	{
		name: "rejects an array roster row",
		document: { ...validConfig(), roster: [[]] },
		errors: [{ row: 0, field: "roster[0]" }],
	},
	{
		name: "rejects a roster row missing id",
		document: {
			...validConfig(),
			roster: [{ provider: "openai-codex", model: "gpt-5.6-terra" }],
		},
		errors: [{ row: 0, field: "roster[0].id" }],
	},
	{
		name: "rejects a roster row missing provider",
		document: {
			...validConfig(),
			roster: [{ id: "terra", model: "gpt-5.6-terra" }],
		},
		errors: [{ row: 0, field: "roster[0].provider" }],
	},
	{
		name: "rejects a roster row missing model",
		document: {
			...validConfig(),
			roster: [{ id: "terra", provider: "openai-codex" }],
		},
		errors: [{ row: 0, field: "roster[0].model" }],
	},
	{
		name: "rejects a numeric roster id",
		document: {
			...validConfig(),
			roster: [{ id: 42, provider: "openai-codex", model: "gpt-5.6-terra" }],
		},
		errors: [{ row: 0, field: "roster[0].id" }],
	},
	{
		name: "rejects a whitespace-only roster id",
		document: {
			...validConfig(),
			roster: [{ id: "   ", provider: "openai-codex", model: "gpt-5.6-terra" }],
		},
		errors: [{ row: 0, field: "roster[0].id" }],
	},
	{
		name: "rejects an empty roster provider",
		document: {
			...validConfig(),
			roster: [{ id: "terra", provider: "", model: "gpt-5.6-terra" }],
		},
		errors: [{ row: 0, field: "roster[0].provider" }],
	},
	{
		name: "rejects an empty roster model",
		document: {
			...validConfig(),
			roster: [{ id: "terra", provider: "openai-codex", model: "" }],
		},
		errors: [{ row: 0, field: "roster[0].model" }],
	},
	{
		name: "rejects a duplicate roster id",
		document: {
			...validConfig(),
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
				{ id: "terra", provider: "anthropic", model: "claude-opus-5" },
			],
		},
		errors: [{ row: 1, field: "roster[1].id" }],
	},
	{
		name: "rejects a string extraExtensionPaths",
		document: {
			...validConfig(),
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					extraExtensionPaths: absolutePath,
				},
			],
		},
		errors: [{ row: 0, field: "roster[0].extraExtensionPaths" }],
	},
	{
		name: "rejects a relative extraExtensionPaths entry",
		document: {
			...validConfig(),
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					extraExtensionPaths: ["provider-extension.ts"],
				},
			],
		},
		errors: [{ row: 0, field: "roster[0].extraExtensionPaths[0]" }],
	},
	{
		name: "rejects an empty extraExtensionPaths entry",
		document: {
			...validConfig(),
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					extraExtensionPaths: [""],
				},
			],
		},
		errors: [{ row: 0, field: "roster[0].extraExtensionPaths[0]" }],
	},
	{
		name: "rejects a non-string extraExtensionPaths entry",
		document: {
			...validConfig(),
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					extraExtensionPaths: [42],
				},
			],
		},
		errors: [{ row: 0, field: "roster[0].extraExtensionPaths[0]" }],
	},
	// Unknown fields at every level
	{
		name: "rejects an unknown root field lenses",
		document: { ...validConfig(), lenses: ["correctness"] },
		errors: [{ row: -1, field: "lenses" }],
	},
	{
		name: "rejects an unknown root field notes",
		document: { ...validConfig(), notes: "keep" },
		errors: [{ row: -1, field: "notes" }],
	},
	{
		name: "rejects an unknown root field credentials",
		document: { ...validConfig(), credentials: { apiKey: "secret" } },
		errors: [{ row: -1, field: "credentials" }],
	},
	{
		name: "rejects an unknown root field endpoints",
		document: { ...validConfig(), endpoints: [] },
		errors: [{ row: -1, field: "endpoints" }],
	},
	{
		name: "rejects an unknown root field provider (provider definitions)",
		document: { ...validConfig(), provider: { openai: {} } },
		errors: [{ row: -1, field: "provider" }],
	},
	{
		name: "rejects an unknown root prompt field",
		document: { ...validConfig(), systemPrompt: "prompt" },
		errors: [{ row: -1, field: "systemPrompt" }],
	},
	{
		name: "rejects an unknown roster row field",
		document: {
			...validConfig(),
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					lensName: "correctness",
				},
			],
		},
		errors: [{ row: 0, field: "lensName" }],
	},
	{
		name: "rejects an unknown defaults field",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, budget: 1000 },
		},
		errors: [{ row: -1, field: "budget" }],
	},
	// defaults.seats
	{
		name: "rejects defaults missing seats",
		document: {
			...validConfig(),
			defaults: without(validConfig().defaults, "seats"),
		},
		errors: [{ row: -1, field: "defaults.seats" }],
	},
	{
		name: "rejects empty defaults.seats",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: [] },
		},
		errors: [{ row: -1, field: "defaults.seats" }],
	},
	{
		name: "rejects a string defaults.seats (non-array)",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: "terra" },
		},
		errors: [{ row: -1, field: "defaults.seats" }],
	},
	{
		name: "rejects a non-string defaults.seats entry",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: [42] },
		},
		errors: [{ row: 0, field: "defaults.seats[0]" }],
	},
	{
		name: "rejects an empty defaults.seats entry",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: ["terra", ""] },
		},
		errors: [{ row: 1, field: "defaults.seats[1]" }],
	},
	{
		name: "rejects a whitespace-only defaults.seats entry",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: ["  "] },
		},
		errors: [{ row: 0, field: "defaults.seats[0]" }],
	},
	{
		name: "rejects a duplicate defaults.seats name",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seats: ["terra", "terra"] },
		},
		errors: [{ row: 1, field: "defaults.seats[1]" }],
	},
	// defaults.lenses
	{
		name: "rejects empty defaults.lenses",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, lenses: [] },
		},
		errors: [{ row: -1, field: "defaults.lenses" }],
	},
	{
		name: "rejects an object defaults.lenses (non-array)",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, lenses: { correctness: true } },
		},
		errors: [{ row: -1, field: "defaults.lenses" }],
	},
	{
		name: "rejects a non-string defaults.lenses entry",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, lenses: [42] },
		},
		errors: [{ row: 0, field: "defaults.lenses[0]" }],
	},
	{
		name: "rejects an empty defaults.lenses entry",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, lenses: [""] },
		},
		errors: [{ row: 0, field: "defaults.lenses[0]" }],
	},
	{
		name: "rejects a duplicate defaults.lenses name",
		document: {
			...validConfig(),
			defaults: {
				...validConfig().defaults,
				lenses: ["correctness", "correctness"],
			},
		},
		errors: [{ row: 1, field: "defaults.lenses[1]" }],
	},
	// seatBudgetMs
	{
		name: "rejects seatBudgetMs 0",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: 0 },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects seatBudgetMs 2147483648",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: 2147483648 },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects a fractional seatBudgetMs",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: 1.5 },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects seatBudgetMs Infinity",
		document: {
			...validConfig(),
			defaults: {
				...validConfig().defaults,
				seatBudgetMs: Number.POSITIVE_INFINITY,
			},
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects seatBudgetMs -Infinity",
		document: {
			...validConfig(),
			defaults: {
				...validConfig().defaults,
				seatBudgetMs: Number.NEGATIVE_INFINITY,
			},
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects a NaN seatBudgetMs",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: Number.NaN },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects a string seatBudgetMs",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: "1200000" },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
	{
		name: "rejects a negative seatBudgetMs",
		document: {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: -1 },
		},
		errors: [{ row: -1, field: "defaults.seatBudgetMs" }],
	},
];

describe("validateConfig", () => {
	it.each(invalidCases)("$name", ({ document, errors: expected }) => {
		const result = validateConfig(document);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		const actual = result.errors.map(({ row, field }) => ({ row, field }));
		expect(actual).toEqual(expect.arrayContaining(expected));
		expect(actual).toHaveLength(expected.length);
	});

	it("rejects inherited and non-enumerable unknown fields and inherited required fields", () => {
		const doc = Object.assign(
			Object.create({ inherited: true }),
			validConfig(),
		);
		Object.defineProperty(doc, "hidden", { value: true });
		doc.roster = [
			Object.create({
				id: "terra",
				provider: "openai-codex",
				model: "gpt-5.6-terra",
			}),
		];

		const result = validateConfig(doc);

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ row: -1, field: "inherited" }),
				expect.objectContaining({ row: -1, field: "hidden" }),
				expect.objectContaining({ row: 0, field: "roster[0].id" }),
				expect.objectContaining({ row: 0, field: "roster[0].provider" }),
				expect.objectContaining({ row: 0, field: "roster[0].model" }),
			]),
		);
	});

	it("names the duplicated id in the duplicate-roster-id refusal", () => {
		const result = validateConfig({
			...validConfig(),
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
				{ id: "terra", provider: "anthropic", model: "claude-opus-5" },
			],
		});

		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}

		const duplicate = result.errors.find(
			({ field }) => field === "roster[1].id",
		);
		expect(duplicate?.message).toContain('"terra"');
	});

	it("is all-or-nothing: refuses the whole document when any row is invalid", () => {
		const result = validateConfig({
			...validConfig(),
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
				{ id: "claude", provider: "anthropic" },
			],
		});

		expect(result).toMatchObject({ ok: false });
		expect(result).not.toHaveProperty("config");
		if (result.ok) {
			return;
		}

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ row: 1, field: "roster[1].model" }),
			]),
		);
	});

	it("accepts the normative compact shape", () => {
		const document = validConfig();
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});

	it("accepts a minimal config without optional fields", () => {
		const document = {
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			],
			defaults: { seats: ["terra"] },
		};
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});

	it("accepts defaults that omit lenses", () => {
		const document = {
			...validConfig(),
			defaults: without(validConfig().defaults, "lenses"),
		};
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});

	it("accepts an empty extraExtensionPaths array", () => {
		const document = {
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					extraExtensionPaths: [],
				},
			],
			defaults: { seats: ["terra"], lenses: ["correctness"] },
		};
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});

	it("carries provider, model, and id strings byte-for-byte without trimming", () => {
		const document = {
			roster: [
				{
					id: " terra ",
					provider: " openai-codex ",
					model: " gpt-5.6-terra ",
				},
			],
			defaults: { seats: [" terra "], lenses: [" correctness "] },
		};
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});

	it("accepts seatBudgetMs at the inclusive upper bound", () => {
		const document = {
			...validConfig(),
			defaults: { ...validConfig().defaults, seatBudgetMs: 2147483647 },
		};
		expect(validateConfig(document)).toEqual({ ok: true, config: document });
	});
});

describe("validateConfig unknown root fields", () => {
	it("refuses loopPolicy as an unknown root field", () => {
		const result = validateConfig({
			...validConfig(),
			loopPolicy: { auditSeat: "terra" },
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) {
			return;
		}
		expect(result.errors.map(({ field }) => field)).toContain("loopPolicy");
	});
});
