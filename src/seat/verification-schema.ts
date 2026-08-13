/**
 * The fix-verification channel schema (AC-40, AC-41, AC-42, AC-47). One
 * structured submission accounts for every preceding fix-list source id with
 * exactly one allowed disposition (`resolved`, `still present`,
 * `inconclusive`), a `resolved` item carries code evidence, and direct
 * regressions are reported without model-authored ids: trusted code assigns
 * each accepted regression a stable, loop-unique `regressionId` stamped with
 * the caller-supplied cycle (AC-42). The model never
 * judges causation semantically; the channel only validates structure and the
 * expected id set.
 */
export type Disposition = "resolved" | "still present" | "inconclusive";

export type CodeEvidence = {
	file: string;
	explanation: string;
};

export type VerificationItemRow = {
	id: string;
	disposition: Disposition;
	evidence?: CodeEvidence;
};

export type RegressionRow = {
	file: string;
	line: number;
	title: string;
	evidence: string;
};

export type StampedRegressionRow = RegressionRow & {
	regressionId: string;
};

export type VerificationResult = {
	items: VerificationItemRow[];
	regressions: StampedRegressionRow[];
};

export type VerificationValidationError = {
	path: string;
	message: string;
};

export type VerificationValidationResult =
	| { ok: true; result: VerificationResult }
	| { ok: false; errors: VerificationValidationError[] };

const itemFields = new Set(["id", "disposition", "evidence"]);
const regressionFields = new Set(["file", "line", "title", "evidence"]);
const evidenceFields = new Set(["file", "explanation"]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedField(
	fields: ReadonlySet<string>,
	key: PropertyKey,
): boolean {
	return typeof key === "string" && fields.has(key);
}

/** Rejects unknown own and prototype-chain keys on a row-shaped object. */
function rejectUnknownFields(
	fields: ReadonlySet<string>,
	row: Record<string, unknown>,
	path: string,
	errors: VerificationValidationError[],
): void {
	for (const key of Reflect.ownKeys(row)) {
		if (!isAllowedField(fields, key)) {
			errors.push({ path, message: `"${String(key)}" is not allowed` });
		}
	}

	for (
		let prototype = Object.getPrototypeOf(row);
		prototype !== null && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const key of Reflect.ownKeys(prototype)) {
			if (!isAllowedField(fields, key)) {
				errors.push({ path, message: `"${String(key)}" is not allowed` });
			}
		}
	}
}

function validateEvidence(
	value: unknown,
	path: string,
	errors: VerificationValidationError[],
): void {
	if (!isRecord(value)) {
		errors.push({
			path,
			message: "must be an object with file and explanation",
		});
		return;
	}
	rejectUnknownFields(evidenceFields, value, path, errors);
	if (!isNonEmptyString(value.file)) {
		errors.push({ path, message: "file must be a non-empty string" });
	}
	if (!isNonEmptyString(value.explanation)) {
		errors.push({ path, message: "explanation must be a non-empty string" });
	}
}

export function validateVerification(
	input: unknown,
	expectedIds: readonly string[],
	cycle: number,
): VerificationValidationResult {
	if (!Number.isInteger(cycle) || cycle < 1) {
		return {
			ok: false,
			errors: [{ path: "cycle", message: "must be a positive integer" }],
		};
	}
	if (!isRecord(input)) {
		return {
			ok: false,
			errors: [{ path: "submission", message: "must be an object" }],
		};
	}

	const errors: VerificationValidationError[] = [];
	const expectedSet = new Set(expectedIds);
	const seenItems = new Set<string>();
	const items: VerificationItemRow[] = [];

	if (!Array.isArray(input.items)) {
		errors.push({ path: "items", message: "must be an array" });
	} else {
		for (const [rowIndex, row] of input.items.entries()) {
			const rowPath = `items[${rowIndex}]`;
			if (!isRecord(row)) {
				errors.push({ path: rowPath, message: "must be an object" });
				continue;
			}

			const rowErrorsBefore = errors.length;
			rejectUnknownFields(itemFields, row, rowPath, errors);

			const id = Object.hasOwn(row, "id") ? row.id : undefined;
			const disposition = Object.hasOwn(row, "disposition")
				? row.disposition
				: undefined;
			const evidence = Object.hasOwn(row, "evidence")
				? row.evidence
				: undefined;

			if (!isNonEmptyString(id)) {
				errors.push({
					path: `${rowPath}.id`,
					message: "must be a non-empty string",
				});
			} else if (!expectedSet.has(id)) {
				errors.push({
					path: `${rowPath}.id`,
					message: `unknown id "${id}"`,
				});
			} else if (seenItems.has(id)) {
				errors.push({
					path: `${rowPath}.id`,
					message: `duplicate id "${id}"`,
				});
			} else {
				seenItems.add(id);
			}

			if (
				disposition !== "resolved" &&
				disposition !== "still present" &&
				disposition !== "inconclusive"
			) {
				errors.push({
					path: `${rowPath}.disposition`,
					message: "must be resolved, still present, or inconclusive",
				});
			}

			if (disposition === "resolved") {
				if (evidence === undefined) {
					errors.push({
						path: `${rowPath}.evidence`,
						message: "is required for a resolved disposition",
					});
				} else {
					validateEvidence(evidence, `${rowPath}.evidence`, errors);
				}
			} else if (evidence !== undefined) {
				errors.push({
					path: `${rowPath}.evidence`,
					message: "is only allowed for a resolved disposition",
				});
			}

			if (errors.length === rowErrorsBefore) {
				const item: VerificationItemRow = {
					id: id as string,
					disposition: disposition as Disposition,
				};
				if (evidence !== undefined) {
					item.evidence = evidence as CodeEvidence;
				}
				items.push(item);
			}
		}
	}

	for (const expectedId of expectedIds) {
		if (!seenItems.has(expectedId)) {
			errors.push({
				path: "items",
				message: `missing expected id "${expectedId}"`,
			});
		}
	}

	const regressions: StampedRegressionRow[] = [];
	if (input.regressions === undefined) {
		errors.push({ path: "regressions", message: "is required" });
	} else if (!Array.isArray(input.regressions)) {
		errors.push({ path: "regressions", message: "must be an array" });
	} else {
		for (const [rowIndex, row] of input.regressions.entries()) {
			const rowPath = `regressions[${rowIndex}]`;
			if (!isRecord(row)) {
				errors.push({ path: rowPath, message: "must be an object" });
				continue;
			}

			const rowErrorsBefore = errors.length;
			rejectUnknownFields(regressionFields, row, rowPath, errors);

			const file = Object.hasOwn(row, "file") ? row.file : undefined;
			const line = Object.hasOwn(row, "line") ? row.line : undefined;
			const title = Object.hasOwn(row, "title") ? row.title : undefined;
			const evidence = Object.hasOwn(row, "evidence")
				? row.evidence
				: undefined;

			if (!isNonEmptyString(file)) {
				errors.push({
					path: `${rowPath}.file`,
					message: "must be a non-empty string",
				});
			}
			if (!isPositiveInteger(line)) {
				errors.push({
					path: `${rowPath}.line`,
					message: "must be a positive integer",
				});
			}
			if (!isNonEmptyString(title)) {
				errors.push({
					path: `${rowPath}.title`,
					message: "must be a non-empty string",
				});
			}
			if (!isNonEmptyString(evidence)) {
				errors.push({
					path: `${rowPath}.evidence`,
					message: "must be a non-empty string",
				});
			}

			if (errors.length === rowErrorsBefore) {
				regressions.push({
					// Loop-unique trusted stamp (AC-42): the cycle prefix keeps a
					// carried regression and a new regression in a later cycle from
					// colliding in verification-response and dispatch accounting.
					regressionId: `regression-${cycle}-${rowIndex + 1}`,
					file: file as string,
					line: line as number,
					title: title as string,
					evidence: evidence as string,
				});
			}
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, result: { items, regressions } };
}

export function formatVerificationErrors(
	errors: VerificationValidationError[],
): string {
	return errors.map(({ path, message }) => `${path} ${message}`).join("\n");
}
