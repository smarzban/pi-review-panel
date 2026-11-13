/**
 * The `review_panel` actions as plain functions: no Pi tool envelope and no
 * schema library, so any front end (the Pi tool, a standalone CLI) can call
 * them. Each `parse*Arguments` validates a raw argument record the way the
 * tool always has; each `*Action` runs one action and returns the tool's
 * result object.
 *
 * Each action validates its own input with the same checks, in the same order
 * and with the same messages as its parser, so a front end that builds the
 * input itself gets the refusals the tool gives. The parser adds only the
 * refusal of argument keys the action does not take.
 *
 * No Pi host and no TypeBox are needed to import or call these. Running a
 * seat (review, audit, verify, resume) and diagnose's model check still load
 * the Pi SDK (`@earendil-works/pi-coding-agent`) through a dynamic `import()`
 * in `src/seat/sdk-session.ts` and `src/config/readiness.ts`, so a front end
 * that runs those needs the SDK installed. Comment and the parsers do not.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { env as processEnv } from "node:process";

import { resolveAuditPanel } from "../config/audit-panel.js";
import { loadAuditPassTable } from "../config/audit-passes.js";
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
import { discoverPriorRecords } from "../run/prior-records.js";
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
	type RunAuditInput,
	type RunAuditOptions,
	type RunAuditResult,
	runAudit,
} from "../run/run-audit.js";
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
import {
	compactPanelRoster,
	progressFromAuditEvent,
	progressFromReviewEvent,
	progressFromVerifyEvent,
	type ReviewProgressView,
	renderAuditResult,
	renderReadiness,
	renderReviewResult,
	renderVerifyResult,
} from "../tool/review-presentation.js";

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
	runAudit?: (
		input: RunAuditInput,
		options?: RunAuditOptions,
	) => Promise<RunAuditResult>;
	resolveCommitOid?: typeof resolveCommitOid;
	suggestLenses?: typeof suggestLenses;
	runVerify?: (
		input: RunVerifyInput,
		options?: RunVerifyOptions,
	) => Promise<RunVerifyResult>;
	postComment?: (input: PostCloseoutInput) => PostCloseoutResult;
	resumeRun?: (
		run: ResumableRun,
		options?: ResumeOptions,
	) => Promise<ResumeResult>;
	/**
	 * The owner's record key. By default it is read from `record-key` beside
	 * the owner config, and created there by a first review or audit.
	 */
	recordKey?: (input: RecordKeyInput) => Buffer;
	/**
	 * The `diagnose` check of the record key, which never writes. By default it
	 * checks `record-key` beside the owner config the way review and audit use
	 * it.
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
	/** Create the key when it is missing: review and audit do, resume never. */
	create: boolean;
};

/** Reads (or creates) the record key in the folder of the owner config. */
export function ownerRecordKey(input: RecordKeyInput): Buffer {
	return loadRecordKey(
		recordKeyPath(resolveConfigPath({ env: input.env, home: input.home })),
		{ create: input.create, repoDir: input.repoDir },
	);
}

/** Checks the owner's record key for `diagnose`, without writing anything. */
export function ownerRecordKeyCheck(
	input: Omit<RecordKeyInput, "create">,
): RecordKeyProblem | undefined {
	let configPath: string;
	try {
		configPath = resolveConfigPath({ env: input.env, home: input.home });
	} catch {
		// A bad config override is the configuration row's to report.
		return undefined;
	}
	return checkRecordKey(recordKeyPath(configPath), {
		repoDir: input.repoDir,
	});
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

export type AuditInput = {
	seats?: string[];
	passes?: string[];
	scopingNote?: string;
};

export type VerifyInput = {
	priorRunId: string;
	head: string;
	keptFindingIds: string[];
	seats?: string[];
	scopingNote?: string;
};

export type ResumeInput = { priorRunId: string };

export type CommentInput = {
	ownerApproved: true;
	priorRunId: string;
	dismissed: CloseoutJudgmentRow[];
	lowAdvisory: string[];
	verifyRunId?: string;
	head?: string;
	pr?: number | string;
};

/**
 * `seats`, `lenses` and `scopingNote` stay raw here: review checks them only
 * after it has resolved both commits and the panel is ready, so a call that
 * is wrong in two ways reports the same problem first as it always has.
 * `reviewAction` validates them at that point.
 */
export type ReviewInput = {
	base: string;
	head: string;
	seats?: unknown;
	lenses?: unknown;
	scopingNote?: unknown;
};

export function parseDiagnoseArguments(
	args: Record<string, unknown>,
): DiagnoseInput {
	refuseUnknownArguments(args, "diagnose", []);
	return {};
}

export function parseAuditArguments(args: Record<string, unknown>): AuditInput {
	refuseUnknownArguments(args, "audit", ["seats", "passes", "scopingNote"]);
	return validateAuditInput(args);
}

function validateAuditInput(
	args: AuditInput | Record<string, unknown>,
): AuditInput {
	const seats = optionalStringArray(args.seats, "seats");
	const passes = optionalStringArray(args.passes, "passes");
	const scopingNote = optionalNonEmptyString(args.scopingNote, "scopingNote");
	return {
		...(seats === undefined ? {} : { seats }),
		...(passes === undefined ? {} : { passes }),
		...(scopingNote === undefined ? {} : { scopingNote }),
	};
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
	]);
	return validateVerifyInput(args);
}

function validateVerifyInput(
	args: VerifyInput | Record<string, unknown>,
): VerifyInput {
	const priorRunId = validateNonEmptyString(args.priorRunId, "priorRunId");
	const head = validateNonEmptyString(args.head, "head");
	if (!Array.isArray(args.keptFindingIds)) {
		throw new Error("keptFindingIds must be an array of non-empty strings");
	}
	const keptFindingIds = args.keptFindingIds.map((id, index) =>
		validateNonEmptyString(id, `keptFindingIds[${index}]`),
	);
	const seats = optionalStringArray(args.seats, "seats");
	const scopingNote = optionalNonEmptyString(args.scopingNote, "scopingNote");
	return {
		priorRunId,
		head,
		keptFindingIds,
		...(seats === undefined ? {} : { seats }),
		...(scopingNote === undefined ? {} : { scopingNote }),
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
	]);
	return validateReviewInput(args);
}

function validateReviewInput(
	args: ReviewInput | Record<string, unknown>,
): ReviewInput {
	const base = validateNonEmptyString(args.base, "base");
	const head = validateNonEmptyString(args.head, "head");
	return {
		base,
		head,
		...(args.seats === undefined ? {} : { seats: args.seats }),
		...(args.lenses === undefined ? {} : { lenses: args.lenses }),
		...(args.scopingNote === undefined
			? {}
			: { scopingNote: args.scopingNote }),
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
		audit: deps?.runAudit ?? runAudit,
		oidOf: deps?.resolveCommitOid ?? resolveCommitOid,
		suggest: deps?.suggestLenses ?? suggestLenses,
		verify: deps?.runVerify ?? runVerify,
		postComment: deps?.postComment ?? postCloseoutComment,
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

function textResult(text: string): ActionResult {
	return { content: [{ type: "text", text }] };
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

export async function diagnoseAction(
	input: RepositoryInput & DiagnoseInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { repoDir } = input;
	const report = await resolved.diagnose({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
	// Review and audit refuse to start without a usable record key,
	// so diagnose checks it too, without creating it.
	const keyProblem = resolved.checkKey({
		repoDir,
		env: resolved.env,
		home: resolved.home,
	});
	const shown =
		keyProblem === undefined
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
	return textResult(renderReadiness(shown));
}

export async function auditAction(
	input: RepositoryInput & AuditInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const { repoDir } = input;
	const { seats, passes, scopingNote } = validateAuditInput(input);
	await requireReady(resolved, repoDir);
	const config = loadOwnerConfig(resolved, repoDir);
	const panel = resolveAuditPanel({
		config,
		passTable: loadAuditPassTable(),
		...(seats === undefined ? {} : { seats }),
		...(passes === undefined ? {} : { passes }),
	});
	const revision = resolved.oidOf(repoDir, "HEAD");
	const auditKey = ownerKey(resolved, repoDir, true, "Audit refused");
	const roster = compactPanelRoster(panel);
	emit({
		phase: "audit",
		event: "started",
		elapsedMs: elapsed(),
		total: panel.length,
		completed: 0,
		active: 0,
		roster,
	});
	const result = await resolved.audit(
		{
			repoDir,
			revision,
			seats: panel,
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
		},
		{
			...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			recordKey: auditKey,
			onProgress: (event) =>
				emit({ ...progressFromAuditEvent(event, elapsed()), roster }),
		},
	);
	return textResult(
		renderAuditResult({ recordPath: result.recordPath, panel, result }),
	);
}

export async function verifyAction(
	input: RepositoryInput & VerifyInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const { repoDir } = input;
	const { priorRunId, head, keptFindingIds, seats, scopingNote } =
		validateVerifyInput(input);
	await requireReady(resolved, repoDir);
	const config = loadOwnerConfig(resolved, repoDir);
	const headRevision = resolved.oidOf(repoDir, head);
	const panel = planVerifySeats(config, seats);
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
			...(seats === undefined ? {} : { seats }),
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
		},
		{
			...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			onProgress: (event) =>
				emit({ ...progressFromVerifyEvent(event, elapsed()), roster }),
		},
	);
	return textResult(renderVerifyResult(result));
}

export async function commentAction(
	input: RepositoryInput & CommentInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { repoDir } = input;
	const valid = validateCommentInput(input);
	const { priorRunId, dismissed, lowAdvisory } = valid;
	const facts = loadCloseoutRun(repoDir, priorRunId);
	const accounted = accountCloseoutFindings({
		findings: facts.run.findings,
		dismissed,
		lowAdvisory,
	});
	if (accounted.fixed.length > 0) {
		if (valid.verifyRunId === undefined) {
			throw new Error(
				`comment refused: ${accounted.fixed.map((row) => row.id).join(", ")} still outstanding; pass verifyRunId after a clean verify or dismiss them`,
			);
		}
		assertFixedResolved(
			repoDir,
			valid.verifyRunId,
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
		...(valid.head === undefined ? {} : { headRef: valid.head }),
	});
	const posted = resolved.postComment({
		repository: repoDir,
		body,
		...(valid.pr === undefined ? {} : { pr: valid.pr }),
	});
	return textResult(
		[
			`Posted comment on PR #${posted.pr} (${posted.action})`,
			posted.url,
			"",
			body,
		].join("\n"),
	);
}

export async function resumeAction(
	input: RepositoryInput & ResumeInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const { repoDir } = input;
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
	const progressOf =
		run.plan.kind === "audit"
			? progressFromAuditEvent
			: progressFromReviewEvent;
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
		onProgress: (event) => emit({ ...progressOf(event, elapsed()), roster }),
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
	let body: string;
	if (run.plan.kind === "audit") {
		body = renderAuditResult({ recordPath: result.recordPath, panel, result });
	} else {
		const plannedLenses = new Set(panel.map((seat) => seat.lens));
		const suggestions = resolved
			.suggest(repoDir, run.plan.baseOid, run.plan.headOid)
			.filter((row) => !plannedLenses.has(row.lens));
		const findings = readStampedFindings(result.recordPath);
		body = renderReviewResult({
			recordPath: result.recordPath,
			panel,
			result,
			suggestions,
			...(findings === undefined ? {} : { findings }),
		});
	}
	return textResult(`${headline}\n\n${body}`);
}

export async function reviewAction(
	input: RepositoryInput & ReviewInput,
	context: ActionContext = {},
): Promise<ActionResult> {
	const resolved = resolveDependencies(context.deps);
	const { elapsed, emit } = progress(context);
	const { repoDir } = input;
	const valid = validateReviewInput(input);
	const { base, head } = valid;
	const baseRevision = resolved.oidOf(repoDir, base);
	const headRevision = resolved.oidOf(repoDir, head);
	if (baseRevision === headRevision) {
		throw new Error("Review refused: base and head resolve to the same commit");
	}
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
			priorRecordPaths: discoverPriorRecords(repoDir).map(
				(record) => record.path,
			),
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(config.defaults.seatBudgetMs === undefined
				? {}
				: { seatBudgetMs: config.defaults.seatBudgetMs }),
		},
		{
			...(context.signal === undefined ? {} : { abortSignal: context.signal }),
			recordKey: reviewKey,
			onProgress: (event) =>
				emit({ ...progressFromReviewEvent(event, elapsed()), roster }),
		},
	);
	const plannedLenses = new Set(panel.map((seat) => seat.lens));
	const suggestions = resolved
		.suggest(repoDir, baseRevision, headRevision)
		.filter((row) => !plannedLenses.has(row.lens));
	const findings = readStampedFindings(result.recordPath);

	return textResult(
		renderReviewResult({
			recordPath: result.recordPath,
			panel,
			result,
			suggestions,
			...(scopingNote === undefined ? {} : { scopingNote }),
			...(findings === undefined ? {} : { findings }),
		}),
	);
}
