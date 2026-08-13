import { describe, expect, it } from "vitest";

import { HOLISTIC_LENS, SPECIALIST_SEAT_CAP } from "../src/config/lenses.js";
import { MAX_REVIEW_SEATS, resolvePanel } from "../src/config/panel.js";
import type { Config } from "../src/config/schema.js";

const LENS_PROMPTS: Record<string, string> = {
	holistic: "PROMPT_HOLISTIC",
	correctness: "PROMPT_CORRECTNESS",
	security: "PROMPT_SECURITY",
	tests: "PROMPT_TESTS",
	contracts: "PROMPT_CONTRACTS",
};

function lensTable(): Map<string, string> {
	return new Map(Object.entries(LENS_PROMPTS));
}

function config(): Config {
	return {
		roster: [
			{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			{
				id: "claude",
				provider: "anthropic",
				model: "claude-opus-5",
				extraExtensionPaths: ["/absolute/provider-extension.ts"],
			},
		],
		defaults: {
			seats: ["terra", "claude"],
		},
	};
}

function countConfig(count: number): Config {
	return {
		roster: Array.from({ length: count }, (_, i) => ({
			id: `s${i}`,
			provider: "provider",
			model: `model-${i}`,
		})),
		defaults: {
			seats: Array.from({ length: count }, (_, i) => `s${i}`),
		},
	};
}

function refusal(fn: () => unknown): Error {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	return error as Error;
}

describe("resolvePanel", () => {
	it("plans holistic times default seats when no extras are configured", () => {
		const panel = resolvePanel({ config: config(), lensTable: lensTable() });

		expect(panel).toHaveLength(2);
		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "terra"],
			[HOLISTIC_LENS, "claude"],
		]);
		expect(panel[0]).toEqual({
			rosterId: "terra",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: HOLISTIC_LENS,
			lensPrompt: "PROMPT_HOLISTIC",
		});
		expect(panel[1]?.extraExtensionPaths).toEqual([
			"/absolute/provider-extension.ts",
		]);
	});

	it("adds configured extras on at most two seats", () => {
		const panel = resolvePanel({
			config: {
				...config(),
				defaults: {
					seats: ["terra", "claude"],
					lenses: ["security", "tests"],
				},
			},
			lensTable: lensTable(),
		});

		expect(SPECIALIST_SEAT_CAP).toBe(2);
		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "terra"],
			[HOLISTIC_LENS, "claude"],
			["security", "terra"],
			["security", "claude"],
			["tests", "terra"],
			["tests", "claude"],
		]);
	});

	it("caps a specialist extra at the first two selected seats", () => {
		const three: Config = {
			roster: [
				{ id: "a", provider: "p", model: "m-a" },
				{ id: "b", provider: "p", model: "m-b" },
				{ id: "c", provider: "p", model: "m-c" },
			],
			defaults: { seats: ["a", "b", "c"], lenses: ["security"] },
		};

		const panel = resolvePanel({ config: three, lensTable: lensTable() });

		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "a"],
			[HOLISTIC_LENS, "b"],
			[HOLISTIC_LENS, "c"],
			["security", "a"],
			["security", "b"],
		]);
	});

	it("replaces only the seats dimension when seats are supplied", () => {
		const panel = resolvePanel({
			config: {
				...config(),
				defaults: { seats: ["terra", "claude"], lenses: ["security"] },
			},
			lensTable: lensTable(),
			seats: ["claude"],
		});

		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "claude"],
			["security", "claude"],
		]);
	});

	it("adds caller lenses to holistic without dropping default extras", () => {
		const panel = resolvePanel({
			config: {
				...config(),
				defaults: { seats: ["terra", "claude"], lenses: ["tests"] },
			},
			lensTable: lensTable(),
			lenses: ["security"],
		});

		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "terra"],
			[HOLISTIC_LENS, "claude"],
			["tests", "terra"],
			["tests", "claude"],
			["security", "terra"],
			["security", "claude"],
		]);
	});

	it("dedupes a caller extra that is already a default extra", () => {
		const panel = resolvePanel({
			config: {
				...config(),
				defaults: { seats: ["terra"], lenses: ["security"] },
			},
			lensTable: lensTable(),
			lenses: ["security"],
		});

		expect(panel.map((seat) => [seat.lens, seat.rosterId])).toEqual([
			[HOLISTIC_LENS, "terra"],
			["security", "terra"],
		]);
	});

	it("accepts a shipped specialist that used to be loop-only", () => {
		const panel = resolvePanel({
			config: config(),
			lensTable: lensTable(),
			lenses: ["contracts"],
		});

		expect(panel.map((seat) => seat.lens)).toEqual([
			HOLISTIC_LENS,
			HOLISTIC_LENS,
			"contracts",
			"contracts",
		]);
	});

	it("preserves whitespace bytes in provider, model, and lens prompt", () => {
		const padded: Config = {
			roster: [
				{
					id: "terra",
					provider: " openai-codex ",
					model: " gpt-5.6-terra ",
				},
			],
			defaults: { seats: ["terra"], lenses: ["correctness"] },
		};
		const table = new Map([
			[HOLISTIC_LENS, "HOLISTIC"],
			["correctness", "\n  prompt with  spaces\t"],
		]);

		const panel = resolvePanel({ config: padded, lensTable: table });

		expect(panel).toHaveLength(2);
		expect(panel[0]?.provider).toBe(" openai-codex ");
		expect(panel[0]?.model).toBe(" gpt-5.6-terra ");
		expect(panel[0]?.lensPrompt).toBe("HOLISTIC");
		expect(panel[1]?.lensPrompt).toBe("\n  prompt with  spaces\t");
	});

	it("refuses an unknown seat alias and names the alias", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				seats: ["ghost"],
			}),
		);

		expect(error.message).toContain("ghost");
		expect(error.message).toMatch(/alias/i);
	});

	it("refuses an unknown lens and names the lens", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: ["ghost"],
			}),
		);

		expect(error.message).toContain("ghost");
		expect(error.message).toMatch(/lens/i);
	});

	it("refuses holistic as a caller extra", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: [HOLISTIC_LENS],
			}),
		);

		expect(error.message).toContain(HOLISTIC_LENS);
		expect(error.message).toMatch(/implicit/i);
	});

	it("does not resolve the prototype-hostile lens name constructor", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: ["constructor"],
			}),
		);

		expect(error.message).toContain("constructor");
	});

	it("does not resolve the prototype-hostile lens name __proto__", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: ["__proto__"],
			}),
		);

		expect(error.message).toContain("__proto__");
	});

	it("refuses an unknown seat alias in config defaults", () => {
		const badConfig = {
			...config(),
			defaults: { ...config().defaults, seats: ["ghost", "claude"] },
		};

		const error = refusal(() =>
			resolvePanel({ config: badConfig, lensTable: lensTable() }),
		);

		expect(error.message).toContain("ghost");
	});

	it("refuses an unknown lens name in config defaults", () => {
		const badConfig = {
			...config(),
			defaults: {
				...config().defaults,
				lenses: ["correctness", "ghost"],
			},
		};

		const error = refusal(() =>
			resolvePanel({ config: badConfig, lensTable: lensTable() }),
		);

		expect(error.message).toContain("ghost");
	});

	it("a valid caller override cannot hide an invalid default seat", () => {
		const badConfig = {
			...config(),
			defaults: { ...config().defaults, seats: ["ghost", "claude"] },
		};

		const error = refusal(() =>
			resolvePanel({
				config: badConfig,
				lensTable: lensTable(),
				seats: ["terra"],
				lenses: ["correctness"],
			}),
		);

		expect(error.message).toContain("ghost");
	});

	it("a valid caller override cannot hide an invalid default lens", () => {
		const badConfig = {
			...config(),
			defaults: { ...config().defaults, lenses: ["ghost"] },
		};

		const error = refusal(() =>
			resolvePanel({
				config: badConfig,
				lensTable: lensTable(),
				seats: ["terra"],
				lenses: ["correctness"],
			}),
		);

		expect(error.message).toContain("ghost");
	});

	it("refuses an empty supplied seats array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				seats: [],
			}),
		);

		expect(error.message).toMatch(/seats/i);
	});

	it("refuses an empty supplied lenses array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: [],
			}),
		);

		expect(error.message).toMatch(/lenses/i);
	});

	it("refuses a non-string item in a supplied seats array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				seats: ["terra", 42 as unknown as string],
			}),
		);

		expect(error.message).toMatch(/string/i);
	});

	it("refuses an empty-string item in a supplied seats array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				seats: ["terra", ""],
			}),
		);

		expect(error.message).toMatch(/string/i);
	});

	it("refuses duplicate aliases in a supplied seats array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				seats: ["terra", "terra"],
			}),
		);

		expect(error.message).toContain("terra");
		expect(error.message).toMatch(/duplicate/i);
	});

	it("refuses duplicate names in a supplied lenses array", () => {
		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: lensTable(),
				lenses: ["correctness", "correctness"],
			}),
		);

		expect(error.message).toContain("correctness");
		expect(error.message).toMatch(/duplicate/i);
	});

	it("refuses repeated aliases in config default seats", () => {
		const badConfig = {
			...config(),
			defaults: { ...config().defaults, seats: ["terra", "terra"] },
		};

		const error = refusal(() =>
			resolvePanel({ config: badConfig, lensTable: lensTable() }),
		);

		expect(error.message).toContain("terra");
		expect(error.message).toMatch(/duplicate/i);
	});

	it("refuses zero rows from an empty default seats dimension", () => {
		const badConfig = {
			...config(),
			defaults: { ...config().defaults, seats: [] },
		};

		const error = refusal(() =>
			resolvePanel({ config: badConfig, lensTable: lensTable() }),
		);

		expect(error.message).toMatch(/alias|string|panel/i);
	});

	it("accepts exactly MAX_REVIEW_SEATS holistic seats", () => {
		expect(MAX_REVIEW_SEATS).toBe(16);

		const panel = resolvePanel({
			config: countConfig(16),
			lensTable: lensTable(),
		});

		expect(panel).toHaveLength(16);
	});

	it("refuses an expansion of 17 seats", () => {
		const error = refusal(() =>
			resolvePanel({ config: countConfig(17), lensTable: lensTable() }),
		);

		expect(error.message).toContain("16");
		expect(error.message).toMatch(/panel/i);
	});

	it("refuses distinct roster aliases resolving to the same exact provider/model/lens", () => {
		const duplicate: Config = {
			roster: [
				{ id: "a", provider: "openai-codex", model: "gpt-5.6-terra" },
				{ id: "b", provider: "openai-codex", model: "gpt-5.6-terra" },
			],
			defaults: { seats: ["a", "b"] },
		};

		const error = refusal(() =>
			resolvePanel({ config: duplicate, lensTable: lensTable() }),
		);

		expect(error.message).toContain("openai-codex");
		expect(error.message).toContain("gpt-5.6-terra");
		expect(error.message).toContain(HOLISTIC_LENS);
		expect(error.message).toMatch(/duplicate/i);
	});

	it("refuses a check role even when the table carries it", () => {
		const table = lensTable();
		table.set("claim-audit", "PROMPT_AUDIT");

		const error = refusal(() =>
			resolvePanel({
				config: config(),
				lensTable: table,
				lenses: ["claim-audit"],
			}),
		);

		expect(error.message).toContain("claim-audit");
		expect(error.message).toMatch(/lens/i);
	});
});
