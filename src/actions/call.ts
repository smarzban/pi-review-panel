/**
 * The actions by name, each with its argument validation. An argument object
 * is `{ "action": "review", "base": "main", "head": "HEAD", ... }`: the shape
 * `review-panel call` takes. The CLI's own flags map onto the same names.
 */
import {
	auditAction,
	coerceJsonValue,
	coerceStringList,
	commentAction,
	diagnoseAction,
	parseAuditArguments,
	parseCommentArguments,
	parseDiagnoseArguments,
	parseResumeArguments,
	parseReviewArguments,
	parseSuggestArguments,
	parseVerifyArguments,
	resumeAction,
	reviewAction,
	suggestAction,
	verifyAction,
} from "./actions.js";

export const ACTION_NAMES = [
	"diagnose",
	"review",
	"audit",
	"verify",
	"resume",
	"comment",
	"suggest",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export type ActionFunctions = {
	diagnose: typeof diagnoseAction;
	review: typeof reviewAction;
	audit: typeof auditAction;
	verify: typeof verifyAction;
	resume: typeof resumeAction;
	comment: typeof commentAction;
	suggest: typeof suggestAction;
};

export const realActions: ActionFunctions = {
	diagnose: diagnoseAction,
	review: reviewAction,
	audit: auditAction,
	verify: verifyAction,
	resume: resumeAction,
	comment: commentAction,
	suggest: suggestAction,
};

/** Each action's argument validation, which refuses an argument it does not take. */
export const ACTION_PARSERS: Record<
	ActionName,
	(args: Record<string, unknown>) => Record<string, unknown>
> = {
	diagnose: parseDiagnoseArguments,
	review: parseReviewArguments,
	audit: parseAuditArguments,
	verify: parseVerifyArguments,
	resume: parseResumeArguments,
	comment: parseCommentArguments,
	suggest: parseSuggestArguments,
};

export function isActionName(value: unknown): value is ActionName {
	return (
		typeof value === "string" &&
		(ACTION_NAMES as readonly string[]).includes(value)
	);
}

/**
 * Lenient coercions for an argument object an agent wrote: a string for a
 * list, JSON text for `dismissed`, and `"true"`/`"false"` for `ownerApproved`
 * and `prComment`.
 */
export function coerceCallArguments(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...args };
	for (const key of [
		"seats",
		"lenses",
		"passes",
		"keptFindingIds",
		"lowAdvisory",
	]) {
		if (Object.hasOwn(next, key)) {
			next[key] = coerceStringList(next[key]);
		}
	}
	if (typeof next.dismissed === "string") {
		next.dismissed = coerceJsonValue(next.dismissed);
	}
	for (const key of ["ownerApproved", "prComment"]) {
		if (next[key] === "true") {
			next[key] = true;
		} else if (next[key] === "false") {
			next[key] = false;
		}
	}
	return next;
}
