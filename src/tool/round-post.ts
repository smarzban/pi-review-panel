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
 * Bodies carry text written by seats and file names from the diff, so each
 * such field is flattened to one line, stripped of control, bidi and
 * invisible characters, and its `@mentions`, `#123` references and heading
 * markers are broken with a zero-width joiner, so nobody is notified and no
 * line can pass for a heading. A body is cut by whole rows to stay under
 * GitHub's comment limit, and goes to `gh` on stdin, never as an argument.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { PrCommentMode } from "../config/schema.js";
import { discoverPriorRecords } from "../run/prior-records.js";
import { inlineCode, renderSeatsLine } from "../run/render.js";
import type { RunReviewResult } from "../run/run-review.js";
import type { RunVerifyResult } from "../run/run-verify.js";
import type { Suggestion, SuggestionsUnavailable } from "../run/suggest.js";
import type { PlannedSeat, StampedFinding } from "../run/types.js";
import {
	accountCloseoutFindings,
	assembleCloseoutComment,
	type CloseoutJudgmentRow,
} from "./closeout-comment.js";
import { loadCloseoutRun } from "./closeout-from-run.js";
import type { GhRunner } from "./closeout-post.js";
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

/** GitHub refuses a comment body longer than this many characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;
/** What a body is cut to, well under the limit. */
const BODY_BUDGET = 60_000;
/** Bytes the reply keeps free for the `PR comment:` lines. */
export const ROUND_REPLY_RESERVE = 2_048;
const REPLY_LINE_CHARS = 600;
const TITLE_CHARS = 300;
const EVIDENCE_CHARS = 1_000;
const FILE_CHARS = 200;
const OID_DISPLAY_LENGTH = 7;

export const CLOSEOUT_ROUND_HEADING = "## Review panel · close-out";

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
	runGh: GhRunner;
	repoDir: string;
	headOid: string;
	request: RoundRequest;
	mode: PrCommentMode;
};

/** A reason not to post, said in the reply as `not posted (<reason>)`. */
class RoundSkip extends Error {}

/** Runs the real `gh`. Errors are left as they are; {@link ghReason} reads them. */
export function defaultRunGh(
	args: readonly string[],
	options?: { cwd?: string; input?: string },
): string {
	return execFileSync("gh", [...args], {
		encoding: "utf8",
		cwd: options?.cwd,
		input: options?.input,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Breaks `@mentions`, `#123` references and heading markers. */
function neutralize(text: string): string {
	return text
		.replace(/@(?=[\p{L}\p{N}_-])/gu, "@\u200D")
		.replace(/#(?=[#\p{N}\s])/gu, "#\u200D");
}

/**
 * Seat-written text made safe to post: one line, no control, bidi or
 * invisible character, no HTML, and no mention, reference or heading that
 * GitHub would act on.
 */
export function githubSafe(text: string, maxChars = TITLE_CHARS): string {
	return neutralize(
		inert(truncateCodePoints(oneLine(text), maxChars)).replace(/</g, "&lt;"),
	);
}

/** A file name or ref as one code span it cannot close, made safe the same way. */
function safeCode(text: string, maxChars = FILE_CHARS): string {
	return neutralize(
		inlineCode(inert(truncateCodePoints(oneLine(text), maxChars))),
	);
}

function shortOid(oid: string): string {
	return oid.slice(0, OID_DISPLAY_LENGTH);
}

/**
 * Joins the head, as many whole rows as fit, a line counting the rows cut,
 * and the tail, within {@link BODY_BUDGET} characters.
 */
export function fitCommentBody(
	head: readonly string[],
	rows: readonly (readonly string[])[],
	tail: readonly string[],
	noun: string,
): string {
	const size = (lines: readonly string[]) =>
		lines.reduce((sum, line) => sum + line.length + 1, 0);
	const fixed = size(head) + size(tail) + 200;
	let used = fixed;
	let kept = 0;
	for (const row of rows) {
		const next = used + size(row);
		if (next > BODY_BUDGET) {
			break;
		}
		used = next;
		kept += 1;
	}
	const cut = rows.length - kept;
	const text = [
		...head,
		...rows.slice(0, kept).flat(),
		...(cut === 0
			? []
			: [
					"",
					`- ${cut} ${noun}(s) cut to fit GitHub's comment limit; the full list is in the run record.`,
				]),
		...tail,
	].join("\n");
	return text.length <= BODY_BUDGET ? text : text.slice(0, BODY_BUDGET);
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
	if ((error as { code?: unknown } | null)?.code === "ENOENT") {
		return "gh is not installed";
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

type Gh = (args: readonly string[], stdin?: string) => string;

function ghOf(ctx: RoundContext): Gh {
	return (args, stdin) =>
		ctx.runGh(
			args,
			stdin === undefined
				? { cwd: ctx.repoDir }
				: { cwd: ctx.repoDir, input: stdin },
		);
}

/** The repository, the signed-in author and the one open PR at the head. */
function resolveTarget(gh: Gh, ctx: RoundContext): PrTarget {
	const author = trimmed(gh(["api", "user", "--jq", ".login"]));
	if (author === "") {
		throw new RoundSkip("gh is not signed in");
	}
	const repo = trimmed(
		gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
	);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new RoundSkip("gh could not name this repository on GitHub");
	}
	if (ctx.request.pr !== undefined) {
		return { repo, pr: ctx.request.pr, author };
	}
	const pulls = parseJson(
		gh(["api", `repos/${repo}/commits/${ctx.headOid}/pulls`]),
		"pull requests",
	);
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
function createComment(gh: Gh, target: PrTarget, body: string): string {
	const created = parseJson(
		gh(
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

function replyLine(text: string): string {
	return truncateCodePoints(text, REPLY_LINE_CHARS);
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
function gateReason(request: RoundRequest, mode: PrCommentMode) {
	if (request.prComment === false) {
		return "turned off for this run";
	}
	if (mode === "ownerApproved" && request.ownerApproved !== true) {
		return "the owner config asks for approval first";
	}
	return undefined;
}

/**
 * Looks the PR up, builds the body and posts it. Returns the target and the
 * reply line; never throws.
 */
function postOne(
	ctx: RoundContext,
	build: () => string,
): { line: string; target?: PrTarget; gh: Gh } {
	const gh = ghOf(ctx);
	const gate = gateReason(ctx.request, ctx.mode);
	if (gate !== undefined) {
		return { line: notPosted("PR comment", gate), gh };
	}
	let target: PrTarget;
	try {
		target = resolveTarget(gh, ctx);
	} catch (error) {
		return { line: notPosted("PR comment", ghReason(error)), gh };
	}
	let body: string;
	try {
		body = build();
	} catch (error) {
		return {
			line: notPosted(
				"PR comment",
				`the comment could not be built: ${inert(truncateCodePoints(oneLine(errorText(error)), 200))}`,
			),
			gh,
		};
	}
	try {
		const url = createComment(gh, target, body);
		return { line: posted("PR comment", target, url), target, gh };
	} catch (error) {
		return { line: notPosted("PR comment", ghReason(error)), gh };
	}
}

function findingRow(entry: StampedFinding, panel: PlannedSeat[]): string[] {
	const where = safeCode(`${entry.finding.file}:${entry.finding.line}`);
	const row = [
		`- ${githubSafe(entry.id, 40)} [${entry.finding.severity}] ${githubSafe(entry.finding.title)} (${where}) — ${githubSafe(findingAttribution(entry, panel), 120)}`,
	];
	const evidence = githubSafe(entry.finding.evidence, EVIDENCE_CHARS);
	if (evidence !== "") {
		row.push(`  ${evidence}`);
	}
	return row;
}

export type ReviewRoundFacts = {
	runId: string;
	baseRef: string;
	baseOid: string;
	headOid: string;
	panel: PlannedSeat[];
	result: RunReviewResult;
	findings?: StampedFinding[];
	suggestions?: Suggestion[] | SuggestionsUnavailable;
};

/** The review comment: the reply's content without the local record path. */
export function renderReviewRound(facts: ReviewRoundFacts): string {
	const [, summary, seats] = reviewHeadLines("", facts);
	const head = [
		"## Review panel · review",
		`Run ${safeCode(facts.runId)} · ${safeCode(facts.baseRef)} (\`${shortOid(facts.baseOid)}\`) → \`${shortOid(facts.headOid)}\``,
		summary as string,
		neutralize(inert(seats as string)),
	];
	if (facts.result.outcomes.some((row) => row.outcome.kind === "failed")) {
		head.push(neutralize(inert(reviewLostLine(facts.result))));
	}
	head.push("");
	const findings = facts.findings ?? [];
	const rows = orderFindings(findings).map((entry) =>
		findingRow(entry, facts.panel),
	);
	if (rows.length === 0) {
		head.push("None submitted.");
	}
	const ran = new Set(facts.panel.map((seat) => seat.lens));
	const offered = facts.suggestions ?? [];
	const tail: string[] = [];
	if (!Array.isArray(offered)) {
		tail.push(
			"",
			"Suggest:",
			neutralize(formatSuggestionsUnavailable(offered)),
		);
	} else {
		const shown = offered.filter((row) => !ran.has(row.lens));
		if (shown.length > 0) {
			tail.push(
				"",
				"Suggest:",
				...shown.map((row) => neutralize(formatSuggestion(row))),
			);
		}
	}
	return fitCommentBody(head, rows, tail, "finding");
}

/** Posts the review round. Returns the reply lines; never throws. */
export function postReviewRound(
	ctx: RoundContext,
	facts: ReviewRoundFacts,
): string[] {
	return [postOne(ctx, () => renderReviewRound(facts)).line];
}

/**
 * Which verify of this review a run is: 1 + the earlier complete verify runs
 * whose `priorRunId` is the same review.
 */
export function verifyRoundNumber(
	repoDir: string,
	reviewRunId: string,
	verifyRunId: string,
): number {
	let earlier = 0;
	for (const record of discoverPriorRecords(repoDir)) {
		const name = path.basename(record.path);
		if (name >= verifyRunId) {
			continue;
		}
		try {
			const meta = JSON.parse(
				readFileSync(path.join(record.path, "meta.json"), "utf8"),
			) as { kind?: unknown; priorRunId?: unknown };
			if (meta.kind === "verify" && meta.priorRunId === reviewRunId) {
				earlier += 1;
			}
		} catch {
			// A record without readable meta is not a verify of this review.
		}
	}
	return earlier + 1;
}

export type VerifyRoundFacts = {
	result: RunVerifyResult;
	panel: readonly PlannedSeat[];
	/** The verify call's `head`, as the close-out card shows it. */
	headRef: string;
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
	/** The review record's findings, for titles; absent when unreadable. */
	reviewFindings?: readonly StampedFinding[];
};

function runIdOf(recordPath: string): string {
	return path.basename(recordPath);
}

/** The verify comment: fixed, not fixed and why, and what is new. */
export function renderVerifyRound(
	facts: VerifyRoundFacts,
	round: number,
): string {
	const { result } = facts;
	const seen = verifyFacts(result);
	const titles = new Map<string, string>();
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
	const head = [
		`## Review panel · verify ${round}`,
		`Run ${safeCode(runIdOf(result.recordPath))} · review ${safeCode(result.priorRunId)} · \`${shortOid(result.priorHeadOid)}\` → \`${shortOid(result.headOid)}\``,
		[
			`${seen.voted}/${result.outcomes.length} voted`,
			keptSummary,
			seen.regressions.length === 0
				? "no regressions"
				: `${seen.regressions.length} regression${seen.regressions.length === 1 ? "" : "s"}`,
		].join(" · "),
		...(facts.panel.length === 0
			? []
			: [neutralize(inert(renderSeatsLine([...facts.panel])))]),
		...(failed.length === 0
			? []
			: [
					neutralize(
						inert(
							`Lost: ${failed.map((row) => `${row.seat.rosterId}/${row.seat.lens}`).join(", ")}`,
						),
					),
				]),
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
				`- ${githubSafe(dispositionLabel(seen, id), 80)}${titled(id)}${why}`,
			];
		}),
	);
	section(
		"### Dismissed (not fixed)",
		facts.dismissed.map((row) => [
			`- ${githubSafe(row.id, 40)}${titled(row.id)} — ${githubSafe(row.reason, EVIDENCE_CHARS)}`,
		]),
	);
	section(
		"### Low / advisory (not kept)",
		facts.lowAdvisory.map((id) => [`- ${githubSafe(id, 40)}${titled(id)}`]),
	);
	section(
		"### New findings (regressions)",
		seen.regressions.map((row) => {
			const lines = [
				`- ${githubSafe(row.id, 40)} ${githubSafe(row.title)} (${safeCode(`${row.file}:${row.line}`)})`,
			];
			const evidence = githubSafe(row.evidence, EVIDENCE_CHARS);
			if (evidence !== "") {
				lines.push(`  ${evidence}`);
			}
			return lines;
		}),
	);
	return fitCommentBody(head, rows, [], "row");
}

/** True when every kept id is resolved by every seat that voted, with no regressions. */
export function verifyIsClean(result: RunVerifyResult): boolean {
	const seen = verifyFacts(result);
	if (seen.voted === 0 || seen.regressions.length > 0) {
		return false;
	}
	return seen.keptIds.every((id) => {
		const states = seen.dispositions.get(id);
		return states !== undefined && states.size === 1 && states.has("resolved");
	});
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

/** The close-out card for this review, or why it cannot be built. */
function buildCloseout(
	ctx: RoundContext,
	facts: VerifyRoundFacts,
): { body: string } | { reason: string } {
	const { result } = facts;
	let review: ReturnType<typeof loadCloseoutRun>;
	try {
		review = loadCloseoutRun(ctx.repoDir, result.priorRunId);
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	let accounted: ReturnType<typeof accountCloseoutFindings>;
	try {
		accounted = accountCloseoutFindings({
			findings: review.run.findings,
			dismissed: facts.dismissed,
			lowAdvisory: facts.lowAdvisory,
		});
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	const resolved = new Set(verifyFacts(result).keptIds);
	const unaccounted = accounted.fixed
		.map((row) => row.id)
		.filter((id) => !resolved.has(id));
	if (unaccounted.length > 0) {
		return {
			reason: inert(
				truncateCodePoints(
					`${unaccounted.join(", ")} ${unaccounted.length === 1 ? "was" : "were"} neither kept and resolved nor dismissed with a reason`,
					300,
				),
			),
		};
	}
	let card: string;
	try {
		card = assembleCloseoutComment({
			findings: review.run.findings,
			panel: review.panel,
			lost: review.lost,
			meta: { ...review.run.meta, headOid: result.headOid },
			dismissed: facts.dismissed,
			lowAdvisory: facts.lowAdvisory,
			headRef: facts.headRef,
			heading: CLOSEOUT_ROUND_HEADING,
			runLine: `Review ${safeCode(review.run.runId)} · verify ${safeCode(runIdOf(result.recordPath))}`,
		});
	} catch (error) {
		return { reason: commentRefusal(error) };
	}
	const lines = card.split("\n").map((line) => inert(line));
	return { body: fitCommentBody(lines, [], [], "row") };
}

/** Is a close-out for this review already on the PR, by this author? */
function closeoutAlreadyPosted(
	gh: Gh,
	target: PrTarget,
	reviewRunId: string,
): boolean {
	const comments = parseJson(
		gh([
			"api",
			`repos/${target.repo}/issues/${target.pr}/comments`,
			"--paginate",
		]),
		"comments",
	);
	const marker = safeCode(reviewRunId);
	return (Array.isArray(comments) ? comments : []).some((raw) => {
		const comment = raw as IssueComment | null;
		if (comment?.user?.login !== target.author) {
			return false;
		}
		const body = typeof comment.body === "string" ? comment.body : "";
		const first = body.split(/\r?\n/, 1)[0]?.trim();
		return first === CLOSEOUT_ROUND_HEADING && body.includes(marker);
	});
}

/**
 * Posts the verify round and, after a clean verify, the close-out card as a
 * separate comment. Returns the reply lines; never throws.
 */
export function postVerifyRound(
	ctx: RoundContext,
	facts: VerifyRoundFacts,
): string[] {
	const { result } = facts;
	const verify = postOne(ctx, () =>
		renderVerifyRound(
			facts,
			verifyRoundNumber(
				ctx.repoDir,
				result.priorRunId,
				runIdOf(result.recordPath),
			),
		),
	);
	const lines = [verify.line];
	if (!verifyIsClean(result)) {
		return lines;
	}
	if (verify.target === undefined) {
		lines.push(notPosted("PR close-out", "the verify comment was not posted"));
		return lines;
	}
	const card = buildCloseout(ctx, facts);
	if ("reason" in card) {
		lines.push(notPosted("PR close-out", card.reason));
		return lines;
	}
	try {
		if (closeoutAlreadyPosted(verify.gh, verify.target, result.priorRunId)) {
			lines.push(
				notPosted(
					"PR close-out",
					`a close-out for this review is already on PR #${verify.target.pr}`,
				),
			);
			return lines;
		}
		const url = createComment(verify.gh, verify.target, card.body);
		lines.push(posted("PR close-out", verify.target, url));
	} catch (error) {
		lines.push(notPosted("PR close-out", ghReason(error)));
	}
	return lines;
}

/**
 * Refuses `dismissed` and `lowAdvisory` rows that do not fit the review
 * record, before any verify seat runs: an unknown id, an id listed twice or
 * also kept, an empty reason, or a high/medium id listed as low/advisory.
 */
export function assertVerifyJudgment(
	findings: readonly StampedFinding[],
	keptFindingIds: readonly string[],
	dismissed: readonly CloseoutJudgmentRow[],
	lowAdvisory: readonly string[],
): void {
	const byId = new Map(findings.map((row) => [row.id, row]));
	const claimed = new Set(keptFindingIds);
	for (const row of dismissed) {
		if (!byId.has(row.id)) {
			throw new Error(
				`Verify refused: dismissed ${row.id} is not in the review record`,
			);
		}
		if (claimed.has(row.id)) {
			throw new Error(`Verify refused: ${row.id} is listed more than once`);
		}
		if (row.reason.trim() === "") {
			throw new Error(`Verify refused: dismissed ${row.id} needs a reason`);
		}
		claimed.add(row.id);
	}
	for (const id of lowAdvisory) {
		const entry = byId.get(id);
		if (entry === undefined) {
			throw new Error(
				`Verify refused: low/advisory ${id} is not in the review record`,
			);
		}
		if (claimed.has(id)) {
			throw new Error(`Verify refused: ${id} is listed more than once`);
		}
		if (entry.finding.severity !== "low") {
			throw new Error(
				`Verify refused: ${id} is ${entry.finding.severity}; a high/medium finding that is not kept must be dismissed with a reason`,
			);
		}
		claimed.add(id);
	}
}
