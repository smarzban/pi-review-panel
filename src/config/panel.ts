import type { PlannedSeat } from "../run/types.js";
import {
	HOLISTIC_LENS,
	SHIPPED_LENSES,
	SPECIALIST_SEAT_CAP,
} from "./lenses.js";
import type { Config, RosterRow } from "./schema.js";

/**
 * Hard panel cap: the fully expanded panel is 1 through MAX_REVIEW_SEATS seats.
 * Defined here so the Panel Resolver owns the bound.
 */
export const MAX_REVIEW_SEATS = 16;

export type ResolvePanelInput = {
	/** Already shape-validated; this module does the semantic resolution. */
	config: Config;
	/** The package-owned lens table (loadLensTable output). */
	lensTable: Map<string, string>;
	/** Optional caller seat-alias selection; replaces only the seats dimension. */
	seats?: string[];
	/** Optional caller specialist extras; added to config always-on extras. */
	lenses?: string[];
};

const SHIPPED_LENS_SET = new Set<string>(SHIPPED_LENSES);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate a supplied dimension: non-empty array of non-empty strings.
 * Empty supplied arrays refuse.
 */
function assertSupplied(
	values: readonly string[],
	label: "Seats" | "Lenses",
): void {
	if (values.length === 0) {
		throw new Error(
			`Supplied ${label.toLowerCase()} must be a non-empty array of non-empty strings`,
		);
	}
}

/**
 * Resolve one seat dimension against the roster. Every alias must be a real
 * roster id, looked up through a Map (prototype-safe), and no alias may repeat.
 */
function resolveSeatAliases(
	aliases: readonly string[],
	rosterById: Map<string, RosterRow>,
): string[] {
	for (const [index, alias] of aliases.entries()) {
		if (!isNonEmptyString(alias)) {
			throw new Error(
				`Seat alias at index ${index} must be a non-empty string`,
			);
		}
	}

	const seen = new Set<string>();
	for (const alias of aliases) {
		if (seen.has(alias)) {
			throw new Error(`Duplicate seat alias "${alias}"`);
		}
		seen.add(alias);
		if (!rosterById.has(alias)) {
			throw new Error(`Unknown seat alias "${alias}"`);
		}
	}

	return [...aliases];
}

/**
 * Resolve specialist extra names. Holistic is implicit and refused here.
 * An empty list is allowed for omitted config extras.
 */
function resolveExtraLensNames(
	names: readonly string[],
	lensTable: Map<string, string>,
): string[] {
	for (const [index, name] of names.entries()) {
		if (!isNonEmptyString(name)) {
			throw new Error(`Lens name at index ${index} must be a non-empty string`);
		}
	}

	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			throw new Error(`Duplicate lens "${name}"`);
		}
		seen.add(name);
		if (name === HOLISTIC_LENS) {
			throw new Error(
				`Lens "${name}" is implicit on every review and cannot be selected as an extra`,
			);
		}
		if (!lensTable.has(name)) {
			throw new Error(`Unknown lens "${name}"`);
		}
		if (!SHIPPED_LENS_SET.has(name)) {
			throw new Error(`Lens "${name}" is not a shipped specialist extra`);
		}
	}

	return [...names];
}

function planSeat(
	row: RosterRow,
	lens: string,
	lensPrompt: string,
): PlannedSeat {
	const seat: PlannedSeat = {
		rosterId: row.id,
		provider: row.provider,
		model: row.model,
		lens,
		lensPrompt,
	};
	if (row.extraExtensionPaths !== undefined) {
		seat.extraExtensionPaths = row.extraExtensionPaths;
	}
	return seat;
}

function requireRow(
	rosterById: Map<string, RosterRow>,
	alias: string,
): RosterRow {
	const row = rosterById.get(alias);
	if (row === undefined) {
		throw new Error(`Unknown seat alias "${alias}"`);
	}
	return row;
}

function requirePrompt(lensTable: Map<string, string>, lens: string): string {
	const prompt = lensTable.get(lens);
	if (prompt === undefined) {
		throw new Error(`Unknown lens "${lens}"`);
	}
	return prompt;
}

/**
 * Resolve the discovery panel.
 *
 * Holistic × selected seats is always planned first. Config `defaults.lenses`
 * and caller `lenses` are specialist extras only. Each extra runs on at most
 * SPECIALIST_SEAT_CAP selected seats (the first N). Caller extras add to
 * config extras; a repeated name is kept once, in first-seen order.
 *
 * Both default dimensions are resolved before any caller override so a
 * caller override cannot hide an invalid default.
 */
export function resolvePanel({
	config,
	lensTable,
	seats,
	lenses,
}: ResolvePanelInput): PlannedSeat[] {
	const rosterById = new Map<string, RosterRow>();
	for (const row of config.roster) {
		rosterById.set(row.id, row);
	}

	const defaultSeats = resolveSeatAliases(config.defaults.seats, rosterById);
	const defaultExtras = resolveExtraLensNames(
		config.defaults.lenses ?? [],
		lensTable,
	);

	let selectedSeats = defaultSeats;
	if (seats !== undefined) {
		assertSupplied(seats, "Seats");
		selectedSeats = resolveSeatAliases(seats, rosterById);
	}

	let callerExtras: string[] = [];
	if (lenses !== undefined) {
		assertSupplied(lenses, "Lenses");
		callerExtras = resolveExtraLensNames(lenses, lensTable);
	}

	const extras: string[] = [];
	const seenExtra = new Set<string>();
	for (const name of [...defaultExtras, ...callerExtras]) {
		if (seenExtra.has(name)) {
			continue;
		}
		seenExtra.add(name);
		extras.push(name);
	}

	const holisticPrompt = requirePrompt(lensTable, HOLISTIC_LENS);
	const panel: PlannedSeat[] = [];
	for (const alias of selectedSeats) {
		panel.push(
			planSeat(requireRow(rosterById, alias), HOLISTIC_LENS, holisticPrompt),
		);
	}

	const specialistSeats = selectedSeats.slice(0, SPECIALIST_SEAT_CAP);
	for (const lens of extras) {
		const prompt = requirePrompt(lensTable, lens);
		for (const alias of specialistSeats) {
			panel.push(planSeat(requireRow(rosterById, alias), lens, prompt));
		}
	}

	if (panel.length < 1 || panel.length > MAX_REVIEW_SEATS) {
		throw new Error(
			`Panel expands to ${panel.length} seats; expected between 1 and ${MAX_REVIEW_SEATS}`,
		);
	}

	const seenIdentities = new Set<string>();
	for (const seat of panel) {
		const identity = JSON.stringify([seat.provider, seat.model, seat.lens]);
		if (seenIdentities.has(identity)) {
			throw new Error(
				`Duplicate seat identity: provider "${seat.provider}", model "${seat.model}", lens "${seat.lens}"`,
			);
		}
		seenIdentities.add(identity);
	}

	return panel;
}
