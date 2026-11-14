import { describe, expect, it } from "vitest";

import {
	isRunMarkerFor,
	postedCode,
	postedText,
	runMarker,
} from "../src/tool/posted-text.js";

/**
 * T498: posted text escapes only what can form Markdown or HTML, and run
 * ids travel in one hidden marker at the end of a body.
 */

describe("posted text escapes only what can form markup", () => {
	it("leaves parentheses, braces, dollars, quotes and dots plain", () => {
		expect(postedText("call f(x) with {a: 1} for $5, say \"hi\" 'yo'.")).toBe(
			"call f(x) with {a: 1} for $5, say \"hi\" 'yo'.",
		);
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
		expect(runMarker({ review: "a--b" })).toBeUndefined();
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
		// An id that cannot be in a marker is never found.
		expect(
			isRunMarkerFor("## x\n<!-- review-panel review=a--b -->", "a--b"),
		).toBe(false);
	});

	it("seat text cannot produce the marker, as text or as a code span", () => {
		const marker = runMarker({ review: REVIEW }) as string;
		expect(isRunMarkerFor(`## x\n- ${postedText(marker)}`, REVIEW)).toBe(false);
		expect(isRunMarkerFor(`## x\n- ${postedCode(marker)}`, REVIEW)).toBe(false);
		expect(postedText(marker)).toMatch(/^\\<!-- /);
	});
});

describe("a run id the marker cannot hold", () => {
	it("a base ref like HEAD^ gives a real run id with --: no marker, never found", async () => {
		const { sanitizeBaseRef } = await import("../src/run/record.js");
		const id = `2026-11-14T17-24-42-501Z-${sanitizeBaseRef("HEAD^")}-e52d7adb77ca8882`;
		expect(id).toContain("--");
		expect(runMarker({ review: id })).toBeUndefined();
		expect(isRunMarkerFor(`## x\n<!-- review-panel review=${id} -->`, id)).toBe(
			false,
		);
	});
});
