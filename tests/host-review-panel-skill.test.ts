import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS, HELP, parseCommand } from "../cli/src/args.js";

const SKILL_PATH = new URL(
	"../host-skills/review-panel/SKILL.md",
	import.meta.url,
);
const PI_SKILL_PATH = new URL(
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

/** The text with every run of whitespace, line breaks included, as one space. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ");
}

/** Every `review-panel …` command in the skill's fenced blocks, continuations joined. */
function fencedCommands(body: string): string[] {
	const commands: string[] = [];
	for (const block of body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
		const joined = (block[1] as string).replace(/\\\n\s*/g, " ");
		for (const line of joined.split("\n")) {
			if (line.trim().startsWith("review-panel ")) {
				commands.push(line.trim());
			}
		}
	}
	return commands;
}

/** Every inline code span that is a `review-panel <action> …` command. */
function inlineActionCommands(body: string): string[] {
	return [...body.matchAll(/`(review-panel [^`]+)`/g)]
		.map((match) => flat(match[1] as string))
		.filter((command) =>
			(ACTIONS as readonly string[]).includes(command.split(" ")[1] ?? ""),
		);
}

/**
 * Splits a command as a shell would for these examples: quotes group, and a
 * `<placeholder>` (which may hold spaces) stands for one value.
 */
function tokens(command: string): string[] {
	const result: string[] = [];
	for (const match of command.matchAll(/'([^']*)'|"([^"]*)"|<[^>]*>|\S+/g)) {
		const [whole, single, double] = match;
		if (single !== undefined) result.push(single);
		else if (double !== undefined) result.push(double);
		else if (whole.startsWith("<")) result.push("x");
		else result.push(whole);
	}
	return result;
}

/** The `- \`lens\`: trigger` bullets of a skill, keyed by the lens names. */
function triggerTable(body: string): Map<string, string> {
	const table = new Map<string, string>();
	const joined = body.replace(/\n {2,}(?=\S)/g, " ");
	for (const match of joined.matchAll(
		/^- (`[a-z-]+`(?: \/ `[a-z-]+`)*): (.*)$/gm,
	)) {
		table.set(match[1] as string, (match[2] as string).trim());
	}
	return table;
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

	it("runs the CLI in order: diagnose, suggest, review, verify, by first use", () => {
		const body = splitFrontmatter(readSkill()).body;
		const firsts = ["diagnose", "suggest", "review", "verify"].map((step) => {
			const at = body.indexOf(`review-panel ${step}`);
			expect(at, `review-panel ${step} appears`).toBeGreaterThanOrEqual(0);
			return at;
		});
		for (let index = 1; index < firsts.length; index += 1) {
			expect(
				firsts[index] as number,
				`step ${index + 1} first appears after step ${index}`,
			).toBeGreaterThan(firsts[index - 1] as number);
		}
		expect(body).toContain("--kept-finding-ids");
		expect(body).toContain("review-panel resume --prior-run-id");
	});

	it("uses only commands and flags the real CLI accepts", () => {
		const body = splitFrontmatter(readSkill()).body;
		const commands = [...fencedCommands(body), ...inlineActionCommands(body)];
		const actions = new Set(commands.map((command) => command.split(" ")[1]));
		for (const action of [
			"diagnose",
			"suggest",
			"review",
			"verify",
			"resume",
			"comment",
		]) {
			expect(actions, `a ${action} command`).toContain(action);
		}
		for (const command of commands) {
			const parsed = (() => {
				try {
					return parseCommand(tokens(command).slice(1));
				} catch (error) {
					return `${command}: ${(error as Error).message}`;
				}
			})();
			expect(parsed, command).toMatchObject({ kind: "action" });
		}
		const helpFlags = new Set(HELP.match(/--[a-z][a-z-]*/g));
		for (const flag of new Set(readSkill().match(/--[a-z][a-z-]*/g))) {
			expect(helpFlags, `${flag} is a CLI flag`).toContain(flag);
		}
	});

	it("never starts Pi, opens a Herdr pane, or names seats", () => {
		const raw = readSkill();
		expect(raw).not.toMatch(/(?<![\w-])pi(?=[\s`])/);
		expect(raw).not.toMatch(/herdr/i);
		expect(raw).not.toMatch(/--session-id/);
		expect(raw).not.toMatch(/--seats/);
		expect(raw).not.toMatch(/--provider|--model/);
		expect(raw).toContain("Never start Pi");
	});

	it("runs auth login or logout only when the owner asks", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain(
			"Never run `review-panel auth login` or `auth logout` unless the owner asks",
		);
	});

	it("chooses lenses with a reason and leaves out --lenses when none is chosen", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("with a one-line reason for each");
		expect(body).toContain("Leave out `--lenses` when you chose no extra lens");
		expect(body).toContain("Do not re-run a lens you dropped");
		expect(body).toContain("`Suggest:` block");
	});

	it("finds the CLI by an absolute path when it is not installed", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("node <checkout>/cli/dist/cli/src/main.js");
		expect(body).toContain("absolute path");
		expect(body).not.toMatch(/node cli\//);
	});

	it("takes the run id from the report's Record: line", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("last folder of the report's `Record:` line");
		expect(body).toContain("full record path");
	});

	it("takes a PR base from origin after a fetch", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		const fetch = body.indexOf("`git fetch origin`");
		const base = body.indexOf("`origin/<baseRefName>`");
		expect(fetch).toBeGreaterThanOrEqual(0);
		expect(base).toBeGreaterThan(fetch);
	});

	it("posts the comment only after the owner says yes", () => {
		const body = splitFrontmatter(readSkill()).body;
		expect(body).toContain("review-panel comment --prior-run-id");
		expect(body).toContain("--owner-approved");
		expect(body).toContain("Do not post until they say yes");
		expect(body).not.toMatch(/ready to merge\b(?! on the card)/i);
	});

	it("never treats an exit code as a pass", () => {
		const raw = readSkill();
		expect(flat(splitFrontmatter(raw).body)).toContain(
			"Exit 0 is never a pass",
		);
		const rest = raw.replace(/exit 0 is never a pass/gi, "");
		expect(rest).not.toMatch(
			/exit (code )?0\b[^.]*\b(pass|passes|passed|clean|no findings|success)/i,
		);
		expect(rest).not.toMatch(/\b0 (means|is) (a )?(pass|clean)/i);
		expect(raw).not.toMatch(/\bverdict\b/i);
		expect(raw).not.toContain("—");
	});

	it("keeps lost coverage, edit authority and the landing condition", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("A dead seat is lost coverage");
		expect(body).toContain('"Review this PR" does not authorize edits');
		expect(body).toContain("no new high/medium regression on the fix");
	});

	it("keeps the same lens triggers as the Pi-side skill", () => {
		const host = triggerTable(splitFrontmatter(readSkill()).body);
		const piText = readFileSync(PI_SKILL_PATH, "utf8")
			.replaceAll("`scopingNote`", "`--scoping-note`")
			.replaceAll(" — ", ", ");
		const pi = triggerTable(splitFrontmatter(piText).body);
		expect(pi.size).toBeGreaterThanOrEqual(10);
		expect(Object.fromEntries(host)).toEqual(Object.fromEntries(pi));
	});
});
