/**
 * The one sanitizer for every body posted to GitHub: the review and verify
 * round comments, the automatic close-out card and the manual `comment`
 * card. Text a seat wrote, a dismissed reason, a branch name or a record
 * field reaches a posted body only through {@link postedText} or
 * {@link postedCode}.
 *
 * - {@link postedText} renders it as plain text GitHub cannot turn into
 *   markup: line breaks fold to spaces (so no line-start block marker can
 *   form), only the characters that can form Markdown or HTML inline are
 *   backslash-escaped (with block markers at the start of the text and `!`
 *   before `[`; `&` too, so no entity decodes into `@`, `#` or `://` after
 *   the joiners ran), control, bidi
 *   and invisible characters become U+FFFD (an emoji's presentation
 *   selector U+FE0F and the joiners inside an emoji sequence stay), a
 *   zero-width joiner breaks every `@` / `\uFF20` mention, `#123` /
 *   `owner/repo#123` / `GH-123` reference and `://` autolink, and the dot
 *   of every `www.` is backslash-escaped, which stops GitHub's `www.`
 *   autolink (a joiner after the dot does not: it counts as a host
 *   character).
 * - {@link postedCode} is for file names and ids only: one code span with a
 *   fence longer than any backtick run inside, so it cannot be closed early.
 *   Nothing is escaped or joined inside it: GitHub shows a code span
 *   literally and forms no mention, reference or link there, and a joiner
 *   would hide in a copied path. A value with nothing visible renders as
 *   `(empty)`.
 *
 * {@link fitCommentBody} cuts a body by whole rows (a group in part) to stay
 * under GitHub's comment limit; every posted body goes through it. With each
 * text field capped after escaping, no one row can take most of the budget.
 *
 * Run ids appear in no visible text: {@link runMarker} carries them in one
 * hidden HTML comment at the end of a body, and {@link isRunMarkerFor}
 * finds an earlier body by it.
 */
import { inlineCode } from "../run/render.js";
import { truncateCodePoints } from "./review-presentation.js";

/** Default length of one posted text field, in code points. */
export const POSTED_TEXT_CHARS = 300;
/**
 * A posted text field of `maxChars` code points is at most this many times
 * `maxChars` characters long after escaping, the ellipsis included. Every
 * escape but `<span>$</span>` at most doubles a character, so ordinary text
 * is cut by code points as before; a field of dollars is cut shorter.
 */
export const POSTED_TEXT_GROWTH = 2;
/** Default length of one posted code span's content, in code points. */
export const POSTED_CODE_CHARS = 200;

/** GitHub refuses a comment body longer than this many characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;
/** What a body is cut to, well under the limit. */
const BODY_BUDGET = 60_000;

const ZWJ = "\u200D";

/**
 * An emoji with its presentation selector, and the joined emoji of a
 * sequence such as a family: kept as they are.
 */
const EMOJI_SEQUENCE =
	"\\p{Extended_Pictographic}\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?)*";
const INERT_OR_EMOJI = new RegExp(
	`(${EMOJI_SEQUENCE})|[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]`,
	"gu",
);

/**
 * {@link inert} for posted text, except that an emoji sequence keeps its
 * U+FE0F and joiners, so `⚠️` does not post as `⚠\uFFFD`. Nothing else
 * invisible survives.
 */
function inertKeepingEmoji(text: string): string {
	return text.replace(INERT_OR_EMOJI, (_match, emoji: string | undefined) =>
		emoji === undefined ? "\uFFFD" : emoji,
	);
}

function foldLines(text: string): string {
	return text.replace(/[\s\u0085]+/gu, " ").trim();
}

/** Breaks every mention and `#` reference with a joiner. */
function breakMentions(text: string): string {
	return text.replace(/[@\uFF20#]/gu, `$&${ZWJ}`);
}

/**
 * Breaks mentions, references and `://` autolinks with a joiner, and
 * escapes the dot of every `www.`, whatever precedes it: GitHub links
 * `www.` after `_`, `*`, `~` and `(` as well as after a space.
 */
function breakLinks(text: string): string {
	return breakMentions(text)
		.replace(/\b(GH)-(?=\d)/giu, `$1-${ZWJ}`)
		.replace(/:\/\//gu, `:${ZWJ}//`)
		.replace(/(www)\./giu, "$1\\.");
}

/**
 * Text as one inert line of plain text, at most `maxChars` code points of
 * the text and at most {@link POSTED_TEXT_GROWTH} × `maxChars` characters
 * once escaped, so a field's posted size has a fixed cap whatever it holds.
 * Truncation happens before escaping, so a cut never lands inside an escape
 * or a `<span>$</span>` and never leaves a dangling backslash; the joiners go
 * in after {@link inert}, which would otherwise replace them.
 */
export function postedText(text: string, maxChars = POSTED_TEXT_CHARS): string {
	const source = foldLines(text);
	const cap = POSTED_TEXT_GROWTH * maxChars;
	const posted = (points: number) =>
		breakLinks(
			escapeMarkdown(inertKeepingEmoji(truncateCodePoints(source, points))),
		);
	const first = posted(maxChars);
	if (first.length <= cap) {
		return first;
	}
	// The longest cut that fits: a longer cut never posts shorter, so the
	// search is exact. Zero code points posts only the ellipsis.
	let fits = 0;
	let fails = Math.min(maxChars, Array.from(source).length);
	while (fails - fits > 1) {
		const middle = Math.floor((fits + fails) / 2);
		if (posted(middle).length <= cap) {
			fits = middle;
		} else {
			fails = middle;
		}
	}
	return posted(fits);
}

/**
 * Backslash-escapes what can form Markdown or HTML in an inline context:
 * `\` `` ` `` `*` `_` `[` `]` `<` `>` `|` `~`, `!` before `[`, and `&`,
 * which would otherwise decode an entity such as `&commat;` or `&num;`
 * into a character the joiners never saw. At the start of the text, where
 * it may follow a list marker, a `#`, `-`, `+` or `=` and the `.` or `)`
 * of an ordered-list number are escaped too. Every `$` is posted as
 * `<span>$</span>`: GitHub runs math (which can colour, hide or resize
 * text) on `\$` and `&#36;` too. A dollar inside an element stays a plain
 * dollar, except that a paragraph of nothing but `<span>$</span><span>$</span>
 * … <span>$</span><span>$</span>` still renders as display math, so a
 * zero-width joiner goes between adjacent dollar spans. Parentheses, braces,
 * quotes and dots stay plain.
 */
function escapeMarkdown(line: string): string {
	return line
		.replace(/[\\`*_[\]<>|~&]|!(?=\[)/gu, "\\$&")
		.replace(/\$+/gu, (run) =>
			Array.from(run, () => "<span>$</span>").join(ZWJ),
		)
		.replace(
			/^(?:[#\-+=]|(\d{1,9})([.)]))/u,
			(marker, digits?: string, dot?: string) =>
				digits === undefined ? `\\${marker}` : `${digits}\\${dot}`,
		);
}

/** Nothing a reader could see: only space and invisible characters. */
const NOTHING_VISIBLE =
	/^[\s\u0085\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]*$/u;

/**
 * A file name or id as one code span it cannot close. A value with nothing
 * visible in it renders as `(empty)`, never as a bare pair of backticks,
 * which could pair with a later fence on the same line.
 */
export function postedCode(text: string, maxChars = POSTED_CODE_CHARS): string {
	if (NOTHING_VISIBLE.test(text)) {
		return "(empty)";
	}
	return inlineCode(
		inertKeepingEmoji(truncateCodePoints(foldLines(text), maxChars)),
	);
}

/**
 * A group as one unit of a body: its header lines, then each member's
 * lines. When the whole group does not fit, its header and the members that
 * fit are posted, with {@link groupCutLine} for the rest.
 */
export type CommentGroupRow = {
	head: readonly string[];
	members: readonly (readonly string[])[];
};

/** One unit of a body: plain lines, or a group that may post in part. */
export type CommentRow = readonly string[] | CommentGroupRow;

function isGroupRow(row: CommentRow): row is CommentGroupRow {
	return !Array.isArray(row);
}

/** The line that ends a group posted in part. */
export function groupCutLine(count: number): string {
	return `  - ${count} more finding(s) in this group cut to fit GitHub's comment limit; the full group is in the run record's report.md.`;
}

/**
 * Joins the head, the rows that fit, a line counting the rows cut, and the
 * tail, within {@link BODY_BUDGET} characters. Plain rows are whole: the
 * first one that does not fit ends the list. A group that does not fit
 * whole keeps its header, its first member and its cut line, and the rows
 * after it are still tried; once every row is placed, what is left goes to
 * the further members of each group posted in part, in order. A group that
 * cannot fit even its header and first member ends the list like a plain
 * row, so the rows cut are always the last ones and no later, lower row
 * posts in place of an earlier one.
 */
export function fitCommentBody(
	head: readonly string[],
	rows: readonly CommentRow[],
	tail: readonly string[],
	noun: string,
): string {
	const size = (lines: readonly string[]) =>
		lines.reduce((sum, line) => sum + line.length + 1, 0);
	const fixed = size(head) + size(tail) + 200;
	let used = fixed;
	// Per row: every line, the members shown of a group posted in part, or cut.
	const plan: Array<"whole" | "cut" | number> = [];
	let stopped = false;
	for (const row of rows) {
		if (stopped) {
			plan.push("cut");
			continue;
		}
		const whole = isGroupRow(row)
			? size(row.head) + row.members.reduce((sum, m) => sum + size(m), 0)
			: size(row);
		if (used + whole <= BODY_BUDGET) {
			used += whole;
			plan.push("whole");
			continue;
		}
		if (!isGroupRow(row)) {
			stopped = true;
			plan.push("cut");
			continue;
		}
		const [first] = row.members;
		const least =
			first === undefined
				? Number.POSITIVE_INFINITY
				: size(row.head) +
					size(first) +
					size([groupCutLine(row.members.length - 1)]);
		if (used + least <= BODY_BUDGET) {
			used += least;
			plan.push(1);
		} else {
			// Like a plain row: rows are in severity order, so nothing posted
			// may come after a group that is cut whole.
			stopped = true;
			plan.push("cut");
		}
	}
	// What is left goes to the groups posted in part, in order.
	for (const [index, row] of rows.entries()) {
		let shown = plan[index];
		if (typeof shown !== "number" || !isGroupRow(row)) {
			continue;
		}
		while (shown < row.members.length) {
			const left = row.members.length - shown - 1;
			const grow =
				size(row.members[shown] ?? []) -
				size([groupCutLine(left + 1)]) +
				(left === 0 ? 0 : size([groupCutLine(left)]));
			if (used + grow > BODY_BUDGET) {
				break;
			}
			used += grow;
			shown += 1;
		}
		plan[index] = shown === row.members.length ? "whole" : shown;
	}
	const kept = rows.flatMap((row, index) => {
		const shown = plan[index];
		if (shown === "cut") {
			return [];
		}
		if (!isGroupRow(row)) {
			return [...row];
		}
		const count = shown === "whole" ? row.members.length : shown;
		return [
			...row.head,
			...row.members.slice(0, count).flat(),
			...(count === row.members.length
				? []
				: [groupCutLine(row.members.length - count)]),
		];
	});
	const cut = plan.filter((shown) => shown === "cut").length;
	const text = [
		...head,
		...kept,
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

/** The characters a run id is made of: see `reserve` in `run/record.ts`. */
const RUN_ID = /^[A-Za-z0-9._-]+$/u;

/**
 * A run id that can sit inside the marker without closing it. The marker is
 * its own HTML block, which only `-->` ends, and a run id holds no `>`, so
 * an id with `--` (a base ref like `HEAD^`) is safe.
 */
function markerId(id: string | undefined): string | undefined {
	return id !== undefined && RUN_ID.test(id) ? id : undefined;
}

/**
 * The hidden HTML comment that ends a posted body and carries its run ids,
 * only those that apply. An id outside the run-id character set is left
 * out; with no id left there is no marker.
 */
export function runMarker(ids: {
	review?: string;
	verify?: string;
}): string | undefined {
	const review = markerId(ids.review);
	const verify = markerId(ids.verify);
	const fields = [
		...(review === undefined ? [] : [`review=${review}`]),
		...(verify === undefined ? [] : [`verify=${verify}`]),
	];
	return fields.length === 0
		? undefined
		: `<!-- review-panel ${fields.join(" ")} -->`;
}

/**
 * The lines that end a body with its marker: a blank line, then the marker.
 * Nothing when there is no marker.
 */
export function markerTail(ids: {
	review?: string;
	verify?: string;
}): string[] {
	const marker = runMarker(ids);
	return marker === undefined ? [] : ["", marker];
}

/**
 * True when a body's last non-empty line is exactly the marker of this
 * review, with or without a verify id. Seat text cannot make that line:
 * posted text escapes `<`, and a code span starts with a backtick.
 */
export function isRunMarkerFor(body: string, reviewRunId: string): boolean {
	const review = markerId(reviewRunId);
	if (review === undefined) {
		return false;
	}
	const last = body
		.split(/\r?\n/u)
		.filter((line) => line.trim() !== "")
		.at(-1);
	if (last === undefined) {
		return false;
	}
	const found = /^<!-- review-panel review=(\S+)(?: verify=(\S+))? -->$/u.exec(
		last,
	);
	return (
		found !== null &&
		found[1] === review &&
		(found[2] === undefined || markerId(found[2]) !== undefined)
	);
}
