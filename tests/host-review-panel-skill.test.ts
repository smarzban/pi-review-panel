import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL_PATH = new URL(
	"../host-skills/review-panel/SKILL.md",
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

describe("host review-panel skill", () => {
	it("declares the exact name and a single-line description", () => {
		const { frontmatter } = splitFrontmatter(readSkill());
		const lines = frontmatter.split("\n").filter((line) => line.trim() !== "");
		expect(lines.filter((line) => line.startsWith("name:"))).toEqual([
			"name: review-panel",
		]);
		const descriptionLines = lines.filter((line) =>
			line.startsWith("description:"),
		);
		expect(descriptionLines).toHaveLength(1);
		expect(lines).toHaveLength(2);
		expect(new TextEncoder().encode(frontmatter).length).toBeLessThanOrEqual(
			1024,
		);
	});

	it("runs the CLI in order: diagnose, suggest, review, verify", () => {
		const body = splitFrontmatter(readSkill()).body;
		const steps = [
			"review-panel diagnose",
			"review-panel suggest --base",
			"review-panel review --base",
			"review-panel verify --prior-run-id",
		];
		let from = 0;
		for (const step of steps) {
			const at = body.indexOf(step, from);
			expect(at, `${step} after the previous step`).toBeGreaterThanOrEqual(
				from,
			);
			from = at + step.length;
		}
		expect(body).toContain("--kept-finding-ids");
		expect(body).toContain("review-panel resume --prior-run-id");
		expect(body).toContain("node cli/dist/cli/src/main.js");
	});

	it("never starts Pi, opens a Herdr pane, or names seats", () => {
		const raw = readSkill();
		expect(raw).not.toMatch(/\bpi -p\b/);
		expect(raw).not.toMatch(/herdr/i);
		expect(raw).not.toMatch(/--session-id/);
		expect(raw).not.toMatch(/--seats/);
		expect(raw).not.toMatch(/--provider|--model/);
		expect(raw).toContain("Never start Pi");
	});

	it("posts the comment only after the owner says yes", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("review-panel comment --prior-run-id");
		expect(body).toContain("--owner-approved");
		expect(body).toContain("Do not post until they say yes");
		expect(body).not.toMatch(/ready to merge\b(?! on the card)/i);
	});

	it("never treats an exit code as a pass", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("Exit 0 is never a pass");
		expect(body).not.toMatch(/exit (code )?0 (means|is) (a )?(pass|clean)/i);
		expect(body).not.toMatch(/\bverdict\b/i);
		expect(body).not.toContain("—");
	});
});
