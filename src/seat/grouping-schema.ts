/**
 * The grouping channel schema. One submission partitions the run's stamped
 * finding ids into groups: every expected id in exactly one group, nothing
 * else. A group carries ids only, so the seat can neither drop nor reword
 * nor re-rate a finding; the package derives everything shown from the
 * findings themselves.
 */
export type GroupsValidationError = { path: string; message: string };

export type GroupsValidationResult =
	| { ok: true; groups: string[][] }
	| { ok: false; errors: GroupsValidationError[] };

const groupFields = new Set(["findingIds"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateGroups(
	value: unknown,
	expectedIds: readonly string[],
): GroupsValidationResult {
	const errors: GroupsValidationError[] = [];
	if (!Array.isArray(value)) {
		return {
			ok: false,
			errors: [{ path: "groups", message: "must be an array of groups" }],
		};
	}
	const expected = new Set(expectedIds);
	const placed = new Set<string>();
	const groups: string[][] = [];
	for (const [index, row] of value.entries()) {
		const at = `groups[${index}]`;
		if (!isRecord(row)) {
			errors.push({ path: at, message: "must be an object { findingIds }" });
			continue;
		}
		for (const key of Reflect.ownKeys(row)) {
			if (typeof key !== "string" || !groupFields.has(key)) {
				errors.push({
					path: `${at}.${String(key)}`,
					message: "is not a group field; a group holds only findingIds",
				});
			}
		}
		const ids = row.findingIds;
		if (!Array.isArray(ids) || ids.length === 0) {
			errors.push({
				path: `${at}.findingIds`,
				message: "must be a non-empty array of finding ids",
			});
			continue;
		}
		const group: string[] = [];
		for (const id of ids) {
			if (typeof id !== "string" || !expected.has(id)) {
				errors.push({
					path: `${at}.findingIds`,
					message: `${typeof id === "string" ? id : JSON.stringify(id)} is not a submitted finding`,
				});
				continue;
			}
			if (placed.has(id)) {
				errors.push({
					path: `${at}.findingIds`,
					message: `${id} is in more than one group`,
				});
				continue;
			}
			placed.add(id);
			group.push(id);
		}
		groups.push(group);
	}
	for (const id of expectedIds) {
		if (!placed.has(id)) {
			errors.push({ path: "groups", message: `${id} is in no group` });
		}
	}
	return errors.length === 0 ? { ok: true, groups } : { ok: false, errors };
}

export function formatGroupsErrors(
	errors: readonly GroupsValidationError[],
): string {
	return errors.map(({ path, message }) => `${path}: ${message}`).join("\n");
}
