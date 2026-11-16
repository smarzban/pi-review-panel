import { describe, expect, it } from "vitest";

import {
	type CommentRow,
	fitCommentBody,
	groupCutLine,
	isRunMarkerFor,
	POSTED_TEXT_CHARS,
	postedCellCode,
	postedCode,
	postedLink,
	postedText,
	prCommentUrl,
	runMarker,
	runMarkerIds,
} from "../src/tool/posted-text.js";

const ZWJ = "\u200d";
const DOLLAR = "<span>$</span>";

/**
 * T498: posted text escapes only what can form Markdown or HTML, and run
 * ids travel in one hidden marker at the end of a body.
 */

describe("posted text escapes only what can form markup", () => {
	it("leaves parentheses, braces, quotes and dots plain", () => {
		expect(postedText("call f(x) with {a: 1}, say \"hi\" 'yo'.")).toBe(
			"call f(x) with {a: 1}, say \"hi\" 'yo'.",
		);
	});

	it("posts every $ as <span>$</span>, so no seat text reaches GitHub math", () => {
		// GitHub's renderer still runs math on `\\$x\\$` and `&#36;x&#36;`; a
		// dollar inside an element stays a plain dollar unless the element
		// holds the whole paragraph's `$$` (checked with `gh api markdown`,
		// 2026-11-14).
		expect(postedText("$\\color{white}{hidden}$")).toBe(
			"<span>$</span>\\\\color{white}{hidden}<span>$</span>",
		);
		expect(postedText("$\\phantom{x}$ and $$\\Huge X$$ cost $5")).toBe(
			`<span>$</span>\\\\phantom{x}<span>$</span> and <span>$</span>${ZWJ}<span>$</span>\\\\Huge X<span>$</span>${ZWJ}<span>$</span> cost <span>$</span>5`,
		);
		expect(postedText("$ok % hidden$")).not.toMatch(/(?<!<span>)\$/);
	});

	it("escapes the inline specials", () => {
		expect(postedText("a\\b `c` *d* _e_ [f] <g> h|i ~~j~~")).toBe(
			"a\\\\b \\`c\\` \\*d\\* \\_e\\_ \\[f\\] \\<g\\> h\\|i \\~\\~j\\~\\~",
		);
	});

	it("escapes ! only before [", () => {
		expect(postedText("wow! ![img](x)")).toBe("wow! \\!\\[img\\](x)");
	});

	it("a link or image cannot form, though its parentheses stay plain", () => {
		expect(postedText("[x](https://e.example)")).toBe(
			"\\[x\\](https:\u200D//e.example)",
		);
	});

	it("escapes a block marker at the start of the text", () => {
		expect(postedText("# heading")).toBe("\\#\u200D heading");
		expect(postedText("- item")).toBe("\\- item");
		expect(postedText("+ item")).toBe("\\+ item");
		expect(postedText("=== under")).toBe("\\=== under");
		expect(postedText("1. first")).toBe("1\\. first");
		expect(postedText("12) twelfth")).toBe("12\\) twelfth");
		// Not at the start: plain.
		expect(postedText("a - b + c = d 1. e 2) f")).toBe(
			"a - b + c = d 1. e 2) f",
		);
	});

	it("keeps & escaped: an entity would decode into @, # or :// after the joiners ran", () => {
		expect(postedText("&commat;octocat &num;123 http&colon;//x &#64;y")).toBe(
			"\\&commat;octocat \\&num;123 http\\&colon;//x \\&#\u200D64;y",
		);
		expect(postedText("&lt;!-- x --&gt;")).toBe("\\&lt;!-- x --\\&gt;");
	});

	it("hostile seat text stays inert", () => {
		const cases: Array<[string, string]> = [
			["@octocat and ＠x", "@\u200Doctocat and \uFF20\u200Dx"],
			["fixes #123 and o/r#4", "fixes #\u200D123 and o/r#\u200D4"],
			["see GH-1", "see GH-\u200D1"],
			["https://evil.example", "https:\u200D//evil.example"],
			["www.evil.example", "www\\.evil.example"],
			["a\u202Eb\u2066c", "a\uFFFDb\uFFFDc"],
			["a\u200Bb\u2060c", "a\uFFFDb\uFFFDc"],
			["`code`", "\\`code\\`"],
			["<!-- hidden -->", "\\<!-- hidden --\\>"],
			["**bold**", "\\*\\*bold\\*\\*"],
			["[x](y)", "\\[x\\](y)"],
			[
				"## Review panel · close-out",
				"\\#\u200D#\u200D Review panel · close-out",
			],
		];
		for (const [input, output] of cases) {
			expect(postedText(input)).toBe(output);
		}
	});
});

describe("adjacent dollars never form display math (T500 N-1)", () => {
	it("puts a joiner between adjacent dollar spans", () => {
		// `gh api markdown` renders a paragraph that is only
		// `<span>$</span><span>$</span>\Huge X<span>$</span><span>$</span>` as
		// display math; with a joiner between the spans it stays plain text
		// (checked 2026-11-14).
		expect(postedText("$$\\Huge X$$")).toBe(
			`${DOLLAR}${ZWJ}${DOLLAR}\\\\Huge X${DOLLAR}${ZWJ}${DOLLAR}`,
		);
		expect(postedText("$$$")).toBe(`${DOLLAR}${ZWJ}${DOLLAR}${ZWJ}${DOLLAR}`);
		for (const text of ["$$", "a $$$ b $$", "$".repeat(40)]) {
			expect(postedText(text)).not.toContain("</span><span>");
		}
	});

	it("leaves a single dollar without a joiner", () => {
		expect(postedText("$5 and $6")).toBe(`${DOLLAR}5 and ${DOLLAR}6`);
	});
});

describe("a posted text field has a fixed cap after escaping (T500 N-2)", () => {
	const cap = (maxChars: number) => 2 * maxChars;

	it("caps an all-dollar field at twice its length, cut at a span boundary", () => {
		for (const maxChars of [40, POSTED_TEXT_CHARS, 1_000]) {
			const posted = postedText("$".repeat(5_000), maxChars);
			expect(posted.length).toBeLessThanOrEqual(cap(maxChars));
			// Whole spans joined by joiners, then the ellipsis: never a cut
			// inside `<span>$</span>`.
			expect(posted).toMatch(/^<span>\$<\/span>(?:‍<span>\$<\/span>)*…$/u);
			// It uses the cap, not a token of it.
			expect(posted.length).toBeGreaterThan(cap(maxChars) - 16);
		}
	});

	it("caps any field of escapes the same way, never inside an escape", () => {
		const hostile = [
			"\\".repeat(2_000),
			"@".repeat(2_000),
			"#".repeat(2_000),
			"![".repeat(1_000),
			"www.".repeat(500),
			"$\\@#&".repeat(400),
			"GH-1 ://".repeat(300),
		];
		for (const text of hostile) {
			for (const maxChars of [40, POSTED_TEXT_CHARS, 1_000]) {
				const posted = postedText(text, maxChars);
				expect(posted.length).toBeLessThanOrEqual(cap(maxChars));
				expect(posted.endsWith("…")).toBe(true);
				// Never inside a span: what is left without the spans holds no
				// bare `<` or `>`.
				expect(posted.replaceAll(DOLLAR, "")).not.toMatch(/(?<!\\)[<>]/u);
				// No dangling backslash before the ellipsis.
				expect(posted.slice(0, -1)).not.toMatch(/(?<!\\)(?:\\\\)*\\$/u);
			}
		}
	});

	it("leaves ordinary text cut by code points as before", () => {
		expect(postedText("a".repeat(400))).toBe(`${"a".repeat(300)}…`);
		expect(postedText("a_b ".repeat(100), 300)).toBe(`${"a\\_b ".repeat(75)}…`);
		expect(postedText("\\".repeat(300))).toBe("\\\\".repeat(300));
	});
});

describe("fitCommentBody stops at a group that cannot fit its first member (T500)", () => {
	const member = (id: string, chars: number) => [
		`  - **${id} [low]** ${"x".repeat(chars)}`,
	];
	const group = (id: string, members: (readonly string[])[]): CommentRow => ({
		head: [`- **${id} [low, stated by a seat]**`],
		members,
	});

	it("cuts the unfittable group and every row after it, and counts them", () => {
		const rows: CommentRow[] = [
			group("G-1", [member("F-1", 30_000)]),
			group("G-2", [member("F-2", 35_000), member("F-3", 10)]),
			group("G-3", [member("F-4", 10)]),
			["- **F-5 [low]** plain row"],
		];
		const body = fitCommentBody(["## head"], rows, ["", "<!-- m -->"], "group");
		expect(body).toContain("**G-1 ");
		expect(body).not.toContain("**G-2 ");
		// A shorter later group does not post past the cut one.
		expect(body).not.toContain("**G-3 ");
		expect(body).not.toContain("**F-5 ");
		expect(body).toContain(
			"- 3 group(s) cut to fit GitHub's comment limit; the full list is in the run record.",
		);
		expect(body.split("\n").at(-1)).toBe("<!-- m -->");
	});

	it("still gives what is left to an earlier group posted in part, and tries rows after it", () => {
		const rows: CommentRow[] = [
			group("G-1", [
				member("F-1", 20_000),
				member("F-2", 20_000),
				member("F-3", 30_000),
			]),
			group("G-2", [member("F-4", 10)]),
		];
		const body = fitCommentBody(["## head"], rows, [], "group");
		expect(body).toContain("**F-1 ");
		expect(body).toContain("**F-2 ");
		expect(body).not.toContain("**F-3 ");
		expect(body).toContain(groupCutLine(1));
		expect(body).toContain("**G-2 ");
		expect(body).not.toContain(
			"cut to fit GitHub's comment limit; the full list",
		);
	});
});

describe("the hidden run marker", () => {
	const REVIEW = "2026-11-14T17-24-42-501Z-origin-main-e52d7adb77ca8882";
	const VERIFY = "2026-11-14T18-00-00-000Z-origin-main-e52d7adb77ca8882";

	it("carries only the ids that apply", () => {
		expect(runMarker({ review: REVIEW })).toBe(
			`<!-- review-panel review=${REVIEW} -->`,
		);
		expect(runMarker({ review: REVIEW, verify: VERIFY })).toBe(
			`<!-- review-panel review=${REVIEW} verify=${VERIFY} -->`,
		);
	});

	it("omits an id that is not a run id or could close the comment", () => {
		expect(runMarker({ review: "a-->b" })).toBeUndefined();
		expect(runMarker({ review: "a>b" })).toBeUndefined();
		expect(runMarker({ review: "a b" })).toBeUndefined();
		expect(runMarker({ review: "" })).toBeUndefined();
		expect(runMarker({ review: REVIEW, verify: "x -->" })).toBe(
			`<!-- review-panel review=${REVIEW} -->`,
		);
	});

	it("matches only the exact marker as the last non-empty line", () => {
		const marker = runMarker({ review: REVIEW, verify: VERIFY }) as string;
		expect(isRunMarkerFor(`## x\n\nbody\n\n${marker}\n`, REVIEW)).toBe(true);
		expect(
			isRunMarkerFor(`## x\n\n<!-- review-panel review=${REVIEW} -->`, REVIEW),
		).toBe(true);
		// Another review's marker, or the id elsewhere in the body.
		expect(isRunMarkerFor(`## x\n\n${marker}`, VERIFY)).toBe(false);
		expect(isRunMarkerFor(`## x\n${marker}\nlater`, REVIEW)).toBe(false);
		expect(isRunMarkerFor(`## x\nReview \`${REVIEW}\``, REVIEW)).toBe(false);
		// An id with -- is still a run id: the marker is its own HTML block,
		// which only `-->` ends, and no run id holds a `>`.
		expect(runMarker({ review: "a--b" })).toBe(
			"<!-- review-panel review=a--b -->",
		);
		expect(
			isRunMarkerFor("## x\n\n<!-- review-panel review=a--b -->", "a--b"),
		).toBe(true);
	});

	it("seat text cannot produce the marker, as text or as a code span", () => {
		const marker = runMarker({ review: REVIEW }) as string;
		expect(isRunMarkerFor(`## x\n- ${postedText(marker)}`, REVIEW)).toBe(false);
		expect(isRunMarkerFor(`## x\n- ${postedCode(marker)}`, REVIEW)).toBe(false);
		expect(postedText(marker)).toMatch(/^\\<!-- /);
	});
});

describe("a run id with --", () => {
	it("a base ref like HEAD^ gives a run id with --, which still gets a marker and is found", async () => {
		const { sanitizeBaseRef } = await import("../src/run/record.js");
		const id = `2026-11-14T17-24-42-501Z-${sanitizeBaseRef("HEAD^")}-e52d7adb77ca8882`;
		expect(id).toContain("--");
		expect(runMarker({ review: id })).toBe(
			`<!-- review-panel review=${id} -->`,
		);
		expect(
			isRunMarkerFor(`## x\n\n<!-- review-panel review=${id} -->`, id),
		).toBe(true);
	});
});

describe("a link to this PR's own comment (T505)", () => {
	const place = { repo: "smarzban/demo", pr: 35 };
	const good = "https://github.com/smarzban/demo/pull/35#issuecomment-123";

	it("takes only the comment URL gh gave for this PR and comment id", () => {
		expect(prCommentUrl(good, place, 123)).toBe(good);
		expect(prCommentUrl(good, place)).toBe(good);
		// A GitHub Enterprise host is still the PR's own URL.
		expect(
			prCommentUrl(
				"https://ghe.example.com/smarzban/demo/pull/35#issuecomment-9",
				place,
				9,
			),
		).toBe("https://ghe.example.com/smarzban/demo/pull/35#issuecomment-9");
	});

	it("refuses anything else", () => {
		for (const raw of [
			undefined,
			42,
			"",
			"http://github.com/smarzban/demo/pull/35#issuecomment-123",
			"https://github.com/smarzban/other/pull/35#issuecomment-123",
			"https://github.com/smarzban/demo/pull/36#issuecomment-123",
			"https://github.com/smarzban/demo/issues/35#issuecomment-123",
			"https://github.com/smarzban/demo/pull/35#issuecomment-124",
			`${good})`,
			`${good} "title"`,
			`${good}\n[x](https://evil.test)`,
			"javascript:alert(1)",
			"https://user@github.com/smarzban/demo/pull/35#issuecomment-123",
			"https://github.com:443/smarzban/demo/pull/35#issuecomment-123",
			"https://github.com/smarzban/demo/pull/35?x=1#issuecomment-123",
		]) {
			expect(prCommentUrl(raw, place, 123)).toBeUndefined();
		}
	});

	it("posts a link only for such a URL, with its label as posted text", () => {
		expect(postedLink("verify 2", good)).toBe(`[verify 2](${good})`);
		expect(postedLink("[x]", good)).toBe(`[\\[x\\]](${good})`);
		expect(postedLink("review", "javascript:alert(1)")).toBeUndefined();
		expect(postedLink("review", `${good})`)).toBeUndefined();
	});
});

describe("the run ids a marker carries (T505)", () => {
	it("reads the review and verify ids from the last non-empty line only", () => {
		expect(
			runMarkerIds("## x\n\n<!-- review-panel review=r-1 verify=v-1 -->\n"),
		).toEqual({ review: "r-1", verify: "v-1" });
		expect(runMarkerIds("## x\n\n<!-- review-panel review=r-1 -->")).toEqual({
			review: "r-1",
		});
		expect(
			runMarkerIds("## x\n<!-- review-panel review=r-1 -->\nlater"),
		).toBeUndefined();
		// Only ids of the run-id character set.
		expect(
			runMarkerIds("## x\n<!-- review-panel review=../x -->"),
		).toBeUndefined();
		expect(
			runMarkerIds("## x\n<!-- review-panel review=a b -->"),
		).toBeUndefined();
	});
});

describe("a code span inside a table cell", () => {
	it("escapes every pipe, so the span cannot split the cell", () => {
		expect(postedCellCode("a|b.ts")).toBe("`a\\|b.ts`");
		expect(postedCellCode("`x`|y")).toBe("`` `x`\\|y ``");
	});

	it("is the same code span when there is no pipe", () => {
		expect(postedCellCode("src/a.ts:3")).toBe(postedCode("src/a.ts:3"));
		expect(postedCellCode("")).toBe("(empty)");
	});
});

describe("a group's cut line", () => {
	it("is its own list item after a blank line, so it closes the last member's toggle and is not nested under it", () => {
		const line = groupCutLine(2);
		expect(line.startsWith("\n- 2 more finding(s) in this group")).toBe(true);
	});
});
