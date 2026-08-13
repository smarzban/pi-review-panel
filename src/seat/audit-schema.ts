/**
 * The claim-audit channel schema. One structured submission is a complete
 * array with exactly one row per expected consequential non-repair claim id.
 * Every row carries one `holds` decision and a non-empty rationale; missing,
 * duplicate, unknown, or malformed rows refuse the whole submission. The
 * expected ids are Claim Ledger accounting authority, never model input.
 */
export type AuditRow = {
	id: string;
	holds: boolean;
	rationale: string;
};

export type AuditValidationError = {
	row: number;
	field: string;
	message: string;
};

export type AuditValidationResult =
	| { ok: true; rows: AuditRow[] }
	| { ok: false; errors: AuditValidationError[] };

const auditFields = new Set(["id", "holds", "rationale"]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isAllowedField(key: PropertyKey): key is string {
	return typeof key === "string" && auditFields.has(key);
}

function validateShape(
	row: Record<string, unknown>,
	rowIndex: number,
	errors: AuditValidationError[],
): void {
	for (const key of Reflect.ownKeys(row)) {
		if (!isAllowedField(key)) {
			errors.push({
				row: rowIndex,
				field: String(key),
				message: "is not allowed",
			});
		}
	}

	for (
		let prototype = Object.getPrototypeOf(row);
		prototype !== null && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const key of Reflect.ownKeys(prototype)) {
			if (!isAllowedField(key)) {
				errors.push({
					row: rowIndex,
					field: String(key),
					message: "is not allowed",
				});
			}
		}
	}
}

export function validateAudit(
	input: unknown,
	expectedIds: readonly string[],
): AuditValidationResult {
	if (!Array.isArray(input)) {
		return {
			ok: false,
			errors: [{ row: -1, field: "rows", message: "must be an array" }],
		};
	}

	const errors: AuditValidationError[] = [];
	const rows: AuditRow[] = [];
	const expectedSet = new Set(expectedIds);
	const seen = new Set<string>();

	for (const [rowIndex, row] of input.entries()) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			errors.push({
				row: rowIndex,
				field: "row",
				message: "must be an object",
			});
			continue;
		}

		const rowErrorsBefore = errors.length;
		const auditRow = row as Record<string, unknown>;
		validateShape(auditRow, rowIndex, errors);

		const id = Object.hasOwn(auditRow, "id") ? auditRow.id : undefined;
		const holds = Object.hasOwn(auditRow, "holds") ? auditRow.holds : undefined;
		const rationale = Object.hasOwn(auditRow, "rationale")
			? auditRow.rationale
			: undefined;

		if (!isNonEmptyString(id)) {
			errors.push({
				row: rowIndex,
				field: "id",
				message: "must be a non-empty string",
			});
		} else if (!expectedSet.has(id)) {
			errors.push({
				row: rowIndex,
				field: "id",
				message: `unknown id "${id}"`,
			});
		} else if (seen.has(id)) {
			errors.push({
				row: rowIndex,
				field: "id",
				message: `duplicate id "${id}"`,
			});
		} else {
			seen.add(id);
		}

		if (typeof holds !== "boolean") {
			errors.push({
				row: rowIndex,
				field: "holds",
				message: "must be a boolean",
			});
		}
		if (!isNonEmptyString(rationale)) {
			errors.push({
				row: rowIndex,
				field: "rationale",
				message: "must be a non-empty string",
			});
		}

		if (errors.length === rowErrorsBefore) {
			rows.push({
				id: id as string,
				holds: holds as boolean,
				rationale: rationale as string,
			});
		}
	}

	for (const expectedId of expectedIds) {
		if (!seen.has(expectedId)) {
			errors.push({
				row: -1,
				field: "id",
				message: `missing expected id "${expectedId}"`,
			});
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, rows };
}

export function formatAuditErrors(errors: AuditValidationError[]): string {
	return errors
		.map(({ row, field, message }) =>
			row === -1 ? `${field} ${message}` : `row ${row}: ${field} ${message}`,
		)
		.join("\n");
}
