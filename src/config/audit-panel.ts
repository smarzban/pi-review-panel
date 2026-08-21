import type { PlannedSeat } from "../run/types.js";
import { AUDIT_DEFAULT_PASSES, AUDIT_PASSES } from "./audit-passes.js";
import type { Config, RosterRow } from "./schema.js";

/** Default audit coverage is two owner-selected seats, with a bounded third. */
export const DEFAULT_AUDIT_SEATS = 2;
export const MAX_AUDIT_SEATS_PER_PASS = 3;
export const MAX_AUDIT_SEATS = 24;

export type ResolveAuditPanelInput = {
	config: Config;
	passTable: Map<string, string>;
	passes?: string[];
	seats?: string[];
};

const PASS_SET = new Set<string>(AUDIT_PASSES);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function resolveAliases(
	aliases: readonly string[],
	roster: Map<string, RosterRow>,
): string[] {
	if (aliases.length === 0) {
		throw new Error(
			"Audit seats must be a non-empty array of non-empty strings",
		);
	}
	const seen = new Set<string>();
	for (const [index, alias] of aliases.entries()) {
		if (!isNonEmptyString(alias)) {
			throw new Error(
				`Audit seat alias at index ${index} must be a non-empty string`,
			);
		}
		if (seen.has(alias)) {
			throw new Error(`Duplicate audit seat alias "${alias}"`);
		}
		if (!roster.has(alias)) {
			throw new Error(`Unknown audit seat alias "${alias}"`);
		}
		seen.add(alias);
	}
	return [...aliases];
}

function resolvePasses(
	passes: readonly string[],
	passTable: Map<string, string>,
): string[] {
	if (passes.length === 0) {
		throw new Error(
			"Audit passes must be a non-empty array of non-empty strings",
		);
	}
	const seen = new Set<string>();
	for (const [index, pass] of passes.entries()) {
		if (!isNonEmptyString(pass)) {
			throw new Error(
				`Audit pass at index ${index} must be a non-empty string`,
			);
		}
		if (seen.has(pass)) {
			throw new Error(`Duplicate audit pass "${pass}"`);
		}
		if (!PASS_SET.has(pass) || !passTable.has(pass)) {
			throw new Error(`Unknown audit pass "${pass}"`);
		}
		seen.add(pass);
	}
	return [...passes];
}

function planSeat(
	row: RosterRow,
	pass: string,
	lensPrompt: string,
): PlannedSeat {
	return {
		rosterId: row.id,
		provider: row.provider,
		model: row.model,
		lens: pass,
		lensPrompt,
		...(row.extraExtensionPaths === undefined
			? {}
			: { extraExtensionPaths: row.extraExtensionPaths }),
	};
}

/**
 * Plans only package-owned audit passes. Omitted seats use the first two
 * owner-default roster rows; a caller can request up to three exact rows for
 * a justified broader pass. Explicit passes replace the baseline menu.
 */
export function resolveAuditPanel({
	config,
	passTable,
	passes,
	seats,
}: ResolveAuditPanelInput): PlannedSeat[] {
	const roster = new Map(config.roster.map((row) => [row.id, row]));
	const defaults = resolveAliases(config.defaults.seats, roster);
	if (seats !== undefined && seats.length > MAX_AUDIT_SEATS_PER_PASS) {
		throw new Error(
			`Audit selects ${seats.length} seats per pass; expected at most ${MAX_AUDIT_SEATS_PER_PASS}`,
		);
	}
	const selectedSeats =
		seats === undefined
			? defaults.slice(0, DEFAULT_AUDIT_SEATS)
			: resolveAliases(seats, roster);
	if (seats === undefined && selectedSeats.length < DEFAULT_AUDIT_SEATS) {
		throw new Error("Audit requires at least two configured default seats");
	}
	const selectedPasses = resolvePasses(
		passes === undefined ? AUDIT_DEFAULT_PASSES : passes,
		passTable,
	);
	const panel: PlannedSeat[] = [];
	for (const pass of selectedPasses) {
		const prompt = passTable.get(pass);
		if (prompt === undefined) {
			throw new Error(`Unknown audit pass "${pass}"`);
		}
		for (const alias of selectedSeats) {
			const row = roster.get(alias);
			if (row === undefined) {
				throw new Error(`Unknown audit seat alias "${alias}"`);
			}
			panel.push(planSeat(row, pass, prompt));
		}
	}
	if (panel.length > MAX_AUDIT_SEATS) {
		throw new Error(
			`Audit expands to ${panel.length} seats; expected at most ${MAX_AUDIT_SEATS}`,
		);
	}
	const identities = new Set<string>();
	for (const seat of panel) {
		const identity = JSON.stringify([seat.provider, seat.model, seat.lens]);
		if (identities.has(identity)) {
			throw new Error(
				`Duplicate audit seat identity: provider "${seat.provider}", model "${seat.model}", pass "${seat.lens}"`,
			);
		}
		identities.add(identity);
	}
	return panel;
}
