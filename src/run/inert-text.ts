/**
 * Text that reaches a terminal or a model with no control character, no
 * invisible format character (bidi controls, zero-width characters, U+FEFF,
 * Unicode tag characters), no other default-ignorable character (variation
 * selectors, Hangul fillers, the combining grapheme joiner) and no line or
 * paragraph separator: each shows as U+FFFD.
 */
export function inert(text: string): string {
	return text.replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
		"�",
	);
}

/**
 * Seat-authored text as one inert line: each run of tabs and line breaks,
 * with the spaces around it, becomes one space, so a planted newline cannot
 * start a Markdown heading or break a reply row; everything else `inert`
 * replaces shows as U+FFFD.
 */
export function inertLine(text: string): string {
	return inert(text.replace(/ *[\t\r\n][ \t\r\n]*/g, " "));
}
