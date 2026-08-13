import { loadRoleTable } from "./roles.js";

/** Implicit discovery lens. Never listed in defaults.lenses or caller extras. */
export const HOLISTIC_LENS = "holistic";

/** Maximum roster seats that run one specialist extra. */
export const SPECIALIST_SEAT_CAP = 2;

/**
 * Selectable specialist extras. Holistic is implicit and is not in this list.
 * Claim-audit and fix-verification are check roles, never panel extras.
 */
export const SHIPPED_LENSES = [
	"correctness",
	"security",
	"tests",
	"contracts",
	"privacy",
	"migrations",
	"subtle-correctness",
	"simplification",
	"performance",
	"infrastructure",
	"specification-conformance",
] as const;

export type ShippedLens = (typeof SHIPPED_LENSES)[number];

/**
 * Prompt table for panel planning: holistic plus every selectable extra.
 * Values come from the single role registry so bytes stay identical to the
 * shipped prompt files.
 */
export function loadLensTable(): Map<string, string> {
	const roleTable = loadRoleTable();
	const table = new Map<string, string>();
	for (const lens of [HOLISTIC_LENS, ...SHIPPED_LENSES]) {
		const entry = roleTable.get(lens);
		if (entry === undefined) {
			throw new Error(
				`Lens registry refused: shipped lens role "${lens}" is missing from the role table`,
			);
		}
		table.set(lens, entry.prompt);
	}
	return table;
}
