// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL_PATH = new URL(
	"../host-skills/pi-review/SKILL.md",
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

describe("host pi-review skill", () => {
	it("declares the exact name and a single-line description", () => {
		const { frontmatter } = splitFrontmatter(readSkill());
		const lines = frontmatter.split("\n").filter((line) => line.trim() !== "");
		expect(lines.filter((line) => line.startsWith("name:"))).toEqual([
			"name: pi-review",
		]);
		const descriptionLines = lines.filter((line) =>
			line.startsWith("description:"),
		);
		expect(descriptionLines).toHaveLength(1);
		expect(new TextEncoder().encode(frontmatter).length).toBeLessThanOrEqual(
			1024,
		);
	});

	it("asks the owner before posting and never has Pi implement", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("Do not post until they say yes");
		expect(body).toContain("action comment");
		expect(body).toContain("ownerApproved: true");
		expect(body).toContain("Do not call `review_panel`");
		expect(body).toContain("It never implements");
		expect(body).toContain("do not write ready to merge on the card");
		expect(body).not.toMatch(/\bverdict\b/i);
		expect(body).not.toContain("\u2014");
	});
});
