export type Finding = {
	file: string;
	line: number;
	severity: "high" | "medium" | "low";
	title: string;
	evidence: string;
	endLine?: number;
};

type ValidationError = {
	row: number;
	field: string;
	message: string;
};

type ValidationResult =
	| { ok: true; findings: Finding[] }
	| { ok: false; errors: ValidationError[] };

const fields = new Set([
	"file",
	"line",
	"severity",
	"title",
	"evidence",
	"endLine",
]);

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isAllowedField(key: PropertyKey): key is string {
	return typeof key === "string" && fields.has(key);
}

function formatField(key: PropertyKey): string {
	return String(key);
}

function validateShape(
	finding: Record<string, unknown>,
	row: number,
	errors: ValidationError[],
): void {
	for (const key of Reflect.ownKeys(finding)) {
		if (!isAllowedField(key)) {
			errors.push({ row, field: formatField(key), message: "is not allowed" });
		}
	}

	for (
		let prototype = Object.getPrototypeOf(finding);
		prototype !== null && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const key of Reflect.ownKeys(prototype)) {
			if (!isAllowedField(key)) {
				errors.push({
					row,
					field: formatField(key),
					message: "is not allowed",
				});
			} else if (key === "endLine" && !Object.hasOwn(finding, key)) {
				errors.push({ row, field: key, message: "must be an own property" });
			}
		}
	}
}

export function validateFindings(input: unknown): ValidationResult {
	if (!Array.isArray(input)) {
		return {
			ok: false,
			errors: [{ row: -1, field: "findings", message: "must be an array" }],
		};
	}

	const errors: ValidationError[] = [];

	for (const [rowIndex, row] of input.entries()) {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			errors.push({
				row: rowIndex,
				field: "row",
				message: "must be an object",
			});
			continue;
		}

		const finding = row as Record<string, unknown>;
		validateShape(finding, rowIndex, errors);

		const file = Object.hasOwn(finding, "file") ? finding.file : undefined;
		const line = Object.hasOwn(finding, "line") ? finding.line : undefined;
		const severity = Object.hasOwn(finding, "severity")
			? finding.severity
			: undefined;
		const title = Object.hasOwn(finding, "title") ? finding.title : undefined;
		const evidence = Object.hasOwn(finding, "evidence")
			? finding.evidence
			: undefined;
		const endLine = Object.hasOwn(finding, "endLine")
			? finding.endLine
			: undefined;

		if (typeof file !== "string") {
			errors.push({
				row: rowIndex,
				field: "file",
				message: "must be a string",
			});
		}
		if (!isPositiveInteger(line)) {
			errors.push({
				row: rowIndex,
				field: "line",
				message: "must be a positive integer",
			});
		}
		if (severity !== "high" && severity !== "medium" && severity !== "low") {
			errors.push({
				row: rowIndex,
				field: "severity",
				message: "must be high, medium, or low",
			});
		}
		if (!isNonEmptyString(title)) {
			errors.push({
				row: rowIndex,
				field: "title",
				message: "must be a non-empty string",
			});
		}
		if (!isNonEmptyString(evidence)) {
			errors.push({
				row: rowIndex,
				field: "evidence",
				message: "must be a non-empty string",
			});
		}
		if (
			Object.hasOwn(finding, "endLine") &&
			(!isPositiveInteger(endLine) ||
				!isPositiveInteger(line) ||
				endLine < line)
		) {
			errors.push({
				row: rowIndex,
				field: "endLine",
				message: "must be an integer greater than or equal to line",
			});
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, findings: input as Finding[] };
}
