// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { readFileSync, realpathSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { homedir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { env as processEnv } from "node:process";

import { Type } from "typebox";
import { loadLensTable } from "../config/lenses.js";
import { type ConfigEnv, loadConfig } from "../config/load.js";
import { resolvePanel } from "../config/panel.js";
import {
	diagnoseReadiness,
	type ReadinessReport,
} from "../config/readiness.js";
import { suggestLenses } from "../run/changeset.js";
import { discoverPriorRecords } from "../run/prior-records.js";
import {
	type RunReviewOptions,
	type RunReviewResult,
	resolveCommitOid,
	runReview,
} from "../run/run-review.js";
import {
	planVerifySeats,
	type RunVerifyInput,
	type RunVerifyOptions,
	type RunVerifyResult,
	runVerify,
} from "../run/run-verify.js";
import type { PlannedSeat, RunConfig, StampedFinding } from "../run/types.js";
import {
	accountCloseoutFindings,
	assembleCloseoutComment,
	type CloseoutJudgmentRow,
} from "./closeout-comment.js";
import { assertFixedResolved, loadCloseoutRun } from "./closeout-from-run.js";
import {
	type PostCloseoutInput,
	type PostCloseoutResult,
	postCloseoutComment,
} from "./closeout-post.js";
import {
	compactPanelRoster,
	progressFromReviewEvent,
	progressFromVerifyEvent,
	type ReviewProgressView,
	renderReadiness,
	renderReviewProgress,
	renderReviewResult,
	renderVerifyResult,
} from "./review-presentation.js";

const absoluteRepository = Type.String({
	pattern: "^/",
	description: "Absolute path to the repository to review.",
});
const nonEmpty = Type.String({ minLength: 1 });

/**
 * Hosts validate before execute. Models often emit array fields as a JSON
 * string (`"[\"security\"]"`). Accept that string in the declared schema and
 * coerce it in prepareArguments so the review branch still matches.
 */
const stringList = Type.Union([
	Type.Array(nonEmpty, { minItems: 1 }),
	Type.String({ minLength: 1 }),
]);

const parameters = Type.Union([
	Type.Object(
		{ action: Type.Literal("diagnose"), repository: absoluteRepository },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("review"),
			repository: absoluteRepository,
			base: nonEmpty,
			head: nonEmpty,
			seats: Type.Optional(stringList),
			lenses: Type.Optional(stringList),
			scopingNote: Type.Optional(nonEmpty),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("verify"),
			repository: absoluteRepository,
			priorRunId: nonEmpty,
			head: nonEmpty,
			keptFindingIds: stringList,
			seats: Type.Optional(stringList),
			scopingNote: Type.Optional(nonEmpty),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("comment"),
			repository: absoluteRepository,
			priorRunId: nonEmpty,
			ownerApproved: Type.Optional(Type.Unknown()),
			pr: Type.Optional(Type.Unknown()),
			dismissed: Type.Optional(Type.Unknown()),
			lowAdvisory: Type.Optional(Type.Unknown()),
			verifyRunId: Type.Optional(nonEmpty),
			head: Type.Optional(nonEmpty),
		},
		{ additionalProperties: false },
	),
	// Hosts validate before execute. Models probe with `{}`; accept it so we
	// can return copy-paste shapes instead of an anyOf dump.
	Type.Object({}, { additionalProperties: false }),
]);

const USAGE =
	'review_panel needs an action. Never call it with {}. Copy one of: { "action": "diagnose", "repository": "/absolute/path" } | { "action": "review", "repository": "/absolute/path", "base": "main", "head": "HEAD" } | { "action": "verify", "repository": "/absolute/path", "priorRunId": "<run-directory-or-record-path>", "head": "HEAD", "keptFindingIds": ["F-1"] } | { "action": "comment", "repository": "/absolute/path", "priorRunId": "<run-directory-or-record-path>", "ownerApproved": true }';

type ReviewToolArguments = Record<string, unknown>;

type ReviewToolResult = {
	content: Array<{ type: "text"; text: string }>;
};

export type ReviewPanelDependencies = {
	env?: ConfigEnv;
	home?: string;
	diagnose?: (input: {
		repoDir: string;
		env: ConfigEnv;
		home: string;
		mode?: "review-only" | "repair-loop";
	}) => Promise<ReadinessReport>;
	loadConfig?: typeof loadConfig;
	resolvePanel?: typeof resolvePanel;
	runReview?: (
		config: RunConfig,
		options?: RunReviewOptions,
	) => Promise<RunReviewResult>;
	resolveCommitOid?: typeof resolveCommitOid;
	suggestLenses?: typeof suggestLenses;
	runVerify?: (
		input: RunVerifyInput,
		options?: RunVerifyOptions,
	) => Promise<RunVerifyResult>;
	postComment?: (input: PostCloseoutInput) => PostCloseoutResult;
};

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

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateNonEmptyString(raw: unknown, label: string): string {
	if (!isNonEmptyString(raw)) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return raw;
}

function coerceStringList(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return trimmed.length > 0 ? [trimmed] : value;
}

export function prepareReviewArguments(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = args as Record<string, unknown>;
	const next: Record<string, unknown> = { ...record };
	for (const key of [
		"seats",
		"lenses",
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

function coerceJsonValue(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function validateStringArray(raw: unknown, label: string): string[] {
	const coerced = coerceStringList(raw);
	if (!Array.isArray(coerced) || coerced.length === 0) {
		throw new Error(`${label} must be a non-empty array of non-empty strings`);
	}
	for (const item of coerced) {
		if (!isNonEmptyString(item)) {
			throw new Error(`${label} must contain only non-empty strings`);
		}
	}
	return coerced;
}

const COMMENT_KEYS = new Set([
	"action",
	"repository",
	"priorRunId",
	"ownerApproved",
	"pr",
	"dismissed",
	"lowAdvisory",
	"verifyRunId",
	"head",
]);

function parseDismissed(raw: unknown): CloseoutJudgmentRow[] {
	if (raw === undefined) {
		return [];
	}
	const value = typeof raw === "string" ? coerceJsonValue(raw) : raw;
	if (!Array.isArray(value)) {
		throw new Error("dismissed must be an array of { id, reason }");
	}
	return value.map((row, index) => {
		if (row === null || typeof row !== "object") {
			throw new Error(`dismissed[${index}] must be an object`);
		}
		const record = row as { id?: unknown; reason?: unknown };
		return {
			id: validateNonEmptyString(record.id, `dismissed[${index}].id`),
			reason: validateNonEmptyString(
				record.reason,
				`dismissed[${index}].reason`,
			),
		};
	});
}

function parseLowAdvisory(raw: unknown): string[] {
	if (raw === undefined) {
		return [];
	}
	const value = typeof raw === "string" ? coerceStringList(raw) : raw;
	if (!Array.isArray(value)) {
		throw new Error("lowAdvisory must be an array of finding ids");
	}
	return value.map((item, index) => {
		if (isNonEmptyString(item)) {
			return item;
		}
		if (item !== null && typeof item === "object") {
			return validateNonEmptyString(
				(item as { id?: unknown }).id,
				`lowAdvisory[${index}].id`,
			);
		}
		throw new Error(`lowAdvisory[${index}] must be a finding id`);
	});
}

function executeComment(
	args: ReviewToolArguments,
	repoDir: string,
	postComment: (input: PostCloseoutInput) => PostCloseoutResult,
): ReviewToolResult {
	for (const key of Reflect.ownKeys(args)) {
		if (!COMMENT_KEYS.has(String(key))) {
			throw new Error(`comment does not accept argument "${String(key)}"`);
		}
	}
	if (args.ownerApproved !== true) {
		throw new Error(
			"comment refused: ownerApproved must be true after the owner asked to post",
		);
	}
	const priorRunId = validateNonEmptyString(args.priorRunId, "priorRunId");
	const dismissed = parseDismissed(args.dismissed);
	const lowAdvisory = parseLowAdvisory(args.lowAdvisory);
	const facts = loadCloseoutRun(repoDir, priorRunId);
	const accounted = accountCloseoutFindings({
		findings: facts.run.findings,
		dismissed,
		lowAdvisory,
	});
	if (accounted.fixed.length > 0) {
		if (!isNonEmptyString(args.verifyRunId)) {
			throw new Error(
				`comment refused: ${accounted.fixed.map((row) => row.id).join(", ")} still outstanding; pass verifyRunId after a clean verify or dismiss them`,
			);
		}
		assertFixedResolved(
			repoDir,
			args.verifyRunId,
			accounted.fixed.map((row) => row.id),
			facts.run.runId,
		);
	}
	const body = assembleCloseoutComment({
		findings: facts.run.findings,
		panel: facts.panel,
		lost: facts.lost,
		meta: facts.run.meta,
		dismissed,
		lowAdvisory,
		...(isNonEmptyString(args.head) ? { headRef: args.head } : {}),
	});
	const posted = postComment({
		repository: repoDir,
		body,
		...(args.pr === undefined ? {} : { pr: args.pr as number | string }),
	});
	return {
		content: [
			{
				type: "text",
				text: [
					`Posted comment on PR #${posted.pr} (${posted.action})`,
					posted.url,
					"",
					body,
				].join("\n"),
			},
		],
	};
}

function emitProgress(onUpdate: unknown, view: ReviewProgressView): void {
	if (typeof onUpdate === "function") {
		(onUpdate as (result: ReviewToolResult) => void)({
			content: [{ type: "text", text: renderReviewProgress(view) }],
		});
	}
}

function readStampedFindings(recordPath: string): StampedFinding[] | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(path.join(recordPath, "findings.json"), "utf8"),
		);
		return Array.isArray(parsed) ? (parsed as StampedFinding[]) : undefined;
	} catch {
		return undefined;
	}
}

export function canonicalizeRepository(repository: unknown): string {
	if (
		typeof repository !== "string" ||
		repository.trim() === "" ||
		!path.isAbsolute(repository)
	) {
		throw new Error("repository must be a non-empty absolute path");
	}
	let real: string;
	try {
		real = realpathSync(repository);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`repository "${repository}" cannot be resolved: ${cause}`);
	}
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: real,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return realpathSync(root);
	} catch {
		throw new Error(`repository "${repository}" is not a Git repository`);
	}
}

export function createReviewPanelTool(
	deps?: ReviewPanelDependencies,
): ReviewPanelTool {
	const diagnose = deps?.diagnose ?? diagnoseReadiness;
	const load = deps?.loadConfig ?? loadConfig;
	const panelOf = deps?.resolvePanel ?? resolvePanel;
	const review = deps?.runReview ?? runReview;
	const oidOf = deps?.resolveCommitOid ?? resolveCommitOid;
	const suggest = deps?.suggestLenses ?? suggestLenses;
	const verify = deps?.runVerify ?? runVerify;
	const postComment = deps?.postComment ?? postCloseoutComment;

	return {
		name: "review_panel",
		label: "Review panel",
		description:
			"Diagnose setup, review an explicit base...head change, verify a fix against a prior run, or post the owner-approved close-out comment. Never call with {}. Review takes repository, base, and head. The tool writes a report and does not compute a merge decision.",
		parameters,
		prepareArguments: prepareReviewArguments,
		async execute(_toolCallId, args, signal, onUpdate) {
			const startedAt = Date.now();
			const runtime = {
				env: deps?.env ?? processEnv,
				home: deps?.home ?? homedir(),
			};
			if (!isNonEmptyString(args.action)) {
				throw new Error(USAGE);
			}
			const action = validateNonEmptyString(args.action, "action");
			const repoDir = canonicalizeRepository(args.repository);

			if (action === "diagnose") {
				for (const key of Reflect.ownKeys(args)) {
					if (key !== "action" && key !== "repository") {
						throw new Error(
							`diagnose does not accept argument "${String(key)}"`,
						);
					}
				}
				const report = await diagnose({
					repoDir,
					env: runtime.env,
					home: runtime.home,
				});
				return { content: [{ type: "text", text: renderReadiness(report) }] };
			}

			if (action === "verify") {
				for (const key of Reflect.ownKeys(args)) {
					if (
						key !== "action" &&
						key !== "repository" &&
						key !== "priorRunId" &&
						key !== "head" &&
						key !== "keptFindingIds" &&
						key !== "seats" &&
						key !== "scopingNote"
					) {
						throw new Error(`verify does not accept argument "${String(key)}"`);
					}
				}
				const priorRunId = validateNonEmptyString(
					args.priorRunId,
					"priorRunId",
				);
				const head = validateNonEmptyString(args.head, "head");
				if (!Array.isArray(args.keptFindingIds)) {
					throw new Error(
						"keptFindingIds must be an array of non-empty strings",
					);
				}
				const keptFindingIds = args.keptFindingIds.map((id, index) =>
					validateNonEmptyString(id, `keptFindingIds[${index}]`),
				);
				const seats =
					args.seats === undefined
						? undefined
						: validateStringArray(args.seats, "seats");
				const scopingNote =
					args.scopingNote === undefined
						? undefined
						: validateNonEmptyString(args.scopingNote, "scopingNote");

				const report = await diagnose({
					repoDir,
					env: runtime.env,
					home: runtime.home,
				});
				if (!report.ready) {
					throw new Error(renderReadiness(report));
				}
				const config = load({
					repoDir,
					env: runtime.env,
					home: runtime.home,
				});
				const headRevision = oidOf(repoDir, head);
				const panel = planVerifySeats(config, seats);
				const roster = compactPanelRoster(panel);
				emitProgress(onUpdate, {
					phase: "verify",
					event: "started",
					elapsedMs: Date.now() - startedAt,
					total: panel.length,
					completed: 0,
					active: 0,
					roster,
				});
				const result = await verify(
					{
						repoDir,
						config,
						priorRunId,
						headRevision,
						keptFindingIds,
						...(seats === undefined ? {} : { seats }),
						...(scopingNote === undefined ? {} : { scopingNote }),
						...(config.defaults.seatBudgetMs === undefined
							? {}
							: { seatBudgetMs: config.defaults.seatBudgetMs }),
					},
					{
						...(signal === undefined ? {} : { abortSignal: signal }),
						onProgress: (event) =>
							emitProgress(onUpdate, {
								...progressFromVerifyEvent(event, Date.now() - startedAt),
								roster,
							}),
					},
				);
				return {
					content: [{ type: "text", text: renderVerifyResult(result) }],
				};
			}

			if (action === "comment") {
				return executeComment(args, repoDir, postComment);
			}

			if (action !== "review") {
				throw new Error(
					`review_panel action must be "diagnose", "review", "verify", or "comment", got "${action}"`,
				);
			}

			for (const key of Reflect.ownKeys(args)) {
				if (
					key !== "action" &&
					key !== "repository" &&
					key !== "base" &&
					key !== "head" &&
					key !== "seats" &&
					key !== "lenses" &&
					key !== "scopingNote"
				) {
					throw new Error(`review does not accept argument "${String(key)}"`);
				}
			}

			const base = validateNonEmptyString(args.base, "base");
			const head = validateNonEmptyString(args.head, "head");
			const baseRevision = oidOf(repoDir, base);
			const headRevision = oidOf(repoDir, head);
			if (baseRevision === headRevision) {
				throw new Error(
					"Review refused: base and head resolve to the same commit",
				);
			}

			const report = await diagnose({
				repoDir,
				env: runtime.env,
				home: runtime.home,
			});
			if (!report.ready) {
				throw new Error(renderReadiness(report));
			}

			const config = load({
				repoDir,
				env: runtime.env,
				home: runtime.home,
			});
			const seats =
				args.seats === undefined
					? undefined
					: validateStringArray(args.seats, "seats");
			const lenses =
				args.lenses === undefined
					? undefined
					: validateStringArray(args.lenses, "lenses");
			const scopingNote =
				args.scopingNote === undefined
					? undefined
					: validateNonEmptyString(args.scopingNote, "scopingNote");

			const panel: PlannedSeat[] = panelOf({
				config,
				lensTable: loadLensTable(),
				...(seats === undefined ? {} : { seats }),
				...(lenses === undefined ? {} : { lenses }),
			});

			const roster = compactPanelRoster(panel);
			emitProgress(onUpdate, {
				phase: "review",
				event: "started",
				elapsedMs: Date.now() - startedAt,
				total: panel.length,
				completed: 0,
				active: 0,
				roster,
			});
			const result = await review(
				{
					repoDir,
					baseRef: base,
					baseRevision,
					headRevision,
					revision: headRevision,
					seats: panel,
					priorRecordPaths: discoverPriorRecords(repoDir).map(
						(record) => record.path,
					),
					...(scopingNote === undefined ? {} : { scopingNote }),
					...(config.defaults.seatBudgetMs === undefined
						? {}
						: { seatBudgetMs: config.defaults.seatBudgetMs }),
				},
				{
					...(signal === undefined ? {} : { abortSignal: signal }),
					onProgress: (event) =>
						emitProgress(onUpdate, {
							...progressFromReviewEvent(event, Date.now() - startedAt),
							roster,
						}),
				},
			);
			const suggestions = suggest(repoDir, baseRevision, headRevision);
			const findings = readStampedFindings(result.recordPath);

			return {
				content: [
					{
						type: "text",
						text: renderReviewResult({
							recordPath: result.recordPath,
							panel,
							result,
							suggestions,
							...(scopingNote === undefined ? {} : { scopingNote }),
							...(findings === undefined ? {} : { findings }),
						}),
					},
				],
			};
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
