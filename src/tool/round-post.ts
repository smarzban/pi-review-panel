/**
 * Posts each review round to the open pull request whose head is the run's
 * head: a review, then each verify, and once a verify finds every kept id
 * resolved with no regressions, the close-out card on its own. Every post is
 * a new comment; nothing here edits or deletes one.
 *
 * Posting is presentation, never part of the run: whatever goes wrong here
 * (no PR, no `gh`, a failed call) becomes one plain reply line, and the run's
 * result and exit code stay as they were.
 *
 * Bodies carry text written by seats, file names from the diff and refs.
 * Each such field goes through the one posted-text sanitizer
 * (`posted-text.ts`): plain text GitHub cannot turn into markup, with every
 * mention, reference and autolink broken, or a code span it cannot close.
 * A body is cut by whole rows to stay under GitHub's comment limit, and goes
 * to `gh` on stdin, never as an argument. `gh` runs asynchronously, so a
 * slow call never blocks Pi, and one round's calls share one deadline.
 */
import { execFile } from "node:child_process";
import path from "node:path";

import type { PrCommentMode } from "../config/schema.js";
import {
	GROUP_SEVERITY_LABEL,
	type GroupView,
	groupedView,
	groupingLostLine,
} from "../run/grouping.js";
import type { PriorRun } from "../run/prior-run.js";
import { renderSeatsLine } from "../run/render.js";
import type { RunReviewResult } from "../run/run-review.js";
import type { RunVerifyResult } from "../run/run-verify.js";
import type { Suggestion, SuggestionsUnavailable } from "../run/suggest.js";
import type { PlannedSeat, StampedFinding } from "../run/types.js";
import {
	type ChainLink,
	type ChainState,
	chainState,
	makeLink,
} from "../run/verify-chain.js";
import {
	accountCloseoutFindings,
	assembleCloseoutParts,
	type CloseoutJudgmentRow,
	type CloseoutLinks,
	type CloseoutVerifyRound,
} from "./closeout-comment.js";
import { type CloseoutRunFacts, closeoutFactsOf } from "./closeout-from-run.js";
import { parseJsonPages } from "./closeout-post.js";
import {
	chainRounds,
	REVIEW_ROUND_HEADING,
	roundCommentLinks,
} from "./closeout-rounds.js";
import {
	type CommentGroupRow,
	fitCommentBody,
	isRunMarkerFor,
	markerTail,
	postedCode,
	postedText,
	prCommentUrl,
} from "./posted-text.js";
import {
	CLOSEOUT_GENERATIONS,
	CLOSEOUT_POSTED_FILE,
	claimCloseout,
	claimRound,
	type HeldClaim,
	ROUND_DEADLINE_MS,
	type RoundClaim,
	settleCloseout,
	settleRound,
} from "./round-claim.js";

export { fitCommentBody, GITHUB_COMMENT_LIMIT } from "./posted-text.js";
export { claimRound, ROUND_DEADLINE_MS } from "./round-claim.js";

import {
	dispositionLabel,
	findingAttribution,
	formatSuggestion,
	formatSuggestionsUnavailable,
	inert,
	orderFindings,
	reviewHeadLines,
	reviewLostLine,
	truncateCodePoints,
	verifyFacts,
} from "./review-presentation.js";

/** Bytes the reply keeps free for the `PR comment:` lines. */
export const ROUND_REPLY_RESERVE = 2_048;
const REPLY_LINE_CHARS = 600;
/** Two reply lines and their separators fit in {@link ROUND_REPLY_RESERVE}. */
const REPLY_LINE_BYTES = 900;
const TITLE_CHARS = 300;
const EVIDENCE_CHARS = 1_000;
const FILE_CHARS = 200;
const OID_DISPLAY_LENGTH = 7;
/** A stalled `gh` must not hold the run: each call gets at most this long. */
const GH_TIMEOUT_MS = 30_000;
/** Room for a paginated comment listing that holds several full round comments. */
const GH_MAX_BUFFER = 64 * 1024 * 1024;

export const CLOSEOUT_ROUND_HEADING = "## Review panel · close-out";
/**
 * Written exclusively in the review's run record once its close-out card is
 * on the PR; no verify posts a close-out after it. The card is claimed
 * first with `closeout.claim-<g>` (see `round-claim.ts`).
 */
export const CLOSEOUT_POSTED_MARKER = CLOSEOUT_POSTED_FILE;

/**
 * Runs `gh`. It may answer synchronously or with a promise; the round awaits
 * either. `timeoutMs` is what is left of the round's deadline; `signal` is
 * the run's, and aborting it kills a running `gh`.
 */
export type RoundGhRunner = (
	args: readonly string[],
	options?: GhCallOptions,
) => string | Promise<string>;

export type GhCallOptions = {
	cwd?: string;
	input?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};

/** What one review or verify call asks of posting. */
export type RoundRequest = {
	/** `false` turns posting off for this run. */
	prComment?: boolean;
	/** Needed for any post when the owner config's mode is `ownerApproved`. */
	ownerApproved?: boolean;
	/** The PR to post to, instead of looking one up by the head commit. */
	pr?: number;
};

export type RoundContext = {
	runGh: RoundGhRunner;
	repoDir: string;
	headOid: string;
	request: RoundRequest;
	mode: PrCommentMode;
	/** An interrupted run posts nothing. */
	signal?: AbortSignal;
};

/** A reason not to post, said in the reply as `not posted (<reason>)`. */
class RoundSkip extends Error {}

/**
 * Runs the real `gh` without blocking the event loop. The body goes on
 * stdin. Errors are left as they are; {@link ghReason} reads them.
 */
export function defaultRunGh(
	args: readonly string[],
	options?: GhCallOptions,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"gh",
			[...args],
			{
				encoding: "utf8",
				cwd: options?.cwd,
				timeout: options?.timeoutMs ?? GH_TIMEOUT_MS,
				maxBuffer: GH_MAX_BUFFER,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					reject(Object.assign(error, { stderr }));
					return;
				}
				resolve(stdout);
			},
		);
		// A gh that exits before reading stdin must not crash the host.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(options?.input ?? "");
	});
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Seat-written text made safe to post: one line of plain text that GitHub
 * cannot turn into markup, mention or reference. See `posted-text.ts`.
 */
export function githubSafe(text: string, maxChars = TITLE_CHARS): string {
	return postedText(text, maxChars);
}

/** A file name or id as one code span it cannot close. */
function safeCode(text: string, maxChars = FILE_CHARS): string {
	return postedCode(text, maxChars);
}

/** A line of tool-owned text that carries owner-config names. */
function ownLine(text: string): string {
	return inert(text).replace(/[@\uFF20#]/gu, "$&\u200D");
}

/**
 * A tool-owned `Label: rest` line with its label bold. Only labels the tool
 * writes go through here; seat text is never bold.
 */
function boldLabel(line: string): string {
	return line.replace(/^([A-Z][A-Za-z ]*:)/u, "**$1**");
}

function shortOid(oid: string): string {
	return oid.slice(0, OID_DISPLAY_LENGTH);
}

function errorText(error: unknown): string {
	if (error === null || typeof error !== "object") {
		return String(error);
	}
	const stderr = (error as { stderr?: unknown }).stderr;
	const fromStderr =
		typeof stderr === "string"
			? stderr
			: Buffer.isBuffer(stderr)
				? stderr.toString("utf8")
				: "";
	if (fromStderr.trim() !== "") {
		return fromStderr;
	}
	return error instanceof Error ? error.message : String(error);
}

/** Why a `gh` call failed, as one short line. */
function ghReason(error: unknown): string {
	if (error instanceof RoundSkip) {
		return error.message;
	}
	const named = error as { name?: unknown; code?: unknown } | null;
	if (named?.name === "AbortError" || named?.code === "ABORT_ERR") {
		return "the run was interrupted";
	}
	if ((error as { code?: unknown } | null)?.code === "ENOENT") {
		return "gh is not installed";
	}
	if ((error as { killed?: unknown } | null)?.killed === true) {
		return "gh timed out";
	}
	return `gh failed: ${inert(truncateCodePoints(oneLine(errorText(error)), 200))}`;
}

function trimmed(raw: string): string {
	return raw.replace(/^\uFEFF/, "").trim();
}

function parseJson(raw: string, what: string): unknown {
	try {
		return JSON.parse(trimmed(raw));
	} catch {
		throw new RoundSkip(`gh returned unreadable ${what}`);
	}
}

type PrTarget = { repo: string; pr: number; author: string };

type Gh = ((args: readonly string[], stdin?: string) => Promise<string>) & {
	/** When the round's `gh` time runs out, as `Date.now()` reads it. */
	deadline: number;
};

/**
 * One round's `gh`: every call runs in the reviewed repository, stops once
 * the run is interrupted, and shares {@link ROUND_DEADLINE_MS}.
 */
function ghOf(ctx: RoundContext): Gh {
	const deadline = Date.now() + ROUND_DEADLINE_MS;
	const call = async (args: readonly string[], stdin?: string) => {
		if (ctx.signal?.aborted) {
			throw new RoundSkip("the run was interrupted");
		}
		const left = deadline - Date.now();
		if (left <= 0) {
			throw new RoundSkip(
				`gh took longer than ${ROUND_DEADLINE_MS / 1000} s in total`,
			);
		}
		return await ctx.runGh(args, {
			cwd: ctx.repoDir,
			timeoutMs: Math.min(GH_TIMEOUT_MS, left),
			...(stdin === undefined ? {} : { input: stdin }),
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
		});
	};
	return Object.assign(call, { deadline });
}

/** An explicit `pr` must be an open PR whose head is the run's head. */
async function checkNamedPr(
	gh: Gh,
	repo: string,
	pr: number,
	headOid: string,
): Promise<void> {
	let raw: string;
	try {
		raw = await gh(["api", `repos/${repo}/pulls/${pr}`]);
	} catch (error) {
		if (/HTTP 404|Not Found/.test(errorText(error))) {
			throw new RoundSkip(`#${pr} is not a pull request here`);
		}
		throw error;
	}
	const row = parseJson(raw, "the pull request") as {
		state?: unknown;
		head?: { sha?: unknown };
	} | null;
	if (row?.state !== "open") {
		throw new RoundSkip(`PR #${pr} is not open`);
	}
	if (row.head?.sha !== headOid) {
		throw new RoundSkip(`PR #${pr}'s head is not this run's head`);
	}
}

/** The repository, the signed-in author and the one open PR at the head. */
async function resolveTarget(gh: Gh, ctx: RoundContext): Promise<PrTarget> {
	const author = trimmed(await gh(["api", "user", "--jq", ".login"]));
	if (author === "") {
		throw new RoundSkip("gh is not signed in");
	}
	const repo = trimmed(
		await gh([
			"repo",
			"view",
			"--json",
			"nameWithOwner",
			"--jq",
			".nameWithOwner",
		]),
	);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new RoundSkip("gh could not name this repository on GitHub");
	}
	if (ctx.request.pr !== undefined) {
		await checkNamedPr(gh, repo, ctx.request.pr, ctx.headOid);
		return { repo, pr: ctx.request.pr, author };
	}
	let listed: string;
	try {
		listed = await gh(["api", `repos/${repo}/commits/${ctx.headOid}/pulls`]);
	} catch (error) {
		// GitHub answers 422 for a commit it does not have, such as an
		// unpushed head.
		if (/HTTP 422|No commit found/.test(errorText(error))) {
			throw new RoundSkip(
				"no open PR has this head; GitHub does not have this commit",
			);
		}
		throw error;
	}
	const pulls = parseJson(listed, "pull requests");
	const open = (Array.isArray(pulls) ? pulls : [])
		.filter(
			(row): row is { number: number } =>
				row !== null &&
				typeof row === "object" &&
				(row as { state?: unknown }).state === "open" &&
				(row as { head?: { sha?: unknown } }).head?.sha === ctx.headOid &&
				Number.isInteger((row as { number?: unknown }).number),
		)
		.map((row) => row.number);
	if (open.length === 0) {
		throw new RoundSkip("no open PR has this head");
	}
	if (open.length > 1) {
		throw new RoundSkip(
			`${open.length} open PRs have this head: ${open.map((n) => `#${n}`).join(", ")}; pass pr to choose one`,
		);
	}
	return { repo, pr: open[0] as number, author };
}

/** Creates one new comment, the body on stdin. */
async function createComment(
	gh: Gh,
	target: PrTarget,
	body: string,
): Promise<string> {
	const created = parseJson(
		await gh(
			[
				"api",
				"--method",
				"POST",
				`repos/${target.repo}/issues/${target.pr}/comments`,
				"--input",
				"-",
			],
			JSON.stringify({ body }),
		),
		"the new comment",
	) as { html_url?: unknown } | null;
	return typeof created?.html_url === "string" ? created.html_url : "";
}

/** Cuts whole code points until the text is at most `maxBytes` of UTF-8. */
function truncateBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text;
	}
	const points = Array.from(text);
	let bytes = Buffer.byteLength("…", "utf8");
	let kept = 0;
	for (const point of points) {
		const next = bytes + Buffer.byteLength(point, "utf8");
		if (next > maxBytes) {
			break;
		}
		bytes = next;
		kept += 1;
	}
	return `${points.slice(0, kept).join("")}…`;
}

function replyLine(text: string): string {
	return truncateBytes(
		truncateCodePoints(text, REPLY_LINE_CHARS),
		REPLY_LINE_BYTES,
	);
}

function posted(label: string, target: PrTarget, url: string): string {
	return replyLine(
		`${label}: posted to #${target.pr}${url === "" ? "" : ` (${inert(url)})`}`,
	);
}

function notPosted(label: string, reason: string): string {
	return replyLine(`${label}: not posted (${reason})`);
}

/** Why this call may not post at all, before any `gh` call. */
function gateReason(ctx: RoundContext) {
	const { request, mode } = ctx;
	if (ctx.signal?.aborted) {
		return "the run was interrupted";
	}
	if (request.prComment === false) {
		return "turned off for this run";
	}
	if (mode === "ownerApproved" && request.ownerApproved !== true) {
		return "the owner config asks for approval first";
	}
	return undefined;
}

/** A built body, and what to do once its post has settled. */
type Built = {
	body: string;
	/**
	 * Called once: with the target when the comment reached the PR, without
	 * when it did not; what it returns is added to the reason.
	 */
	settle?: (postedTo?: PrTarget) => string | undefined;
};

/**
 * Looks the PR up, builds the body and posts it. Returns the target and the
 * reply line; never throws.
 */
async function postOne(
	ctx: RoundContext,
	build: (gh: Gh) => Built | Promise<Built>,
): Promise<{ line: string; target?: PrTarget; url?: string; gh: Gh }> {
	const gh = ghOf(ctx);
	const gate = gateReason(ctx);
	if (gate !== undefined) {
		return { line: notPosted("PR comment", gate), gh };
	}
	let target: PrTarget;
	try {
		target = await resolveTarget(gh, ctx);
	} catch (error) {
		return { line: notPosted("PR comment", ghReason(error)), gh };
	}
	let built: Built;
	try {
		built = await build(gh);
	} catch (error) {
		if (error instanceof RoundSkip) {
			return { line: notPosted("PR comment", error.message), gh };
		}
		return {
			line: notPosted(
				"PR comment",
				`the comment could not be built: ${inert(truncateCodePoints(oneLine(errorText(error)), 200))}`,
			),
			gh,
		};
	}
	let url: string;
	try {
		url = await createComment(gh, target, built.body);
	} catch (error) {
		const note = built.settle?.();
		return {
			line: notPosted(
				"PR comment",
				`${ghReason(error)}${note === undefined ? "" : `; ${note}`}`,
			),
			gh,
		};
	}
	built.settle?.(target);
	return { line: posted("PR comment", target, url), target, url, gh };
}

function findingRow(
	entry: StampedFinding,
	panel: PlannedSeat[],
	label = githubSafe(entry.id, 40),
): string[] {
	const where = safeCode(`${entry.finding.file}:${entry.finding.line}`);
	const row = [
		`- **${label} [${entry.finding.severity}]** ${githubSafe(entry.finding.title)} (${where}) — ${githubSafe(findingAttribution(entry, panel), 120)}`,
	];
	const evidence = githubSafe(entry.finding.evidence, EVIDENCE_CHARS);
	if (evidence !== "") {
		row.push(`  **Evidence:** ${evidence}`);
	}
	return row;
}

/**
 * One group as one unit of the comment: a group of one is its finding's
 * row with both ids; a larger group is a header, then each member's own row:
 * id, severity, title, place, seat and evidence. A group too long for the
 * comment posts in part. The member count is never shown.
 */
function groupRow(group: GroupView, panel: PlannedSeat[]): CommentGroupRow {
	const [only] = group.members;
	if (group.members.length === 1 && only !== undefined) {
		return {
			head: findingRow(
				only,
				panel,
				`${githubSafe(group.id, 40)} / ${githubSafe(only.id, 40)}`,
			),
			members: [],
		};
	}
	return {
		head: [
			`- **${githubSafe(group.id, 40)} [${group.severity}, ${GROUP_SEVERITY_LABEL}]** ${githubSafe(group.lead.finding.title)}`,
		],
		members: group.members.map((entry) =>
			findingRow(entry, panel, githubSafe(entry.id, 40)).map(
				(line) => `  ${line}`,
			),
		),
	};
}

export type ReviewRoundFacts = {
	runId: string;
	baseRef: string;
	baseOid: string;
	headOid: string;
	panel: PlannedSeat[];
	/** The stamped findings travel in `findings`, as the run returned them. */
	result: Omit<RunReviewResult, "findings">;
	findings?: StampedFinding[];
	suggestions?: Suggestion[] | SuggestionsUnavailable;
};

/** The review comment: the reply's content without the local record path. */
export function renderReviewRound(facts: ReviewRoundFacts): string {
	const [, summary, seats] = reviewHeadLines("", facts);
	const head = [
		REVIEW_ROUND_HEADING,
		`${safeCode(facts.baseRef)} (\`${shortOid(facts.baseOid)}\`) → \`${shortOid(facts.headOid)}\``,
		ownLine(summary as string),
		boldLabel(ownLine(seats as string)),
	];
	if (facts.result.outcomes.some((row) => row.outcome.kind === "failed")) {
		head.push(boldLabel(ownLine(reviewLostLine(facts.result))));
	}
	const groupingLost = groupingLostLine(facts.result.grouping);
	if (groupingLost !== undefined) {
		head.push(boldLabel(ownLine(groupingLost)));
	}
	head.push("");
	const findings = facts.findings ?? [];
	const groups = groupedView(findings, facts.result.grouping);
	const rows =
		groups === undefined
			? orderFindings(findings).map((entry) => findingRow(entry, facts.panel))
			: groups.map((group) => groupRow(group, facts.panel));
	if (rows.length === 0) {
		head.push("None submitted.");
	}
	const ran = new Set(facts.panel.map((seat) => seat.lens));
	const offered = facts.suggestions ?? [];
	const tail: string[] = [];
	if (!Array.isArray(offered)) {
		tail.push(
			"",
			"**Suggest:**",
			ownLine(formatSuggestionsUnavailable(offered)),
		);
	} else {
		const shown = offered.filter((row) => !ran.has(row.lens));
		if (shown.length > 0) {
			tail.push(
				"",
				"**Suggest:**",
				...shown.map((row) => ownLine(formatSuggestion(row))),
			);
		}
	}
	tail.push(...markerTail({ review: facts.runId }));
	return fitCommentBody(
		head,
		rows,
		tail,
		groups === undefined ? "finding" : "group",
	);
}

/** Posts the review round. Returns the reply lines; never throws. */
export async function postReviewRound(
	ctx: RoundContext,
	facts: ReviewRoundFacts,
): Promise<string[]> {
	return [
		(await postOne(ctx, () => ({ body: renderReviewRound(facts) }))).line,
	];
}

export type VerifyRoundFacts = {
	result: RunVerifyResult;
	panel: readonly PlannedSeat[];
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
	/** The review record's findings, for titles; absent when unreadable. */
	reviewFindings?: readonly StampedFinding[];
	/**
	 * The review record as verify loaded and authenticated it before any seat
	 * ran. The close-out card's findings, seats and range are built from these
	 * signed bytes, never from the record folder again, which may have changed
	 * while the seats ran; its earlier rounds come only from signed
	 * `round-<N>.posted` markers and signed verify records.
	 */
	review: PriorRun;
	/**
	 * The owner's record key verify loaded: earlier verify records and
	 * posted markers count only when signed with it, and this verify's
	 * markers are signed with it.
	 */
	recordKey: Buffer;
	/**
	 * The review's verify chain before this verify, as verify loaded it
	 * from signed records before any seat ran: what is open after this
	 * verify follows from it and this verify's own result.
	 */
	chain?: readonly ChainLink[];
	/**
	 * Post the close-out card after this verify, only when nothing is open
	 * after it. Never automatic: the owner asks for it.
	 */
	closeOut?: boolean;
};

function runIdOf(recordPath: string): string {
	return path.basename(recordPath);
}

/** This verify's round number: its place in the review's chain. */
function roundOf(facts: VerifyRoundFacts): number {
	return facts.result.link ?? (facts.chain?.length ?? 0) + 1;
}

/** The chain with this verify as its last link. */
function chainWithOwn(facts: VerifyRoundFacts): ChainLink[] {
	const { result } = facts;
	const chain = facts.chain ?? [];
	return [
		...chain,
		makeLink({
			runId: runIdOf(result.recordPath),
			link: roundOf(facts),
			previousRunId:
				result.previousRunId ?? chain.at(-1)?.runId ?? result.priorRunId,
			headOid: result.headOid,
			keptFindingIds: result.kept.map((row) => row.id),
			dismissed: facts.dismissed,
			lowAdvisory: facts.lowAdvisory,
			outcomes: result.outcomes,
		}),
	];
}

/** Where every id stands after this verify, from the review and the chain. */
function stateAfter(facts: VerifyRoundFacts): ChainState {
	return chainState(facts.review.findings, chainWithOwn(facts));
}

/** The verify comment: fixed, not fixed and why, and what is new. */
export function renderVerifyRound(
	facts: VerifyRoundFacts,
	round: number,
): string {
	const { result } = facts;
	const seen = verifyFacts(result);
	const state = stateAfter(facts);
	const titles = new Map<string, string>();
	for (const item of state.items.values()) {
		titles.set(item.id, item.title);
	}
	for (const row of [...(facts.reviewFindings ?? []), ...result.kept]) {
		titles.set(row.id, row.finding.title);
	}
	const titled = (id: string) => {
		const title = titles.get(id);
		return title === undefined ? "" : ` — ${githubSafe(title)}`;
	};
	const failed = result.outcomes.filter((row) => row.outcome.kind === "failed");
	const keptSummary =
		seen.keptIds.length === 0
			? "no kept ids"
			: seen.keptIds
					.map((id) => githubSafe(dispositionLabel(seen, id), 80))
					.join(", ");
	const keptSet = new Set(seen.keptIds);
	const head = [
		`## Review panel · verify ${round}`,
		`\`${shortOid(result.priorHeadOid)}\` → \`${shortOid(result.headOid)}\``,
		[
			`${seen.voted}/${result.outcomes.length} voted`,
			keptSummary,
			seen.regressions.length === 0
				? "no regressions"
				: `${seen.regressions.length} regression${seen.regressions.length === 1 ? "" : "s"}`,
		].join(" · "),
		...(facts.panel.length === 0
			? []
			: [boldLabel(ownLine(renderSeatsLine([...facts.panel])))]),
		...(failed.length === 0
			? []
			: [
					`**Lost:** ${failed.map((row) => githubSafe(`${row.seat.rosterId}/${row.seat.lens}`, 120)).join(", ")}`,
				]),
		`**Open after this round:** ${
			state.open.length === 0
				? "none"
				: state.open.map((id) => githubSafe(id, 40)).join(", ")
		}${failed.length === 0 ? "" : " · a verify seat was lost, so this round resolved nothing"}`,
	];
	const rows: string[][] = [];
	const section = (title: string, items: string[][]) => {
		for (const [index, item] of items.entries()) {
			rows.push(index === 0 ? ["", title, ...item] : item);
		}
	};
	section(
		"### Kept",
		seen.keptIds.map((id) => {
			const evidence = seen.evidence.get(id);
			const why =
				evidence === undefined
					? ""
					: ` — ${safeCode(evidence.file)}: ${githubSafe(evidence.explanation, EVIDENCE_CHARS)}`;
			return [
				`- **${githubSafe(dispositionLabel(seen, id), 80)}**${titled(id)}${why}`,
			];
		}),
	);
	section(
		"### Dismissed (not fixed)",
		facts.dismissed.map((row) => [
			`- **${githubSafe(row.id, 40)}**${titled(row.id)} — ${githubSafe(row.reason, EVIDENCE_CHARS)}`,
		]),
	);
	section(
		"### Low / advisory (not kept)",
		facts.lowAdvisory
			.filter((id) => !keptSet.has(id))
			.map((id) => [`- **${githubSafe(id, 40)}**${titled(id)}`]),
	);
	section(
		"### New findings (regressions)",
		seen.regressions.map((row) => {
			const undoes = state.items.get(row.id)?.regression?.undoes;
			const lines = [
				`- **${githubSafe(row.id, 40)}** ${githubSafe(row.title)} (${safeCode(`${row.file}:${row.line}`)})${undoes === undefined ? "" : ` · undoes ${safeCode(undoes, 40)}`}`,
			];
			const evidence = githubSafe(row.evidence, EVIDENCE_CHARS);
			if (evidence !== "") {
				lines.push(`  **Evidence:** ${evidence}`);
			}
			return lines;
		}),
	);
	return fitCommentBody(
		head,
		rows,
		markerTail({
			review: result.priorRunId,
			verify: runIdOf(result.recordPath),
		}),
		"row",
	);
}

/**
 * Why a verify is not clean enough for the close-out, or undefined when it
 * is: every verify seat voted (no lost coverage), every voting seat marks
 * every kept id resolved, and no seat reported a regression.
 */
export function closeoutBlocker(result: RunVerifyResult): string | undefined {
	const reasons: string[] = [];
	const failed = result.outcomes.filter((row) => row.outcome.kind === "failed");
	if (failed.length > 0) {
		reasons.push(
			`lost verify coverage: ${failed.map((row) => `${row.seat.rosterId}/${row.seat.lens}`).join(", ")}`,
		);
	}
	const voters = result.outcomes.flatMap((row) =>
		row.outcome.kind === "voted" ? [row.outcome.result] : [],
	);
	if (voters.length === 0 && failed.length === 0) {
		reasons.push("no verify seat voted");
	}
	const seen = verifyFacts(result);
	for (const id of seen.keptIds) {
		const states = voters.map((vote) => {
			const said = new Set(
				vote.items
					.filter((item) => item.id === id)
					.map((item) => item.disposition as string),
			);
			if (said.size === 0) {
				return "no answer";
			}
			return said.size === 1 && said.has("resolved")
				? "resolved"
				: [...said].filter((state) => state !== "resolved").join("/");
		});
		if (states.every((state) => state === "resolved")) {
			continue;
		}
		if (states.includes("resolved")) {
			reasons.push(`seats disagree on ${id}`);
			continue;
		}
		const named = [...new Set(states)].filter((state) => state !== "no answer");
		reasons.push(
			named.length === 0
				? `no seat answered ${id}`
				: `${id} is ${named.join("/")}`,
		);
	}
	if (seen.regressions.length > 0) {
		reasons.push(
			`${seen.regressions.length} regression${seen.regressions.length === 1 ? "" : "s"}`,
		);
	}
	return reasons.length === 0
		? undefined
		: inert(truncateCodePoints(reasons.join("; "), 300));
}

/** True when the verify is clean; see {@link closeoutBlocker}. */
export function verifyIsClean(result: RunVerifyResult): boolean {
	return closeoutBlocker(result) === undefined;
}

function commentRefusal(error: unknown): string {
	return inert(
		truncateCodePoints(
			oneLine(errorText(error).replace(/^comment refused:\s*/, "")),
			300,
		),
	);
}

type IssueComment = { user?: { login?: unknown }; body?: unknown };

type CloseoutCard = {
	/** The card, linking the rounds whose comments were found. */
	render: (links?: CloseoutLinks) => string;
	rounds: readonly CloseoutVerifyRound[];
	reviewRecord: string;
	reviewRunId: string;
};

/**
 * The close-out card for this review after this verify, or why it cannot be
 * built: it lists every id from where the chain, ending with this verify,
 * left it, and is refused while any id is open. Its rounds are the chain's
 * links, numbered by their posted rounds (this verify's from its claim).
 */
function buildCloseout(
	facts: VerifyRoundFacts,
): CloseoutCard | { reason: string } {
	const { result } = facts;
	let review: CloseoutRunFacts;
	try {
		if (result.priorRunId !== facts.review.runId) {
			throw new Error(
				`comment refused: verify ran against "${result.priorRunId}", not the loaded review "${facts.review.runId}"`,
			);
		}
		review = closeoutFactsOf(facts.review);
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	const verifyRunId = runIdOf(result.recordPath);
	const links = chainWithOwn(facts);
	const state = chainState(review.run.findings, links);
	const rounds = chainRounds(links);
	let accounted: ReturnType<typeof accountCloseoutFindings>;
	try {
		accounted = accountCloseoutFindings({
			findings: review.run.findings,
			state,
			rounds,
			dismissed: [],
			lowAdvisory: [],
		});
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	if (accounted.open.length > 0) {
		return {
			reason: inert(
				truncateCodePoints(
					`still open: ${accounted.open.map((row) => row.id).join(", ")}`,
					300,
				),
			),
		};
	}
	const render = (links?: CloseoutLinks) => {
		const parts = assembleCloseoutParts({
			findings: review.run.findings,
			state,
			rounds,
			dismissed: [],
			lowAdvisory: [],
			panel: review.panel,
			lost: review.lost,
			verifyLost: rounds.flatMap((row) => row.lost ?? []),
			meta: { ...review.run.meta, headOid: result.headOid },
			heading: CLOSEOUT_ROUND_HEADING,
			runIds: { review: review.run.runId, verify: verifyRunId },
			...(links === undefined ? {} : { links }),
		});
		return fitCommentBody(parts.head, parts.rows, parts.tail, "row");
	};
	try {
		// Refused here, before any claim, rather than at posting time.
		render();
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	return {
		render,
		rounds,
		reviewRecord: review.run.recordPath,
		reviewRunId: review.run.runId,
	};
}

/** Every comment on the PR, across pages. */
async function listComments(gh: Gh, target: PrTarget): Promise<unknown[]> {
	const comments = parseJsonPages(
		await gh([
			"api",
			`repos/${target.repo}/issues/${target.pr}/comments?per_page=100`,
			"--paginate",
		]),
	);
	if (comments === undefined) {
		throw new RoundSkip("gh returned unreadable comments");
	}
	return comments;
}

/** Is a close-out for this review among the comments, by this author? */
function hasCloseoutFor(
	comments: readonly unknown[],
	target: PrTarget,
	reviewRunId: string,
): boolean {
	return comments.some((raw) => {
		const comment = raw as IssueComment | null;
		if (comment?.user?.login !== target.author) {
			return false;
		}
		const body = typeof comment.body === "string" ? comment.body : "";
		const [first, second] = body.split(/\r?\n/, 2);
		if (first?.trim() !== CLOSEOUT_ROUND_HEADING) {
			return false;
		}
		// A card posted before the hidden marker named its review on line 2,
		// which the tool writes and no seat text reaches.
		const legacy = `Review ${postedCode(reviewRunId)} `;
		return (
			isRunMarkerFor(body, reviewRunId) || second?.startsWith(legacy) === true
		);
	});
}

/** Is a close-out for this review already on the PR, by this author? */
async function closeoutAlreadyPosted(
	gh: Gh,
	target: PrTarget,
	reviewRunId: string,
): Promise<boolean> {
	return hasCloseoutFor(await listComments(gh, target), target, reviewRunId);
}

/**
 * Links to the review comment and each counted verify comment found among
 * the PR's comments; this verify's own comment, just posted, by the URL gh
 * gave for it when the listing does not hold it yet.
 */
function closeoutLinks(
	comments: readonly unknown[],
	target: PrTarget,
	card: CloseoutCard,
	verifyRunId: string,
	verifyUrl: string | undefined,
): CloseoutLinks {
	const links = roundCommentLinks(
		comments,
		target,
		card.reviewRunId,
		card.rounds.map((round) => round.runId),
	);
	const verify = new Map(links.verify);
	const own = prCommentUrl(verifyUrl, target);
	if (!verify.has(verifyRunId) && own !== undefined) {
		verify.set(verifyRunId, own);
	}
	return { ...links, verify };
}

/**
 * Claims this review's one close-out (see `claimCloseout` in
 * `round-claim.ts`), asking the PR's comments only when an earlier claim
 * was left stale. Returns the claim, or why nothing is posted.
 */
async function claimReviewCloseout(
	card: CloseoutCard,
	verifyRunId: string,
	gh: Gh,
	target: PrTarget,
	key: Buffer,
): Promise<HeldClaim | { reason: string }> {
	const claim = await claimCloseout(
		card.reviewRecord,
		verifyRunId,
		() => closeoutAlreadyPosted(gh, target, card.reviewRunId),
		{ key },
	);
	switch (claim.kind) {
		case "taken":
			return claim.claim;
		case "posted":
			return {
				reason: claim.onPr
					? `a close-out for this review is already on PR #${target.pr}`
					: "this review's close-out is already posted",
			};
		case "busy":
			return { reason: "another verify is posting this review's close-out" };
		case "exhausted":
			return {
				reason: `closeout.claim-1 to closeout.claim-${CLOSEOUT_GENERATIONS} were all left by verifies that stopped; delete them from the review's run record to post it`,
			};
		default:
			return {
				reason: `the close-out could not be claimed: ${inert(truncateCodePoints(oneLine(errorText(claim.error)), 200))}`,
			};
	}
}

/**
 * Posts the verify round and, when the caller asked for it (`closeOut`) and
 * nothing is open after a clean verify, the close-out card as a separate
 * comment. Returns the reply lines; never throws.
 */
export async function postVerifyRound(
	ctx: RoundContext,
	facts: VerifyRoundFacts,
): Promise<string[]> {
	const { result } = facts;
	const verifyRunId = runIdOf(result.recordPath);
	// One number per round: the verify's place in the review's chain.
	const round = roundOf(facts);
	const verify = await postOne(ctx, async () => {
		const claim: RoundClaim | { reason: string } = await claimRound(
			path.join(ctx.repoDir, ".review-panel", "runs", result.priorRunId),
			round,
			verifyRunId,
			{
				key: facts.recordKey,
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			},
		);
		if ("reason" in claim) {
			throw new RoundSkip(claim.reason);
		}
		let body: string;
		try {
			body = renderVerifyRound(facts, round);
		} catch (error) {
			settleRound(claim, false);
			throw error;
		}
		return {
			body,
			settle: (postedTo) => {
				settleRound(claim, postedTo !== undefined);
				return undefined;
			},
		};
	});
	const lines = [verify.line];
	if (verify.target === undefined) {
		// The `PR comment:` line already says why nothing was posted.
		return lines;
	}
	const blocker = closeoutBlocker(result);
	if (facts.closeOut !== true) {
		// Never automatic: say so only when it could have been asked for.
		if (blocker === undefined && stateAfter(facts).open.length === 0) {
			lines.push(
				notPosted(
					"PR close-out",
					"not asked for; nothing is open, so pass --close-out on a verify, or post it with comment once the owner says the rounds are done",
				),
			);
		}
		return lines;
	}
	if (blocker !== undefined) {
		lines.push(notPosted("PR close-out", blocker));
		return lines;
	}
	const card = buildCloseout(facts);
	if ("reason" in card) {
		lines.push(notPosted("PR close-out", card.reason));
		return lines;
	}
	let claim: HeldClaim | { reason: string };
	try {
		claim = await claimReviewCloseout(
			card,
			verifyRunId,
			verify.gh,
			verify.target,
			facts.recordKey,
		);
	} catch (error) {
		lines.push(notPosted("PR close-out", ghReason(error)));
		return lines;
	}
	if ("reason" in claim) {
		lines.push(notPosted("PR close-out", claim.reason));
		return lines;
	}
	try {
		const comments = await listComments(verify.gh, verify.target);
		if (hasCloseoutFor(comments, verify.target, card.reviewRunId)) {
			// An automatic close-out is there already (one whose marker a
			// crash lost): record it, and post nothing.
			settleCloseout(claim, true);
			lines.push(
				notPosted(
					"PR close-out",
					`a close-out for this review is already on PR #${verify.target.pr}`,
				),
			);
			return lines;
		}
		const body = card.render(
			closeoutLinks(comments, verify.target, card, verifyRunId, verify.url),
		);
		const url = await createComment(verify.gh, verify.target, body);
		settleCloseout(claim, true);
		lines.push(posted("PR close-out", verify.target, url));
	} catch (error) {
		settleCloseout(claim, false);
		lines.push(notPosted("PR close-out", ghReason(error)));
	}
	return lines;
}
