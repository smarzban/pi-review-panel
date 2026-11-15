/**
 * The review panel's actions as plain functions: no host envelope and no
 * schema library, so any front end (today the `review-panel` CLI) can call
 * them. Each `parse*Arguments` validates a raw argument record (the object
 * `review-panel call` takes); each `*Action` runs one action and returns its
 * result object.
 *
 * Each action validates its own input with the same checks, in the same order
 * and with the same messages as its parser, so a front end that builds the
 * input itself gets the refusals an argument object gets. The parser adds only the
 * refusal of argument keys the action does not take. Each action, and each
 * exported record-key helper, also resolves `repoDir` to its Git top level as
 * an argument object's is: a relative path, `/`, a placeholder path or a path outside
 * Git is refused.
 *
 * `coerceCallArguments` (call.ts) first coerces what agents send as strings. A JSON array string
 * for `seats`, `lenses`, `keptFindingIds` or `lowAdvisory`, JSON
 * for `dismissed`, and `"true"` for `ownerApproved` are converted (a comma
 * list is not split; it stays one item). The actions convert the same
 * strings for `seats`, `lenses`, `lowAdvisory` and `dismissed`, but
 * refuse a string `keptFindingIds` and `ownerApproved: "true"`. Pass real
 * arrays and `true`.
 *
 * No Pi host and no TypeBox are needed to import or call these. Running a
 * seat (review, verify, resume) and diagnose's model check still load
 * the Pi SDK (`@earendil-works/pi-coding-agent`) through a dynamic `import()`
 * in `src/seat/sdk-session.ts` and `src/config/readiness.ts`, so a front end
 * that runs those needs the SDK installed. Suggest, comment and the parsers
 * do not.
 */
import { homedir } from "node:os";
import path from "node:path";
import { env as processEnv } from "node:process";

import { loadLensTable } from "../config/lenses.js";
import {
	type ConfigEnv,
	loadConfig,
	resolveConfigPath,
} from "../config/load.js";
import { resolvePanel } from "../config/panel.js";
import {
	diagnoseReadiness,
	type ReadinessReport,
} from "../config/readiness.js";
import { suggestLenses } from "../run/changeset.js";
import { isOid } from "../run/commits.js";
import {
	isGroupId,
	planConsolidator,
	recordedGrouping,
} from "../run/grouping.js";
import type { PriorRun } from "../run/prior-run.js";
import {
	checkRecordKey,
	loadRecordKey,
	RecordKeyError,
	type RecordKeyProblem,
	recordKeyPath,
} from "../run/record-key.js";
import { SCOPING_NOTE_DROPPED } from "../run/render.js";
import {
	loadResumable,
	type ResumableRun,
	type ResumeOptions,
	type ResumeResult,
	resumeRun,
} from "../run/resume.js";
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
import type { PlannedSeat, RunConfig } from "../run/types.js";
import {
	type ChainLink,
	type ChainState,
	chainState,
	defaultKeptIds,
	judgeRound,
	loadChainPrior,
	loadVerifyChain,
} from "../run/verify-chain.js";
import {
	assembleCloseoutComment,
	type CloseoutJudgmentRow,
	type CloseoutLinks,
} from "../tool/closeout-comment.js";
import {
	assertFixedResolved,
	loadCloseoutRun,
} from "../tool/closeout-from-run.js";
import {
	type PostCloseoutInput,
	type PostCloseoutResult,
	postCloseoutComment,
} from "../tool/closeout-post.js";
import { chainRounds, roundCommentLinks } from "../tool/closeout-rounds.js";
import {
	compactPanelRoster,
	formatSuggestion,
	formatSuggestionsUnavailable,
	progressFromReviewEvent,
	progressFromVerifyEvent,
	type ReviewProgressView,
	renderReadiness,
	renderReviewResult,
	renderSuggestResult,
	renderVerifyResult,
	truncateCodePoints,
} from "../tool/review-presentation.js";
import {
	defaultRunGh,
	postReviewRound,
	postVerifyRound,
	ROUND_REPLY_RESERVE,
	type RoundContext,
	type RoundGhRunner,
	type RoundRequest,
} from "../tool/round-post.js";
import { canonicalizeRepository } from "./repository.js";

export type ActionResult = {
	content: Array<{ type: "text"; text: string }>;
};

export type ActionDependencies = {
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
		options: RunVerifyOptions,
	) => Promise<RunVerifyResult>;
	postComment?: (input: PostCloseoutInput) => PostCloseoutResult;
	/**
	 * Runs `gh` for posting each review and verify round to the open PR. By
	 * default it runs the real `gh`.
	 */
	runGh?: RoundGhRunner;
	resumeRun?: (
		run: ResumableRun,
		options?: ResumeOptions,
	) => Promise<ResumeResult>;
	/**
	 * The owner's record key. By default it is read from `record-key` beside
	 * the owner config, and created there by a first review.
	 */
	recordKey?: (input: RecordKeyInput) => Buffer;
	/**
	 * The `diagnose` check of the record key, which never writes. By default it
	 * checks `record-key` beside the owner config the way review uses it.
	 */
	checkRecordKey?: (
		input: Omit<RecordKeyInput, "create">,
	) => RecordKeyProblem | undefined;
};

/** What every action takes besides its own input. */
export type ActionContext = {
	deps?: ActionDependencies;
	signal?: AbortSignal;
	/** Called with each in-flight progress view while seats run. */
	onProgress?: (view: ReviewProgressView) => void;
	/** When the call started, for elapsed times; defaults to the action's start. */
	startedAt?: number;
};

export type RecordKeyInput = {
	repoDir: string;
	env: ConfigEnv;
	home: string;
	/** Create the key when it is missing: review does, resume never. */
	create: boolean;
};

/** Reads (or creates) the record key in the folder of the owner config. */
export function ownerRecordKey(input: RecordKeyInput): Buffer {
	return loadRecordKey(
		recordKeyPath(resolveConfigPath({ env: input.env, home: input.home })),
		{ create: input.create, repoDir: canonicalizeRepository(input.repoDir) },
	);
}

/** Checks the owner's record key for `diagnose`, without writing anything. */
export function ownerRecordKeyCheck(
	input: Omit<RecordKeyInput, "create">,
): RecordKeyProblem | undefined {
	const repoDir = canonicalizeRepository(input.repoDir);
	let configPath: string;
	try {
		configPath = resolveConfigPath({ env: input.env, home: input.home });
	} catch {
		// A bad config override is the configuration row's to report.
		return undefined;
	}
	return checkRecordKey(recordKeyPath(configPath), { repoDir });
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function validateNonEmptyString(raw: unknown, label: string): string {
	if (!isNonEmptyString(raw)) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return raw;
}

export function coerceStringList(value: unknown): unknown {
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

export function coerceJsonValue(value: string): unknown {
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

function optionalStringArray(
	raw: unknown,
	label: string,
): string[] | undefined {
	return raw === undefined ? undefined : validateStringArray(raw, label);
}

function optionalNonEmptyString(
	raw: unknown,
	label: string,
): string | undefined {
	return raw === undefined ? undefined : validateNonEmptyString(raw, label);
}

/** Refuses any argument key an action does not take, `action` and `repository` aside. */
function refuseUnknownArguments(
	args: Record<string, unknown>,
	action: string,
	accepted: readonly string[],
): void {
	for (const key of Reflect.ownKeys(args)) {
		if (
			key !== "action" &&
			key !== "repository" &&
			!accepted.includes(key as string)
		) {
			throw new Error(`${action} does not accept argument "${String(key)}"`);
		}
	}
}

/** The input every action shares: the resolved repository top-level. */
type RepositoryInput = { repoDir: string };

/** Diagnose takes nothing beyond the repository. */
export type DiagnoseInput = Record<never, never>;

/**
 * What review and verify take about posting their round to the open PR:
 * `prComment: false` turns it off for this run, `pr` names the PR instead of
 * looking it up by the head commit, and `ownerApproved: true` is needed for
 * any post when the owner config's `defaults.prComment` is `"ownerApproved"`.
 */
export type RoundInput = {
	prComment?: boolean;
	pr?: number;
	ownerApproved?: boolean;
};

const ROUND_KEYS = ["prComment", "pr", "ownerApproved"] as const;

export type VerifyInput = RoundInput & {
	/** The review, before any verify of it, or the latest verify of that review. */
	priorRunId: string;
	head: string;
	/**
	 * The ids to check. Omitted on a chained verify: every id still open
	 * after the latest verify. Required for the first verify of a review.
	 */
	keptFindingIds?: string[];
	/**
	 * Post the close-out card after this verify, only when nothing is open
	 * after it. The card is never posted otherwise by a verify.
	 */
	closeOut?: boolean;
	seats?: string[];
	scopingNote?: string;
	/** Kept-out findings with the reason, shown in the verify comment and the close-out. */
	dismissed?: CloseoutJudgmentRow[];
	/** Low findings left as advisory, shown the same way. */
	lowAdvisory?: string[];
};

export type ResumeInput = { priorRunId: string };

export type CommentInput = {
	ownerApproved: true;
	priorRunId: string;
	dismissed: CloseoutJudgmentRow[];
	lowAdvisory: string[];
	verifyRunId?: string;
	/**
	 * Accepted as before; the card no longer shows a head ref, only the
	 * short id of the commit the verify checked (or the review's head).
	 */
	head?: string;
	pr?: number | string;
};

/**
 * `seats`, `lenses` and `scopingNote` stay raw here. Their shape is checked
 * when the call is parsed; `reviewAction` reads them again, and checks what
 * they name, once both commits are resolved and the panel is ready.
 */
export type ReviewInput = RoundInput & {
	base: string;
	head: string;
	seats?: unknown;
	lenses?: unknown;
	scopingNote?: unknown;
};

/** Suggest takes the same commit range as review, and nothing else. */
export type SuggestInput = { base: string; head: string };

export function parseSuggestArguments(
	args: Record<string, unknown>,
): SuggestInput {
	refuseUnknownArguments(args, "suggest", ["base", "head"]);
	return validateSuggestInput(args);
}

function validateSuggestInput(
	args: SuggestInput | Record<string, unknown>,
): SuggestInput {
	return {
		base: validateNonEmptyString(args.base, "base"),
		head: validateNonEmptyString(args.head, "head"),
	};
}

export function parseDiagnoseArguments(
	args: Record<string, unknown>,
): DiagnoseInput {
	refuseUnknownArguments(args, "diagnose", []);
	return {};
}

export function parseVerifyArguments(
	args: Record<string, unknown>,
): VerifyInput {
	refuseUnknownArguments(args, "verify", [
		"priorRunId",
		"head",
		"keptFindingIds",
		"seats",
		"scopingNote",
		"dismissed",
		"lowAdvisory",
		"closeOut",
		...ROUND_KEYS,
	]);
	return validateVerifyInput(args);
}

function validateVerifyInput(
	args: VerifyInput | Record<string, unknown>,
): VerifyInput {
	const priorRunId = validateNonEmptyString(args.priorRunId, "priorRunId");
	const head = validateNonEmptyString(args.head, "head");
	if (
		args.keptFindingIds !== undefined &&
		!Array.isArray(args.keptFindingIds)
	) {
		throw new Error("keptFindingIds must be an array of non-empty strings");
	}
	const keptFindingIds = args.keptFindingIds?.map((id, index) =>
		validateNonEmptyString(id, `keptFindingIds[${index}]`),
	);
	const seats = optionalStringArray(args.seats, "seats");
	const scopingNote = optionalNonEmptyString(args.scopingNote, "scopingNote");
	const dismissed = parseDismissed(args.dismissed);
	const lowAdvisory = parseLowAdvisory(args.lowAdvisory);
	const closeOut = optionalBoolean(args.closeOut, "closeOut");
	return {
		priorRunId,
		head,
		...(keptFindingIds === undefined ? {} : { keptFindingIds }),
		...(closeOut === undefined ? {} : { closeOut }),
		...(seats === undefined ? {} : { seats }),
		...(scopingNote === undefined ? {} : { scopingNote }),
		...(args.dismissed === undefined ? {} : { dismissed }),
		...(args.lowAdvisory === undefined ? {} : { lowAdvisory }),
		...validateRoundInput(args),
	};
}

function optionalBoolean(raw: unknown, label: string): boolean | undefined {
	if (raw === undefined || typeof raw === "boolean") {
		return raw;
	}
	throw new Error(`${label} must be true or false`);
}

function validateRoundInput(args: RoundInput | Record<string, unknown>) {
	const prComment = optionalBoolean(args.prComment, "prComment");
	const ownerApproved = optionalBoolean(args.ownerApproved, "ownerApproved");
	let pr: number | undefined;
	if (args.pr !== undefined) {
		const raw = args.pr;
		pr =
			typeof raw === "number"
				? raw
				: typeof raw === "string" && /^\s*\d+\s*$/.test(raw)
					? Number(raw.trim())
					: Number.NaN;
		if (!Number.isSafeInteger(pr) || pr <= 0) {
			throw new Error("pr must be a positive integer");
		}
	}
	return {
		...(prComment === undefined ? {} : { prComment }),
		...(pr === undefined ? {} : { pr }),
		...(ownerApproved === undefined ? {} : { ownerApproved }),
	};
}

function roundRequest(input: RoundInput): RoundRequest {
	return {
		...(input.prComment === undefined ? {} : { prComment: input.prComment }),
		...(input.pr === undefined ? {} : { pr: input.pr }),
		...(input.ownerApproved === undefined
			? {}
			: { ownerApproved: input.ownerApproved }),
	};
}

export function parseResumeArguments(
	args: Record<string, unknown>,
): ResumeInput {
	refuseUnknownArguments(args, "resume", ["priorRunId"]);
	return validateResumeInput(args);
}

function validateResumeInput(
	args: ResumeInput | Record<string, unknown>,
): ResumeInput {
	return { priorRunId: validateNonEmptyString(args.priorRunId, "priorRunId") };
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

export function parseCommentArguments(
	args: Record<string, unknown>,
): CommentInput {
	for (const key of Reflect.ownKeys(args)) {
		if (!COMMENT_KEYS.has(String(key))) {
			throw new Error(`comment does not accept argument "${String(key)}"`);
		}
	}
	return validateCommentInput(args);
}

/**
 * The owner's approval is checked here, before the run is read or anything
 * is posted, so no caller can post without `ownerApproved: true`.
 */
function validateCommentInput(
	args: CommentInput | Record<string, unknown>,
): CommentInput {
	if (args.ownerApproved !== true) {
		throw new Error(
			"comment refused: ownerApproved must be true after the owner asked to post",
		);
	}
	const priorRunId = validateNonEmptyString(args.priorRunId, "priorRunId");
	const dismissed = parseDismissed(args.dismissed);
	const lowAdvisory = parseLowAdvisory(args.lowAdvisory);
	return {
		ownerApproved: true,
		priorRunId,
		dismissed,
		lowAdvisory,
		...(isNonEmptyString(args.verifyRunId)
			? { verifyRunId: args.verifyRunId }
			: {}),
		...(isNonEmptyString(args.head) ? { head: args.head } : {}),
		...(args.pr === undefined ? {} : { pr: args.pr as number | string }),
	};
}

export function parseReviewArguments(
	args: Record<string, unknown>,
): ReviewInput {
	refuseUnknownArguments(args, "review", [
		"base",
		"head",
		"seats",
		"lenses",
		"scopingNote",
		...ROUND_KEYS,
	]);
	return validateReviewInput(args);
}

function validateReviewInput(
	args: ReviewInput | Record<string, unknown>,
): ReviewInput {
	const base = validateNonEmptyString(args.base, "base");
	const head = validateNonEmptyString(args.head, "head");
	// Shape only, so a badly shaped argument is a usage error here as in
	// verify. What the values name (a seat, a lens) is checked in the action.
	optionalStringArray(args.seats, "seats");
	optionalStringArray(args.lenses, "lenses");
	optionalNonEmptyString(args.scopingNote, "scopingNote");
	return {
		base,
		head,
		...(args.seats === undefined ? {} : { seats: args.seats }),
		...(args.lenses === undefined ? {} : { lenses: args.lenses }),
		...(args.scopingNote === undefined
			? {}
			: { scopingNote: args.scopingNote }),
		...validateRoundInput(args),
	};
}

function resolveDependencies(deps: ActionDependencies | undefined) {
	return {
		env: deps?.env ?? processEnv,
		home: deps?.home ?? homedir(),
		diagnose: deps?.diagnose ?? diagnoseReadiness,
		load: deps?.loadConfig ?? loadConfig,
		panelOf: deps?.resolvePanel ?? resolvePanel,
		review: deps?.runReview ?? runReview,
		oidOf: deps?.resolveCommitOid ?? resolveCommitOid,
		suggest: deps?.suggestLenses ?? suggestLenses,
		verify: deps?.runVerify ?? runVerify,
		postComment: deps?.postComment ?? postCloseoutComment,
		runGh: deps?.runGh ?? defaultRunGh,
		resume: deps?.resumeRun ?? resumeRun,
		keyOf: deps?.recordKey ?? ownerRecordKey,
		checkKey: deps?.checkRecordKey ?? ownerRecordKeyCheck,
	};
}

type Resolved = ReturnType<typeof resolveDependencies>;

function ownerKey(
	resolved: Resolved,
	repoDir: string,
	create: boolean,
	refusal: string,
): Buffer {
	try {
		return resolved.keyOf({
			repoDir,
			env: resolved.env,
			home: resolved.home,
			create,
		});
	} catch (error) {
		const fix = error instanceof RecordKeyError ? ` ${error.fix}` : "";
		throw new Error(
			`${refusal}: ${error instanceof Error ? error.message : String(error)}.${fix}`,
		);
	}
}

async function requireReady(resolved: Resolved, repoDir: string) {
	const report = await resolved.diagnose({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
	if (!report.ready) {
		throw new Error(renderReadiness(report));
	}
}

/** Resolves review's commit range, with review's refusals. */
function resolveRange(
	resolved: Resolved,
	repoDir: string,
	base: string,
	head: string,
): { baseRevision: string; headRevision: string } {
	const baseRevision = resolved.oidOf(repoDir, base);
	const headRevision = resolved.oidOf(repoDir, head);
	if (baseRevision === headRevision) {
		throw new Error("Review refused: base and head resolve to the same commit");
	}
	return { baseRevision, headRevision };
}

function loadOwnerConfig(resolved: Resolved, repoDir: string) {
	return resolved.load({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
}

function progress(context: ActionContext) {
	const startedAt = context.startedAt ?? Date.now();
	return {
		elapsed: () => Date.now() - startedAt,
		emit: (view: ReviewProgressView) => context.onProgress?.(view),
	};
}

function roundContext(
	resolved: Resolved,
	repoDir: string,
	headOid: string,
	input: RoundInput,
	config: { defaults: { prComment?: "auto" | "ownerApproved" } },
	signal: AbortSignal | undefined,
): RoundContext {
	return {
		...(signal === undefined ? {} : { signal }),
		runGh: resolved.runGh,
		repoDir,
		headOid,
		request: roundRequest(input),
		mode: config.defaults.prComment ?? "auto",
	};
}

/** The report, then one plain line per round post, such as `PR comment: posted to #12`. */
function withRoundLines(report: string, lines: readonly string[]): string {
	return lines.length === 0 ? report : `${report}\n\n${lines.join("\n")}`;
}

function textResult(text: string): ActionResult {
	return { content: [{ type: "text", text }] };
}

/** The ids a verify or comment call names, as F-ids only. */
type JudgedIds = {
	kept: string[];
	dismissed: CloseoutJudgmentRow[];
	lowAdvisory: string[];
};

/**
 * Expands every G-id to its member F-ids, from the grouping the review
 * recorded in its signed `execution.json` (the one its reply and PR comment
 * showed). Calls with F-ids only are returned as they are. A G-id needs that
 * grouping to have grouped, placing every F-id of `findings.json` exactly
 * once; with no grouping step, a lost grouping or anything else, G-ids are
 * refused and the caller is asked for F-ids. A dismissed G-id gives its
 * reason to each member. An F-id named in one list both by itself and
 * through its group, or through two groups, is refused.
 */
function expandGroupIds(
	/** The review record, already loaded and checked as the owner's. */
	review: PriorRun,
	ids: JudgedIds,
	refusal: string,
): JudgedIds {
	const named = [
		...ids.kept,
		...ids.dismissed.map((row) => row.id),
		...ids.lowAdvisory,
	];
	if (!named.some(isGroupId)) {
		return ids;
	}
	const recorded = recordedGrouping(review.executionText, review.findingsText);
	if (recorded.kind === "none") {
		throw new Error(
			`${refusal}: G-ids need the review's signed grouping (the one its execution.json records, grouping every finding once), and run "${review.runId}" has none (${recorded.why}); pass F-ids instead`,
		);
	}
	const groups = recorded.groups;
	const members = new Map(groups.map((group) => [group.id, group.findingIds]));
	const expand = (id: string): string[] => {
		if (!isGroupId(id)) {
			return [id];
		}
		const found = members.get(id);
		if (found === undefined) {
			throw new Error(`${refusal}: ${id} is not a group in the review record`);
		}
		return found;
	};
	// An F-id named twice in one list, once through its group, is refused:
	// the caller said it two ways and should say it once.
	const once = <T>(
		list: string,
		rows: readonly T[],
		idOf: (row: T) => string,
		withId: (row: T, id: string) => T,
	): T[] => {
		const named = new Map<string, string>();
		return rows.flatMap((row) => {
			const id = idOf(row);
			const how = isGroupId(id) ? `through ${id}` : `as ${id}`;
			return expand(id).map((member) => {
				const earlier = named.get(member);
				if (earlier !== undefined) {
					throw new Error(
						`${refusal}: ${member} is named twice in ${list} (${earlier} and ${how}); name it once`,
					);
				}
				named.set(member, how);
				return withId(row, member);
			});
		});
	};
	const plain = (id: string) => id;
	const same = (_row: string, id: string) => id;
	return {
		kept: once("keptFindingIds", ids.kept, plain, same),
		dismissed: once(
			"dismissed",
			ids.dismissed,
			(row) => row.id,
			(row, id) => ({ ...row, id }),
		),
		lowAdvisory: once("lowAdvisory", ids.lowAdvisory, plain, same),
	};
}

export async function diagnoseAction(
	input: RepositoryInput & DiagnoseInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const repoDir = canonicalizeRepository(input.repoDir);
	const report = await resolved.diagnose({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
	// Review refuses to start without a usable record key,
	// so diagnose checks it too, without creating it.
	const keyProblem = resolved.checkKey({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
	const shown =
		keyProblem === undefined || keyProblem.warning
			? report
			: {
					ready: false,
					rows: [
						...report.rows,
						{
							prerequisite: `record key ${recordKeyPath(resolveConfigPath({ env: resolved.env, home: resolved.home }))}`,
							remediation: `${keyProblem.cause}. ${keyProblem.fix}`,
						},
					],
				};
	// A warning never changes readiness: it is shown after the report,
	// outside its remediation rows, at most 1,500 characters, and the
	// report keeps room for it so the reply stays within the cap. The
	// cause already names the record key, so it is not prefixed again.
	const warning = keyProblem?.warning
		? `\n## Warnings\n- ${truncateCodePoints(`${keyProblem.cause}. ${keyProblem.fix}`, 1_500)}`
		: "";
	const reserve = new TextEncoder().encode(warning).length;
	return textResult(`${renderReadiness(shown, reserve)}${warning}`);
}

export async function verifyAction(
	input: RepositoryInput & VerifyInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const repoDir = canonicalizeRepository(input.repoDir);
	const valid = validateVerifyInput(input);
	const { priorRunId, head, seats, scopingNote } = valid;
	await requireReady(resolved, repoDir);
	const config = loadOwnerConfig(resolved, repoDir);
	// The review record lives in the reviewed repository: it is taken only
	// when it is signed with the owner's record key, checked here before any
	// seat runs. Verify never creates the key.
	const verifyKey = ownerKey(resolved, repoDir, false, "Verify refused");
	// The prior is the review or the latest verify of it; the whole chain is
	// authenticated here, and refused when it is not one line of signed links.
	const chain = loadChainPrior(repoDir, priorRunId, verifyKey);
	const prior = chain.review;
	// G-ids become F-ids here, before anything else reads them: verify
	// itself checks F-ids and regression ids only.
	const judged = expandGroupIds(
		prior,
		{
			kept: valid.keptFindingIds ?? [],
			dismissed: valid.dismissed ?? [],
			lowAdvisory: valid.lowAdvisory ?? [],
		},
		"Verify refused",
	);
	const { dismissed } = judged;
	const state = chainState(prior.findings, chain.links);
	// Omitted on a chained verify: every id still open.
	const keptFindingIds =
		valid.keptFindingIds === undefined
			? defaultKeptIds(chain, state, dismissed, judged.lowAdvisory)
			: judged.kept;
	// Checked against the review and the chain before any seat runs; the
	// first verify's lows it leaves out become low/advisory.
	const lowAdvisory = judgeRound(
		state,
		chain.links,
		keptFindingIds,
		dismissed,
		judged.lowAdvisory,
	);
	const headRevision = resolved.oidOf(repoDir, head);
	const panel = planVerifySeats(config, seats);
	const reviewFindings = prior.findings;
	const roster = compactPanelRoster(panel);
	emit({
		phase: "verify",
		event: "started",
		elapsedMs: elapsed(),
		total: panel.length,
		completed: 0,
		active: 0,
		roster,
	});
	const result = await resolved.verify(
		{
			repoDir,
			config,
			priorRunId,
			headRevision,
			keptFindingIds,
			dismissed,
			lowAdvisory,
			...(seats === undefined ? {} : { seats }),
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
		},
		{
			recordKey: verifyKey,
			...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			onProgress: (event) =>
				emit({ ...progressFromVerifyEvent(event, elapsed()), roster }),
		},
	);
	const report = renderVerifyResult(result, panel, ROUND_REPLY_RESERVE);
	const roundLines = await postVerifyRound(
		roundContext(
			resolved,
			repoDir,
			result.headOid,
			valid,
			config,
			context.signal,
		),
		{
			result,
			panel,
			dismissed,
			lowAdvisory,
			reviewFindings,
			review: prior,
			recordKey: verifyKey,
			chain: chain.links,
			...(valid.closeOut === undefined ? {} : { closeOut: valid.closeOut }),
			...(valid.closeOut === true
				? {
						finalCheck: () =>
							runFinalCheck(
								resolved,
								repoDir,
								config,
								verifyKey,
								{
									runId: path.basename(result.recordPath),
									headOid: result.headOid,
								},
								context.signal,
							),
					}
				: {}),
		},
	);
	return textResult(withRoundLines(report, roundLines));
}

/**
 * The final check before the card (S-6): one seat, the owner's first verify
 * seat, from the review head to the latest verify's head, every resolved id
 * under the undo guard. It is a signed link of the chain.
 */
async function runFinalCheck(
	resolved: ReturnType<typeof resolveDependencies>,
	repoDir: string,
	config: ReturnType<typeof loadOwnerConfig>,
	key: Buffer,
	from: { runId: string; headOid: string },
	signal: AbortSignal | undefined,
): Promise<RunVerifyResult> {
	return await resolved.verify(
		{
			repoDir,
			config,
			priorRunId: from.runId,
			headRevision: from.headOid,
			keptFindingIds: [],
			final: true,
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
		},
		{
			recordKey: key,
			...(signal === undefined ? {} : { abortSignal: signal }),
		},
	);
}

/**
 * Whether `comment` runs the final check: some round resolved an id, and
 * the chain does not already end in a final check that lost no seat.
 */
function finalCheckDue(
	state: ChainState,
	links: readonly ChainLink[],
): boolean {
	const tip = links.at(-1);
	if (tip?.final === true && tip.lost.length === 0) {
		return false;
	}
	return [...state.items.values()].some(
		(item) => item.state.status === "resolved",
	);
}

/** A refusal worded as comment's own. */
function commentError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(
		message.startsWith("comment refused:")
			? message
			: `comment refused: ${message.replace(/^Verify refused:\s*/u, "")}`,
	);
}

export async function commentAction(
	input: RepositoryInput & CommentInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const repoDir = canonicalizeRepository(input.repoDir);
	const valid = validateCommentInput(input);
	const { priorRunId } = valid;
	// Comment never creates the key, and takes the review (and any verify)
	// record only when it is signed with it.
	const commentKey = ownerKey(resolved, repoDir, false, "comment refused");
	const facts = loadCloseoutRun(repoDir, priorRunId, commentKey);
	const { dismissed, lowAdvisory } = expandGroupIds(
		facts.run,
		{ kept: [], dismissed: valid.dismissed, lowAdvisory: valid.lowAdvisory },
		"comment refused",
	);
	// The card shows where the review's verify chain left every id, from
	// the owner's signed records only: the chain must be one line of links.
	const chainNow = () => {
		try {
			return loadVerifyChain(repoDir, facts.run.runId, commentKey);
		} catch (error) {
			throw commentError(error);
		}
	};
	let links = chainNow();
	let tip = links.at(-1);
	if (valid.verifyRunId !== undefined) {
		// A named verify is authenticated as a verify of this review, and
		// must be the chain's latest: the card is about where the rounds
		// stopped.
		const named = assertFixedResolved(
			repoDir,
			valid.verifyRunId,
			[],
			facts.run.runId,
			commentKey,
		);
		if (tip === undefined || named.runId !== tip.runId) {
			throw new Error(
				`comment refused: verify run "${named.runId}" is not the latest verify of review "${facts.run.runId}"${tip === undefined ? "" : `; pass the latest, "${tip.runId}"`}`,
			);
		}
	}
	// The rounds and the head come from signed records only: the chain's
	// links, each numbered by its place.
	let state = chainState(facts.run.findings, links);
	let rounds = chainRounds(links);
	const headOid =
		tip !== undefined && isOid(tip.headOid)
			? tip.headOid
			: facts.run.meta.headOid;
	const card = (links?: CloseoutLinks) =>
		assembleCloseoutComment({
			findings: facts.run.findings,
			state,
			rounds,
			panel: facts.panel,
			lost: facts.lost,
			verifyLost: rounds.flatMap((row) => row.lost ?? []),
			meta: { ...facts.run.meta, headOid },
			dismissed,
			lowAdvisory,
			runIds: {
				review: facts.run.runId,
				...(tip === undefined ? {} : { verify: tip.runId }),
			},
			...(links === undefined ? {} : { links }),
		});
	const built = () => {
		try {
			return card();
		} catch (error) {
			throw commentError(error);
		}
	};
	// Every refusal that costs no seat comes first.
	let body = built();
	let latest: string | undefined;
	if (tip !== undefined && finalCheckDue(state, links)) {
		// The final check reports and never blocks the owner's card: what it
		// finds is open on it, and a lost seat is named on `Lost:`.
		await requireReady(resolved, repoDir);
		const config = loadOwnerConfig(resolved, repoDir);
		try {
			await runFinalCheck(
				resolved,
				repoDir,
				config,
				commentKey,
				tip,
				context.signal,
			);
		} catch (error) {
			throw commentError(error);
		}
		const openBefore = state.open.length;
		links = chainNow();
		tip = links.at(-1);
		latest = tip?.final === true ? tip.runId : undefined;
		state = chainState(facts.run.findings, links);
		rounds = chainRounds(links);
		// When nothing was open, the owner approved a card with nothing open:
		// what the check found stops it, with the step that goes on.
		if (openBefore === 0 && tip?.final === true) {
			if (tip.lost.length > 0) {
				throw new Error(
					`comment refused: the final check, verify ${tip.link}, lost its seat, so nothing was checked; run comment again to check again`,
				);
			}
			if (state.open.length > 0) {
				throw new Error(
					`comment refused: the final check, verify ${tip.link}, reported ${state.open.join(", ")}; verify a fix against the latest verify, "${tip.runId}", or run comment again to post the card with ${state.open.length === 1 ? "it" : "them"} open`,
				);
			}
		}
		body = built();
	}
	const post = () =>
		resolved.postComment({
			repository: repoDir,
			headOid,
			body,
			render: (listing) =>
				card(
					roundCommentLinks(
						listing.comments,
						listing,
						facts.run.runId,
						rounds.map((row) => row.runId),
					),
				),
			...(valid.pr === undefined ? {} : { pr: valid.pr }),
		});
	let posted: ReturnType<typeof post>;
	try {
		posted = post();
	} catch (error) {
		if (latest === undefined) {
			throw error;
		}
		// The final check ran and is a signed link: say so, so the next
		// verify chains from it.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}; the final check is recorded: the latest verify is now "${latest}"`,
		);
	}
	const shown = posted.body ?? body;
	return textResult(
		[
			`Posted comment on PR #${posted.pr} (${posted.action})`,
			posted.url,
			...(latest === undefined
				? []
				: [
						`Latest verify: \`${latest}\` (the final check); verify against it next`,
					]),
			"",
			shown,
		].join("\n"),
	);
}

export async function resumeAction(
	input: RepositoryInput & ResumeInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const repoDir = canonicalizeRepository(input.repoDir);
	const { priorRunId } = validateResumeInput(input);
	await requireReady(resolved, repoDir);
	// Resume never creates the key: a record it did not sign is not
	// this owner's.
	const resumeKey = ownerKey(resolved, repoDir, false, "Resume refused");
	// Seats, lenses and commits all come from the record itself, once
	// its plan's signature checks out.
	const run = loadResumable(repoDir, priorRunId, resumeKey);
	// Models, extension paths and prompts come from the owner config and
	// the package, never from the record inside the reviewed repository.
	const config = loadOwnerConfig(resolved, repoDir);
	const panel: PlannedSeat[] = run.plan.seats.map((seat) => ({
		...seat,
		lensPrompt: "",
	}));
	const roster = compactPanelRoster(panel);
	const result = await resolved.resume(run, {
		config,
		recordKey: resumeKey,
		...(context.signal === undefined ? {} : { abortSignal: context.signal }),
		// Started once the lock is held and the record re-read, so the
		// count is what will actually run.
		onStart: ({ toRun }) =>
			emit({
				phase: run.plan.kind,
				event: "started",
				elapsedMs: elapsed(),
				total: toRun,
				completed: 0,
				active: 0,
				roster,
			}),
		onProgress: (event) =>
			emit({ ...progressFromReviewEvent(event, elapsed()), roster }),
	});
	const resumed = result.resumedSeats;
	const lost = result.lostSeats;
	const label = (seats: PlannedSeat[]) =>
		seats.map((seat) => `${seat.rosterId}/${seat.lens}`).join(", ");
	const headline = [
		`Resumed ${run.runId}: ran ${resumed.length} of ${panel.length} planned seats again${
			resumed.length === 0 ? "" : ` (${label(resumed)})`
		}; kept ${panel.length - resumed.length - lost.length} as recorded${
			lost.length === 0
				? ""
				: `; lost ${lost.length} that could not be rebuilt from the owner config (${label(lost)})`
		}.`,
		...(result.scopingNoteDropped ? [SCOPING_NOTE_DROPPED] : []),
	].join("\n");
	const suggestions = resolved.suggest(
		repoDir,
		run.plan.baseOid,
		run.plan.headOid,
	);
	// The findings this resume stamped, never findings.json read back.
	const body = renderReviewResult({
		recordPath: result.recordPath,
		panel,
		result,
		suggestions,
		findings: result.findings,
	});
	return textResult(`${headline}\n\n${body}`);
}

export async function reviewAction(
	input: RepositoryInput & ReviewInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const repoDir = canonicalizeRepository(input.repoDir);
	const valid = validateReviewInput(input);
	const { base, head } = valid;
	const { baseRevision, headRevision } = resolveRange(
		resolved,
		repoDir,
		base,
		head,
	);
	await requireReady(resolved, repoDir);
	const config = loadOwnerConfig(resolved, repoDir);
	const seats = optionalStringArray(valid.seats, "seats");
	const lenses = optionalStringArray(valid.lenses, "lenses");
	const scopingNote = optionalNonEmptyString(valid.scopingNote, "scopingNote");

	const panel: PlannedSeat[] = resolved.panelOf({
		config,
		lensTable: loadLensTable(),
		...(seats === undefined ? {} : { seats }),
		...(lenses === undefined ? {} : { lenses }),
	});

	const consolidator = planConsolidator(config);
	const reviewKey = ownerKey(resolved, repoDir, true, "Review refused");
	const roster = compactPanelRoster(panel);
	emit({
		phase: "review",
		event: "started",
		elapsedMs: elapsed(),
		total: panel.length,
		completed: 0,
		active: 0,
		roster,
	});
	const result = await resolved.review(
		{
			repoDir,
			baseRef: base,
			baseRevision,
			headRevision,
			revision: headRevision,
			seats: panel,
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
			...(consolidator === undefined ? {} : { consolidator }),
		},
		{
			...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			recordKey: reviewKey,
			onProgress: (event) =>
				emit({ ...progressFromReviewEvent(event, elapsed()), roster }),
		},
	);
	const suggestions = resolved.suggest(repoDir, baseRevision, headRevision);
	// The findings this run stamped, never findings.json read back: a writer
	// in the repository could replace it after the record was sealed.
	const { findings } = result;

	const report = renderReviewResult({
		recordPath: result.recordPath,
		panel,
		result,
		suggestions,
		...(scopingNote === undefined ? {} : { scopingNote }),
		findings,
		reserveBytes: ROUND_REPLY_RESERVE,
	});
	const roundLines = await postReviewRound(
		roundContext(
			resolved,
			repoDir,
			headRevision,
			valid,
			config,
			context.signal,
		),
		{
			runId: path.basename(result.recordPath),
			baseRef: base,
			baseOid: baseRevision,
			headOid: headRevision,
			panel,
			result,
			suggestions,
			findings,
		},
	);
	return textResult(withRoundLines(report, roundLines));
}

/** How many pieces of evidence suggest shows for one lens before counting. */
const SUGGEST_EVIDENCE = 3;

/**
 * The lenses the diff's rules suggest, each with its reason and evidence,
 * before any seat runs. It runs no seat, checks no login and never touches
 * the record key: it reads the commit range and the owner's default lenses.
 * It adds no lens to any review; the caller chooses and passes `lenses`.
 */
export async function suggestAction(
	input: RepositoryInput & SuggestInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const repoDir = canonicalizeRepository(input.repoDir);
	const { base, head } = validateSuggestInput(input);
	const { baseRevision, headRevision } = resolveRange(
		resolved,
		repoDir,
		base,
		head,
	);
	const ownerLenses = loadOwnerConfig(resolved, repoDir).defaults.lenses ?? [];
	const suggestions = resolved.suggest(repoDir, baseRevision, headRevision);
	const range = truncateCodePoints(`${base}...${head}`, 200);
	return textResult(
		renderSuggestResult({
			head: [
				"# Lens suggestions",
				`${range} · holistic always runs · owner default lenses: ${
					ownerLenses.length === 0 ? "none" : ownerLenses.join(", ")
				}`,
			],
			rows: !Array.isArray(suggestions)
				? [formatSuggestionsUnavailable(suggestions)]
				: suggestions.length === 0
					? ["- No suggestion rule matched this change."]
					: suggestions.map((row) =>
							formatSuggestion(row, {
								evidence: SUGGEST_EVIDENCE,
								...(ownerLenses.includes(row.lens)
									? { note: "already on, owner default" }
									: {}),
							}),
						),
			tail: [
				"",
				"No seat ran. Choose the lenses yourself, with a reason for each, then call review with the extra ones as `lenses`.",
			],
		}),
	);
}
