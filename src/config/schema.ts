// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

export type RosterRow = {
	id: string;
	provider: string;
	model: string;
	extraExtensionPaths?: string[];
};

export type ConfigDefaults = {
	seats: string[];
	/** Optional always-on specialist extras. Omitted means holistic only. */
	lenses?: string[];
	seatBudgetMs?: number;
};

export type Config = {
	roster: RosterRow[];
	defaults: ConfigDefaults;
};

export type ConfigError = {
	row: number;
	field: string;
	message: string;
};

export type ConfigResult =
	| { ok: true; config: Config }
	| { ok: false; errors: ConfigError[] };

const rootFields = new Set(["roster", "defaults"]);
const rosterFields = new Set([
	"id",
	"provider",
	"model",
	"extraExtensionPaths",
]);
const defaultsFields = new Set(["seats", "lenses", "seatBudgetMs"]);

const MAX_SEAT_BUDGET_MS = 2147483647;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isSeatBudget(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_SEAT_BUDGET_MS
	);
}

function rejectUnknownFields(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	row: number,
	errors: ConfigError[],
): void {
	for (const key of Reflect.ownKeys(obj)) {
		if (typeof key !== "string" || !allowed.has(key)) {
			errors.push({ row, field: String(key), message: "is not allowed" });
		}
	}

	for (
		let prototype = Object.getPrototypeOf(obj);
		prototype !== null && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const key of Reflect.ownKeys(prototype)) {
			if (typeof key !== "string" || !allowed.has(key)) {
				errors.push({ row, field: String(key), message: "is not allowed" });
			}
		}
	}
}

function validateStringList(
	defaults: Record<string, unknown>,
	key: "seats" | "lenses",
	errors: ConfigError[],
): void {
	const field = `defaults.${key}`;
	if (!Object.hasOwn(defaults, key)) {
		errors.push({ row: -1, field, message: "is required" });
		return;
	}

	const value = defaults[key];
	if (!Array.isArray(value) || value.length === 0) {
		errors.push({
			row: -1,
			field,
			message: "must be a non-empty array of non-empty strings",
		});
		return;
	}

	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		if (!isNonEmptyString(item)) {
			errors.push({
				row: index,
				field: `${field}[${index}]`,
				message: "must be a non-empty string",
			});
		} else if (seen.has(item)) {
			errors.push({
				row: index,
				field: `${field}[${index}]`,
				message: "must not repeat an earlier name",
			});
		} else {
			seen.add(item);
		}
	}
}

export function validateConfig(document: unknown): ConfigResult {
	if (!isObject(document)) {
		return {
			ok: false,
			errors: [{ row: -1, field: "config", message: "must be an object" }],
		};
	}

	const errors: ConfigError[] = [];
	rejectUnknownFields(document, rootFields, -1, errors);

	if (!Object.hasOwn(document, "roster")) {
		errors.push({ row: -1, field: "roster", message: "is required" });
	} else if (!Array.isArray(document.roster) || document.roster.length === 0) {
		errors.push({
			row: -1,
			field: "roster",
			message: "must be a non-empty array of roster rows",
		});
	} else {
		const seenIds = new Set<string>();
		for (const [rowIndex, row] of document.roster.entries()) {
			if (!isObject(row)) {
				errors.push({
					row: rowIndex,
					field: `roster[${rowIndex}]`,
					message: "must be an object",
				});
				continue;
			}

			rejectUnknownFields(row, rosterFields, rowIndex, errors);

			const id = Object.hasOwn(row, "id") ? row.id : undefined;
			const provider = Object.hasOwn(row, "provider")
				? row.provider
				: undefined;
			const model = Object.hasOwn(row, "model") ? row.model : undefined;
			const extraExtensionPaths = Object.hasOwn(row, "extraExtensionPaths")
				? row.extraExtensionPaths
				: undefined;

			if (!isNonEmptyString(id)) {
				errors.push({
					row: rowIndex,
					field: `roster[${rowIndex}].id`,
					message: "must be a non-empty string",
				});
			} else if (seenIds.has(id)) {
				errors.push({
					row: rowIndex,
					field: `roster[${rowIndex}].id`,
					message: `must be unique across the roster (duplicated id: "${id}")`,
				});
			} else {
				seenIds.add(id);
			}

			if (!isNonEmptyString(provider)) {
				errors.push({
					row: rowIndex,
					field: `roster[${rowIndex}].provider`,
					message: "must be a non-empty string",
				});
			}

			if (!isNonEmptyString(model)) {
				errors.push({
					row: rowIndex,
					field: `roster[${rowIndex}].model`,
					message: "must be a non-empty string",
				});
			}

			if (Object.hasOwn(row, "extraExtensionPaths")) {
				if (!Array.isArray(extraExtensionPaths)) {
					errors.push({
						row: rowIndex,
						field: `roster[${rowIndex}].extraExtensionPaths`,
						message: "must be an array of absolute paths",
					});
				} else {
					for (const [pathIndex, item] of extraExtensionPaths.entries()) {
						if (!isNonEmptyString(item) || !path.isAbsolute(item)) {
							errors.push({
								row: rowIndex,
								field: `roster[${rowIndex}].extraExtensionPaths[${pathIndex}]`,
								message: "must be a non-empty absolute path",
							});
						}
					}
				}
			}
		}
	}

	if (!Object.hasOwn(document, "defaults")) {
		errors.push({ row: -1, field: "defaults", message: "is required" });
	} else if (!isObject(document.defaults)) {
		errors.push({ row: -1, field: "defaults", message: "must be an object" });
	} else {
		const defaults = document.defaults;
		rejectUnknownFields(defaults, defaultsFields, -1, errors);
		validateStringList(defaults, "seats", errors);
		if (Object.hasOwn(defaults, "lenses")) {
			validateStringList(defaults, "lenses", errors);
		}

		if (Object.hasOwn(defaults, "seatBudgetMs")) {
			if (!isSeatBudget(defaults.seatBudgetMs)) {
				errors.push({
					row: -1,
					field: "defaults.seatBudgetMs",
					message: "must be an integer from 1 through 2147483647",
				});
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const defaultsRecord = document.defaults as Record<string, unknown>;
	const configDefaults: ConfigDefaults = {
		seats: defaultsRecord.seats as string[],
	};
	if (Object.hasOwn(defaultsRecord, "lenses")) {
		configDefaults.lenses = defaultsRecord.lenses as string[];
	}
	if (Object.hasOwn(defaultsRecord, "seatBudgetMs")) {
		configDefaults.seatBudgetMs = defaultsRecord.seatBudgetMs as number;
	}

	const config: Config = {
		roster: (document.roster as unknown[]).map((row) => {
			const rosterRow = row as Record<string, unknown>;
			const result: RosterRow = {
				id: rosterRow.id as string,
				provider: rosterRow.provider as string,
				model: rosterRow.model as string,
			};
			if (Object.hasOwn(rosterRow, "extraExtensionPaths")) {
				result.extraExtensionPaths = rosterRow.extraExtensionPaths as string[];
			}
			return result;
		}),
		defaults: configDefaults,
	};

	return { ok: true, config };
}
