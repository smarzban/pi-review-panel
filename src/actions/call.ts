/**
 * The actions by name, each with its argument validation. An argument object
 * is `{ "action": "review", "base": "main", "head": "HEAD", ... }`: the shape
 * `review-panel call` takes. The CLI's own flags map onto the same names.
 */
import {
	type ActionContext,
	type ActionResult,
	coerceJsonValue,
	coerceStringList,
	commentAction,
	diagnoseAction,
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
import { resolveReviewRepository } from "./repository.js";

export const ACTION_NAMES = [
	"diagnose",
	"review",
	"verify",
	"resume",
	"comment",
	"suggest",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export type ActionFunctions = {
	diagnose: typeof diagnoseAction;
	review: typeof reviewAction;
	verify: typeof verifyAction;
	resume: typeof resumeAction;
	comment: typeof commentAction;
	suggest: typeof suggestAction;
};

export const realActions: ActionFunctions = {
	diagnose: diagnoseAction,
	review: reviewAction,
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
	verify: parseVerifyArguments,
	resume: parseResumeArguments,
	comment: parseCommentArguments,
	suggest: parseSuggestArguments,
};

/**
 * What `audit`, as a command or a `call` action, gets instead of running: the
 * repository audit was removed, so it is named, not refused as unknown.
 */
export const AUDIT_REMOVED =
	"audit was removed from review-panel: repository audits moved out of this package. review-panel reviews a change (review --base <ref> --head <ref>)";

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
	for (const key of ["seats", "lenses", "keptFindingIds", "lowAdvisory"]) {
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

/** The argument object is wrong: no such action, or an argument it does not take. */
export class CallArgumentError extends Error {}

/** No repository could be found for the call. */
export class CallRepositoryError extends Error {}

export type CallOptions = {
	/** Where to find the repository when `repository` is omitted or a placeholder. */
	cwd: string;
	/** A repository the caller already resolved (the CLI's `--repo`); wins. */
	repoDir?: string;
	context: ActionContext;
	actions?: ActionFunctions;
};

/**
 * Runs one action from its argument object (already coerced): checks the
 * action, finds the repository (`repoDir`, else `repository` when it is a real
 * path, else the Git top-level of `cwd`), validates the arguments with the
 * action's own parser, and runs it. The CLI runs every action through here.
 */
export async function callAction(
	args: Record<string, unknown>,
	options: CallOptions,
): Promise<ActionResult> {
	const action = args.action;
	if (action === "audit") {
		throw new CallArgumentError(AUDIT_REMOVED);
	}
	if (!isActionName(action)) {
		throw new CallArgumentError(
			`"action" must be one of ${ACTION_NAMES.join(", ")}`,
		);
	}
	let repoDir = options.repoDir;
	if (repoDir === undefined) {
		try {
			repoDir = resolveReviewRepository(args.repository, options.cwd);
		} catch (error) {
			throw new CallRepositoryError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	let input: Record<string, unknown>;
	try {
		input = ACTION_PARSERS[action](args);
	} catch (error) {
		throw new CallArgumentError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const run = (options.actions ?? realActions)[action] as (
		input: Record<string, unknown>,
		context: ActionContext,
	) => Promise<ActionResult>;
	return run({ repoDir, ...input }, options.context);
}
