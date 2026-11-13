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
 *   and invisible characters become U+FFFD, and a zero-width joiner breaks
 *   every `@` / `\uFF20` mention, `#123` / `owner/repo#123` / `GH-123`
 *   reference and `://` / `www.` autolink.
 * - {@link postedCode} is for file names and ids only: one code span with a
 *   fence longer than any backtick run inside, so it cannot be closed early.
 *   Nothing is escaped inside it (GitHub shows a code span literally), but
 *   `@` and `#` still get the joiner.
 */
import { inlineCode } from "../run/render.js";
import { inert, truncateCodePoints } from "./review-presentation.js";

/** Default length of one posted text field, in code points. */
export const POSTED_TEXT_CHARS = 300;
/** Default length of one posted code span's content, in code points. */
export const POSTED_CODE_CHARS = 200;

const ZWJ = "\u200D";

function foldLines(text: string): string {
	return text.replace(/[\s\u0085]+/gu, " ").trim();
}

/** Breaks every mention and `#` reference with a joiner. */
function breakMentions(text: string): string {
	return text.replace(/[@\uFF20#]/gu, `$&${ZWJ}`);
}

/** Breaks mentions, references and autolinks with a joiner. */
function breakLinks(text: string): string {
	return breakMentions(text)
		.replace(/\b(GH)-(?=\d)/giu, `$1-${ZWJ}`)
		.replace(/:\/\//gu, `:${ZWJ}//`)
		.replace(/\b(www)\./giu, `$1.${ZWJ}`);
}

/**
 * Text as one inert line of plain text. Truncation happens before escaping,
 * so a cut never leaves a dangling backslash; the joiners go in after
 * {@link inert}, which would otherwise replace them.
 */
export function postedText(text: string, maxChars = POSTED_TEXT_CHARS): string {
	const line = inert(truncateCodePoints(foldLines(text), maxChars));
	return breakLinks(line.replace(/[\\`*_[\]()#!<>|~&$]/gu, "\\$&"));
}

/** A file name or id as one code span it cannot close. */
export function postedCode(text: string, maxChars = POSTED_CODE_CHARS): string {
	return breakMentions(
		inlineCode(inert(truncateCodePoints(foldLines(text), maxChars))),
	);
}
