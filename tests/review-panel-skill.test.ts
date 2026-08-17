// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL_PATH = new URL("../skills/review-panel/SKILL.md", import.meta.url);

function readSkill(): string {
	return readFileSync(SKILL_PATH, "utf8");
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
	expect(raw.startsWith("---\n")).toBe(true);
	const closing = raw.indexOf("\n---\n", 4);
	expect(closing).toBeGreaterThan(4);
	return {
		frontmatter: raw.slice(4, closing),
		body: raw.slice(closing + "\n---\n".length),
	};
}

describe("review skill frontmatter", () => {
	it("declares the exact name and a non-empty single-line description", () => {
		const { frontmatter } = splitFrontmatter(readSkill());
		const lines = frontmatter.split("\n").filter((line) => line.trim() !== "");

		expect(lines.filter((line) => line.startsWith("name:"))).toEqual([
			"name: review-panel",
		]);
		const descriptionLines = lines.filter((line) =>
			line.startsWith("description:"),
		);
		expect(descriptionLines).toHaveLength(1);
		expect(
			descriptionLines[0]?.slice("description:".length).trim().length,
		).toBeGreaterThan(0);
		expect(lines).toHaveLength(2);
	});
});

describe("review skill required workflow", () => {
	it("names the public tool and the discover-judge-fix path", () => {
		const body = splitFrontmatter(readSkill()).body;
		for (const token of [
			"review_panel",
			"diagnose",
			"review",
			"holistic",
			"scopingNote",
			"promote",
			"three model passes",
			"verify",
			"keptFindingIds",
			"Never call the tool with `{}`",
			"`subtle-correctness`: races",
			"Uncommitted",
			"ownerApproved",
			"close-out comment",
		]) {
			expect(body, token).toContain(token);
		}
		expect(body).not.toContain("review_panel_loop");
		expect(body).not.toContain("loopClaimAdjudication");
		expect(body).not.toContain("repairAuthorization");
		expect(body).not.toMatch(/\bverdict\b/i);
		expect(body).not.toMatch(/\bquorum\b/i);
		expect(body).toContain("Do not post until they say yes");
		expect(body).toContain('"action": "comment"');
		expect(body).toContain("Never write ready to merge on the comment");
		expect(body).toContain("/Users/you/the-repo");
		expect(body).not.toContain("/absolute/path");
	});
});

describe("review skill extra-lens triggers", () => {
	it("fires every matching extra and does not cap extras at two", () => {
		const { frontmatter, body } = splitFrontmatter(readSkill());
		expect(frontmatter).not.toContain("at most two extras");
		expect(body).not.toContain("never more than two on the first review");
		expect(body).toContain(
			"Fire every extra whose trigger matches, and none that do not",
		);
	});

	it("treats tests as thin coverage, not the absence of test files", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain(
			"`tests`: a behavior change with thin or missing coverage",
		);
		expect(body).toContain("untested production handoff");
		expect(body).not.toContain("a behavior change with no tests");
	});

	it("keeps contracts to OpenAPI, proto, or GraphQL, not app config", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("`contracts`: OpenAPI, proto, or GraphQL files");
		expect(body).toContain("config schema is not a contract");
	});
});
