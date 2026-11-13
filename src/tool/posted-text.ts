/**
 * The one sanitizer for every body posted to GitHub: the review and verify
 * round comments, the automatic close-out card and the manual `comment`
 * card. Text a seat wrote, a dismissed reason, a branch name or a record
 * field reaches a posted body only through {@link postedText} or
 * {@link postedCode}.
 *
 * - {@link postedText} renders it as plain text GitHub cannot turn into
 *   markup: line breaks fold to spaces (so no line-start block marker can
 *   form), Markdown and HTML specials are backslash-escaped, control, bidi
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
 *   would hide in a copied path.
 *
 * {@link fitCommentBody} cuts a body by whole rows to stay under GitHub's
 * comment limit; every posted body goes through it.
 */
import { inlineCode } from "../run/render.js";
import { truncateCodePoints } from "./review-presentation.js";

/** Default length of one posted text field, in code points. */
export const POSTED_TEXT_CHARS = 300;
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
 * Text as one inert line of plain text. Truncation happens before escaping,
 * so a cut never leaves a dangling backslash; the joiners go in after
 * {@link inert}, which would otherwise replace them.
 */
export function postedText(text: string, maxChars = POSTED_TEXT_CHARS): string {
	const line = inertKeepingEmoji(truncateCodePoints(foldLines(text), maxChars));
	return breakLinks(line.replace(/[\\`*_[\]()#!<>|~&$]/gu, "\\$&"));
}

/** A file name or id as one code span it cannot close. */
export function postedCode(text: string, maxChars = POSTED_CODE_CHARS): string {
	return inlineCode(
		inertKeepingEmoji(truncateCodePoints(foldLines(text), maxChars)),
	);
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
