import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS, HELP, parseCommand } from "../src/cli/args.js";

/** The package's one skill, for every coding agent (Claude Code, Codex, Grok, Pi). */
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

describe("the package ships one skill", () => {
	it("skills/ holds only review-panel", () => {
		expect(
			readdirSync(new URL("../skills/", import.meta.url), {
				withFileTypes: true,
			}).map((entry) => entry.name),
		).toEqual(["review-panel"]);
		expect(
			readdirSync(new URL("../skills/review-panel/", import.meta.url)),
		).toEqual(["SKILL.md"]);
	});
});

describe("review-panel skill", () => {
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

	it("runs the command itself: no other session, no pane, no seat names, no tool call", () => {
		const raw = readSkill();
		expect(raw).not.toMatch(/(?<![\w-])pi(?=[\s`])/);
		expect(raw).not.toMatch(/herdr/i);
		expect(raw).not.toMatch(/--session-id/);
		expect(raw).not.toMatch(/--seats/);
		expect(raw).not.toMatch(/--provider|--model/);
		expect(raw).not.toContain("review_panel");
		expect(raw).not.toContain('"action":');
		expect(flat(raw)).toContain("Never start another agent session");
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

	it("finds the command, or a checkout's build by an absolute path, or asks for the install", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("node <checkout>/dist/src/cli/main.js");
		expect(body).toContain("absolute path");
		expect(body).not.toMatch(/node (cli|dist)\//);
		expect(body).not.toContain("cli/dist");
		expect(body).toContain(
			"`npm install -g pi-review-panel`, then `review-panel skill install`",
		);
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

	it("says runs take minutes: a long timeout or the background, wait, and resume (R-4)", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("Review, audit, verify and resume run for minutes");
		expect(body).toContain(
			"Run them with a timeout of at least 30 minutes, or in the background, and wait for the command to exit",
		);
		expect(body).toContain("Do not start a second run while one is going");
		expect(body).toContain(
			"If the command is killed or times out, finish the run with `review-panel resume`",
		);
		const wait = body.indexOf("run for minutes");
		expect(wait).toBeGreaterThan(-1);
		expect(wait).toBeLessThan(body.indexOf("review-panel review --base"));
	});

	it("keeps the stop rule, promotion and the committed-snapshot rule", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("At most three model passes, then ask the owner");
		expect(body).toContain("Never review-fix-review-fix");
		expect(body).toContain("You may promote a low to a kept blocker");
		expect(body).toContain("Uncommitted work is invisible to the panel");
	});

	it("keeps lost coverage, edit authority and the landing condition", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("A dead seat is lost coverage");
		expect(body).toContain('"Review this PR" does not authorize edits');
		expect(body).toContain("no new high/medium regression on the fix");
	});

	it("judges grouped findings group by group and verifies with G-ids or F-ids (T495)", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("Findings may arrive grouped");
		expect(body).toContain("Judge each group");
		expect(body).toContain("G-ids or F-ids");
		expect(body).toContain("not agreement");
	});

	it("keeps the lens trigger table", () => {
		const table = triggerTable(splitFrontmatter(readSkill()).body);
		expect(table.size).toBeGreaterThanOrEqual(10);
		expect(table.get("`tests`")).toContain(
			"a behavior change with thin or missing coverage, including an untested production handoff",
		);
		expect(table.get("`tests`")).toContain(
			"Also fire it when the change adds, rewrites, or deletes tests",
		);
		expect(table.get("`tests`")).not.toContain(
			"a behavior change with no tests",
		);
		expect(table.get("`contracts`")).toBe(
			"OpenAPI, proto, or GraphQL files. A TOML or app config schema is not a contract.",
		);
		expect(table.get("`subtle-correctness`")).toMatch(/^races, caches, clocks/);
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain(
			"Fire every extra whose trigger matches, and none that do not",
		);
		expect(body).toContain('`"defaults": { "lenses": ["tests"] }`');
		expect(body).toContain("The tool never adds a lens by itself.");
	});

	it("keeps audit advisory, whole-tree, and separate from review close-out", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("review-panel audit");
		expect(body).toContain("whole pinned repository");
		expect(body).toContain("code-health");
		expect(body).toContain("over-engineering");
		expect(body).toContain("submit_findings");
		expect(body).not.toContain("submit_audit");
		expect(body).toContain(
			"does not write `AUDIT.md`, repair files, run CI, or post",
		);
		expect(body).toContain("Verify does not accept an audit run");
		expect(body).toContain("`review-panel audit --passes tests`");
	});

	it("verifies with the owner's verify seats and refuses unsigned records", () => {
		const body = flat(splitFrontmatter(readSkill()).body);
		expect(body).toContain("`defaults.verifySeats`");
		expect(body).toContain("refuses when head matches the prior run");
		expect(body).toContain("signed with the owner's record key");
		expect(body).toContain("Audit and resume never post");
	});
});
