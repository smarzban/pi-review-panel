import { cwd as processCwd } from "node:process";

import { Type } from "typebox";
import {
	type ActionContext,
	type ActionDependencies,
	type ActionResult,
	auditAction,
	coerceJsonValue,
	coerceStringList,
	commentAction,
	diagnoseAction,
	isNonEmptyString,
	parseAuditArguments,
	parseCommentArguments,
	parseDiagnoseArguments,
	parseResumeArguments,
	parseReviewArguments,
	parseVerifyArguments,
	resumeAction,
	reviewAction,
	validateNonEmptyString,
	verifyAction,
} from "../actions/actions.js";
import { resolveReviewRepository } from "../actions/repository.js";
import { renderReviewProgress } from "./review-presentation.js";

export {
	ownerRecordKey,
	ownerRecordKeyCheck,
	type RecordKeyInput,
} from "../actions/actions.js";
export {
	canonicalizeRepository,
	isPlaceholderRepository,
	REPOSITORY_EXAMPLE,
	rejectFilesystemRoot,
	resolveReviewRepository,
} from "../actions/repository.js";

const absoluteRepository = Type.String({
	pattern: "^/",
	description:
		"Absolute path to the Git repository. Omit it when this process is already in the repo. Never pass '/'.",
});
const nonEmpty = Type.String({ minLength: 1 });

/**
 * Pi validates tool arguments before execute. Keep this a flat, permissive
 * envelope: action-specific validation happens in execute, while a root-level
 * union can be serialized as an empty object by some provider transports.
 */
const stringArray = Type.Array(nonEmpty, { minItems: 1 });

const parameters = Type.Object(
	{
		action: Type.Optional(
			Type.String({
				description:
					'Required action: "diagnose", "review", "audit", "verify", "resume", or "comment".',
			}),
		),
		repository: Type.Optional(absoluteRepository),
		base: Type.Optional(nonEmpty),
		head: Type.Optional(nonEmpty),
		seats: Type.Optional(stringArray),
		lenses: Type.Optional(stringArray),
		passes: Type.Optional(stringArray),
		scopingNote: Type.Optional(nonEmpty),
		priorRunId: Type.Optional(nonEmpty),
		keptFindingIds: Type.Optional(stringArray),
		ownerApproved: Type.Optional(Type.Boolean()),
		pr: Type.Optional(Type.Any()),
		dismissed: Type.Optional(Type.Any()),
		lowAdvisory: Type.Optional(Type.Any()),
		verifyRunId: Type.Optional(nonEmpty),
	},
	{ additionalProperties: true },
);

const USAGE =
	'review_panel needs an action. Never call it with {}. Omit repository when this process is already in the repo. Copy one of: { "action": "diagnose" } | { "action": "review", "base": "main", "head": "HEAD" } | { "action": "audit" } | { "action": "verify", "priorRunId": "<run-directory-or-record-path>", "head": "HEAD", "keptFindingIds": ["F-1"] } | { "action": "resume", "priorRunId": "<interrupted-run-directory>" } | { "action": "comment", "priorRunId": "<run-directory-or-record-path>", "ownerApproved": true }';

type ReviewToolArguments = Record<string, unknown>;

type ReviewToolResult = ActionResult;

export type ReviewPanelDependencies = ActionDependencies;

export type ReviewPanelTool = {
	name: "review_panel";
	label: string;
	description: string;
	parameters: typeof parameters;
	prepareArguments: (args: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: ReviewToolArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ReviewToolResult>;
};

export function prepareReviewArguments(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = args as Record<string, unknown>;
	const next: Record<string, unknown> = { ...record };
	for (const key of [
		"seats",
		"lenses",
		"passes",
		"keptFindingIds",
		"lowAdvisory",
	] as const) {
		if (Object.hasOwn(next, key)) {
			next[key] = coerceStringList(next[key]);
		}
	}
	if (typeof next.dismissed === "string") {
		next.dismissed = coerceJsonValue(next.dismissed);
	}
	if (next.ownerApproved === "true") {
		next.ownerApproved = true;
	}
	return next;
}

function cwdFromContext(context: unknown): string | undefined {
	if (context === null || typeof context !== "object") {
		return undefined;
	}
	const cwd = (context as { cwd?: unknown }).cwd;
	if (typeof cwd === "string" && cwd.trim() !== "") {
		return cwd;
	}
	return undefined;
}

export function createReviewPanelTool(
	deps?: ReviewPanelDependencies,
): ReviewPanelTool {
	return {
		name: "review_panel",
		label: "Review panel",
		description:
			"Diagnose setup, review an explicit base...head change, run an advisory whole-repository audit, verify a fix against a prior run, resume an interrupted review or audit run (only its unfinished seats run again), or post the owner-approved close-out comment. Never call with {}. Review takes base and head. Omit repository when already in the repo. The tool writes a report and does not compute a merge decision.",
		parameters,
		prepareArguments: prepareReviewArguments,
		async execute(_toolCallId, args, signal, onUpdate, context) {
			const startedAt = Date.now();
			if (!isNonEmptyString(args.action)) {
				throw new Error(USAGE);
			}
			const action = validateNonEmptyString(args.action, "action");
			const repoDir = resolveReviewRepository(
				args.repository,
				cwdFromContext(context) ?? processCwd(),
			);
			const actionContext: ActionContext = {
				...(deps === undefined ? {} : { deps }),
				...(signal === undefined ? {} : { signal }),
				...(typeof onUpdate === "function"
					? {
							onProgress: (view) =>
								(onUpdate as (result: ReviewToolResult) => void)({
									content: [{ type: "text", text: renderReviewProgress(view) }],
								}),
						}
					: {}),
				startedAt,
			};

			switch (action) {
				case "diagnose":
					return diagnoseAction(
						{ repoDir, ...parseDiagnoseArguments(args) },
						actionContext,
					);
				case "audit":
					return auditAction(
						{ repoDir, ...parseAuditArguments(args) },
						actionContext,
					);
				case "verify":
					return verifyAction(
						{ repoDir, ...parseVerifyArguments(args) },
						actionContext,
					);
				case "comment":
					return commentAction(
						{ repoDir, ...parseCommentArguments(args) },
						actionContext,
					);
				case "resume":
					return resumeAction(
						{ repoDir, ...parseResumeArguments(args) },
						actionContext,
					);
				case "review":
					return reviewAction(
						{ repoDir, ...parseReviewArguments(args) },
						actionContext,
					);
				default:
					throw new Error(
						`review_panel action must be "diagnose", "review", "audit", "verify", "resume", or "comment", got "${action}"`,
					);
			}
		},
	};
}

type ReviewPanelExtensionApi = {
	registerTool: (tool: ReviewPanelTool) => void;
};

export default function reviewPanelExtension(
	pi: ReviewPanelExtensionApi,
): void {
	pi.registerTool(createReviewPanelTool());
}
