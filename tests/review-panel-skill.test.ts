import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL_PATH = new URL(
	"../skills/review-panel-pi/SKILL.md",
	import.meta.url,
);

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
			"name: review-panel-pi",
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
			"Omit `seats`: verify then runs the owner's `defaults.verifySeats`",
			"Pass `seats` (at most two) only when the owner names them",
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
		expect(body).toContain('"action": "resume"');
		expect(body).toContain("Never write ready to merge on the comment");
		expect(body).toContain("Omit `repository`");
		expect(body).not.toContain("/absolute/path");
		expect(body).not.toContain("/Users/you/the-repo");
	});
});

describe("lens choice workflow", () => {
	it("calls suggest first, then the caller chooses lenses with reasons, then review", () => {
		const body = splitFrontmatter(readSkill()).body;
		const suggest = body.indexOf('`{ "action": "suggest", "base", "head" }`');
		const choose = body.indexOf("Choose the lenses yourself");
		const review = body.indexOf(
			'`{ "action": "review", "base", "head", "lenses" }`',
		);
		expect(suggest).toBeGreaterThan(-1);
		expect(choose).toBeGreaterThan(suggest);
		expect(review).toBeGreaterThan(choose);
		expect(body).toContain("with a one-line reason for each");
		expect(body).toContain("The tool never adds a lens by itself.");
		expect(body).toContain("`Seats:` line");
	});

	it("omits lenses when no extra lens is chosen, since the tool refuses an empty array", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain(
			"If you chose no extra lens, omit `lenses`; the tool refuses an empty array.",
		);
	});

	it("re-runs a dropped lens only on a concrete gap the report shows", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).not.toContain("If a lens you did not run was suggested");
		expect(body).toContain(
			"Do not re-run a lens you dropped in step 3 unless the report shows a concrete gap on its dimension that holistic left unsettled; then call `review` once with only that lens on the same base/head.",
		);
	});
});

describe("repository audit workflow", () => {
	it("keeps audit advisory, whole-tree, and separate from review close-out", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain('"action": "audit"');
		expect(body).toContain("whole pinned repository");
		expect(body).toContain("code-health");
		expect(body).toContain("over-engineering");
		expect(body).toContain("submit_findings");
		expect(body).toContain("AUDIT.md");
		expect(body).not.toContain("submit_audit");
		expect(body).toContain(
			"does not write `AUDIT.md`, repair files, run CI, or post",
		);
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

	it("fires the tests lens when a change adds, rewrites, or deletes tests", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain(
			"Also fire it when the change adds, rewrites, or deletes tests",
		);
	});

	it("points owners at defaults.lenses to run tests on every review", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain('`"defaults": { "lenses": ["tests"] }`');
	});

	it("documents the audit cleanup loop through a reviewed PR", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("Verify does not accept an audit run");
		expect(body).toContain('`{"action":"audit","passes":["tests"]}`');
	});

	it("judges grouped findings group by group and verifies with G-ids or F-ids (T495)", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("Findings may arrive grouped");
		expect(body).toContain("Judge each group");
		expect(body).toContain("G-ids or F-ids");
		expect(body).toContain("not agreement");
	});

	it("keeps contracts to OpenAPI, proto, or GraphQL, not app config", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("`contracts`: OpenAPI, proto, or GraphQL files");
		expect(body).toContain("config schema is not a contract");
	});
});
