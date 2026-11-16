/**
 * How long the text a seat writes may be, so a posted card stays short.
 * Only the submit tools enforce these: a refusal names the limit and the
 * seat writes the row again. Records are never checked against them, so a
 * record written before a limit changed still reads.
 */
export const TITLE_MAX = 120;
export const EVIDENCE_MAX = 800;
export const EXPLANATION_MAX = 500;

function tooLong(text: unknown, max: number): boolean {
	return typeof text === "string" && Array.from(text).length > max;
}

/** One line per field over its limit, or none. */
export function textLimitErrors(
	rows: ReadonlyArray<{ title?: unknown; evidence?: unknown }>,
	what: string,
): string[] {
	const errors: string[] = [];
	for (const [index, row] of rows.entries()) {
		if (tooLong(row.title, TITLE_MAX)) {
			errors.push(
				`${what}[${index}].title is over ${TITLE_MAX} characters: say the problem in one shorter sentence`,
			);
		}
		if (tooLong(row.evidence, EVIDENCE_MAX)) {
			errors.push(
				`${what}[${index}].evidence is over ${EVIDENCE_MAX} characters: say what goes wrong and why, more briefly`,
			);
		}
	}
	return errors;
}

/** One line per verification explanation over its limit, or none. */
export function explanationLimitErrors(
	items: ReadonlyArray<{ evidence?: { explanation?: unknown } }>,
): string[] {
	return items.flatMap((item, index) =>
		tooLong(item.evidence?.explanation, EXPLANATION_MAX)
			? [
					`items[${index}].evidence.explanation is over ${EXPLANATION_MAX} characters: lead with what you found, in one or two short sentences`,
				]
			: [],
	);
}
