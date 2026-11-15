/**
 * `review-panel skill install` / `uninstall` and the diagnose skill rows. Every
 * test uses a temporary HOME and an explicit, empty environment, so none can
 * reach the real ~/.claude, ~/.codex, ~/.grok or ~/.pi.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function lexistsSync(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

import {
	AGENTS,
	agentHome,
	installSkill,
	SKILL_STAMP_FILE,
	type SkillOptions,
	skillStatus,
	uninstallSkill,
} from "../../src/cli/skill.js";

function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** A package folder holding skills/review-panel/SKILL.md, as the tarball does. */
function fakePackage(): string {
	const root = tempDir("rp-pkg-");
	mkdirSync(path.join(root, "skills", "review-panel"), { recursive: true });
	writeFileSync(
		path.join(root, "skills", "review-panel", "SKILL.md"),
		"---\nname: review-panel\n---\n",
	);
	return path.join(root, "skills", "review-panel");
}

function options(
	home: string,
	source: string,
	extra: Partial<SkillOptions> = {},
): SkillOptions {
	return {
		home,
		env: {},
		platform: "darwin",
		source: { dir: source, version: "1.2.3" },
		...extra,
	};
}

const target = (skills: string) => path.join(skills, "review-panel");

describe("agent homes", () => {
	it("are ~/.claude, ~/.codex, ~/.grok and ~/.pi/agent, each overridable by its own variable", () => {
		const home = "/home/u";
		expect(
			AGENTS.map((agent) => [
				agent.id,
				agent.envVar,
				agentHome(agent, home, {}),
			]),
		).toEqual([
			["claude", "CLAUDE_CONFIG_DIR", "/home/u/.claude"],
			["codex", "CODEX_HOME", "/home/u/.codex"],
			["grok", "GROK_HOME", "/home/u/.grok"],
			["pi", "PI_CODING_AGENT_DIR", "/home/u/.pi/agent"],
		]);
		const env = {
			CLAUDE_CONFIG_DIR: "/cfg/claude",
			CODEX_HOME: "~/codex-home",
			GROK_HOME: "",
			PI_CODING_AGENT_DIR: "~/pi-agent",
		};
		expect(AGENTS.map((agent) => agentHome(agent, home, env))).toEqual([
			"/cfg/claude",
			"/home/u/codex-home",
			// An empty variable counts as unset.
			"/home/u/.grok",
			"/home/u/pi-agent",
		]);
	});
});

describe("a relative folder override (R-5)", () => {
	it("is refused by name, never resolved against the working folder", () => {
		const codex = AGENTS.find((agent) => agent.id === "codex");
		expect(() =>
			agentHome(codex as (typeof AGENTS)[number], "/home/u", {
				CODEX_HOME: "rel/codex",
			}),
		).toThrow(
			'CODEX_HOME is a relative path ("rel/codex"); set it to an absolute path',
		);
	});

	it("skips that agent in install, uninstall and diagnose, and creates nothing", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".claude"));
		const env = { CODEX_HOME: "rel/codex" };
		const installed = installSkill(options(home, source, { env }));
		expect(installed.ok).toBe(false);
		expect(installed.lines.join("\n")).toContain(
			'Codex: skipped: CODEX_HOME is a relative path ("rel/codex"); set it to an absolute path',
		);
		expect(readlinkSync(target(path.join(home, ".claude", "skills")))).toBe(
			source,
		);
		expect(existsSync(path.join(process.cwd(), "rel"))).toBe(false);
		expect(uninstallSkill(options(home, source, { env })).lines).toContain(
			'Codex: skipped: CODEX_HOME is a relative path ("rel/codex"); set it to an absolute path',
		);
		expect(skillStatus(options(home, source, { env }))).toContain(
			'- Codex: CODEX_HOME is a relative path ("rel/codex"); set it to an absolute path',
		);
	});
});

describe("skill install", () => {
	it("links the skill into each agent whose home exists, and creates nothing for the others", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".claude"));
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });

		const result = installSkill(options(home, source));

		expect(result.ok).toBe(true);
		for (const skills of [
			path.join(home, ".claude", "skills"),
			path.join(home, ".pi", "agent", "skills"),
		]) {
			expect(lstatSync(target(skills)).isSymbolicLink()).toBe(true);
			expect(readlinkSync(target(skills))).toBe(source);
			expect(
				readFileSync(path.join(target(skills), "SKILL.md"), "utf8"),
			).toContain("name: review-panel");
		}
		expect(existsSync(path.join(home, ".codex"))).toBe(false);
		expect(existsSync(path.join(home, ".grok"))).toBe(false);
		const text = result.lines.join("\n");
		expect(text).toContain(
			`Claude Code: linked ${target(path.join(home, ".claude", "skills"))}`,
		);
		expect(text).toContain(
			`Codex: not found (${path.join(home, ".codex")} does not exist)`,
		);
		expect(text).toContain("Grok: not found");
	});

	it("honours each agent's folder variable", () => {
		const home = tempDir("rp-home-");
		const elsewhere = tempDir("rp-codex-");
		const source = fakePackage();
		const result = installSkill(
			options(home, source, { env: { CODEX_HOME: elsewhere } }),
		);
		expect(result.ok).toBe(true);
		expect(readlinkSync(target(path.join(elsewhere, "skills")))).toBe(source);
		expect(existsSync(path.join(home, ".codex"))).toBe(false);
	});

	it("is ok to run again: an existing link to this package is left as it is", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".grok"));
		installSkill(options(home, source));
		const again = installSkill(options(home, source));
		expect(again.ok).toBe(true);
		expect(again.lines.join("\n")).toContain("Grok: already linked");
	});

	it("reports no agent, and fails, when no agent home exists", () => {
		const home = tempDir("rp-home-");
		const result = installSkill(options(home, fakePackage()));
		expect(result.ok).toBe(false);
		expect(result.lines.join("\n")).toContain(
			"No coding agent found. Pass --agent claude,codex,grok,pi to install anyway.",
		);
		expect(existsSync(path.join(home, ".claude"))).toBe(false);
	});

	it("--agent installs for a missing agent, creating its skills folder", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		const result = installSkill(options(home, source, { agents: ["codex"] }));
		expect(result.ok).toBe(true);
		expect(readlinkSync(target(path.join(home, ".codex", "skills")))).toBe(
			source,
		);
		expect(existsSync(path.join(home, ".claude"))).toBe(false);
	});

	it("--dry-run says what it would do and changes nothing", () => {
		const home = tempDir("rp-home-");
		mkdirSync(path.join(home, ".claude"));
		const result = installSkill(
			options(home, fakePackage(), {
				dryRun: true,
				agents: ["claude", "grok"],
			}),
		);
		expect(result.ok).toBe(true);
		const text = result.lines.join("\n");
		expect(text).toContain(
			`Claude Code: would link ${target(path.join(home, ".claude", "skills"))}`,
		);
		expect(text).toContain(
			`Grok: would link ${target(path.join(home, ".grok", "skills"))}`,
		);
		expect(existsSync(path.join(home, ".claude", "skills"))).toBe(false);
		expect(existsSync(path.join(home, ".grok"))).toBe(false);
	});

	it("never replaces a review-panel folder or a foreign link without --force", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		const claudeSkills = path.join(home, ".claude", "skills");
		const codexSkills = path.join(home, ".codex", "skills");
		mkdirSync(target(claudeSkills), { recursive: true });
		writeFileSync(path.join(target(claudeSkills), "SKILL.md"), "mine");
		mkdirSync(codexSkills, { recursive: true });
		const foreign = tempDir("rp-foreign-");
		symlinkSync(foreign, target(codexSkills));

		const refused = installSkill(options(home, source));
		expect(refused.ok).toBe(false);
		const text = refused.lines.join("\n");
		expect(text).toContain(
			`Claude Code: skipped: ${target(claudeSkills)} is a folder that is not this package's link. Re-run with --agent claude --force to replace it.`,
		);
		expect(text).toContain(
			`Codex: skipped: ${target(codexSkills)} links to ${foreign}, not this package. Re-run with --agent codex --force to replace it.`,
		);
		expect(
			readFileSync(path.join(target(claudeSkills), "SKILL.md"), "utf8"),
		).toBe("mine");
		expect(readlinkSync(target(codexSkills))).toBe(foreign);
		// The foreign link's own folder is never touched.
		expect(existsSync(foreign)).toBe(true);

		expect(() => installSkill(options(home, source, { force: true }))).toThrow(
			"--force needs --agent",
		);
		const forced = installSkill(
			options(home, source, { force: true, agents: ["claude", "codex"] }),
		);
		expect(forced.ok).toBe(true);
		expect(readlinkSync(target(claudeSkills))).toBe(source);
		expect(readlinkSync(target(codexSkills))).toBe(source);
		expect(existsSync(foreign)).toBe(true);
		expect(forced.lines.join("\n")).toContain(
			`Claude Code: replaced ${target(claudeSkills)}`,
		);
	});

	it("names a broken link and replaces it only with --force", () => {
		const home = tempDir("rp-home-");
		const skills = path.join(home, ".grok", "skills");
		mkdirSync(skills, { recursive: true });
		const gone = path.join(home, "gone", "skills", "review-panel");
		symlinkSync(gone, target(skills));
		const refused = installSkill(options(home, fakePackage()));
		expect(refused.ok).toBe(false);
		expect(refused.lines.join("\n")).toContain(
			`Grok: skipped: ${target(skills)} is a broken link to ${gone}. Re-run with --agent grok --force to replace it.`,
		);
		expect(
			installSkill(
				options(home, fakePackage(), { force: true, agents: ["grok"] }),
			).ok,
		).toBe(true);
	});

	it("hints at an old pi-review skill and never deletes it", () => {
		const home = tempDir("rp-home-");
		const old = path.join(home, ".claude", "skills", "pi-review");
		mkdirSync(old, { recursive: true });
		writeFileSync(path.join(old, "SKILL.md"), "old");
		const result = installSkill(options(home, fakePackage()));
		expect(result.ok).toBe(true);
		expect(result.lines.join("\n")).toContain(
			`Hint: ${old} is the retired pi-review skill; review-panel replaces it. Remove it yourself when you are ready: rm -rf '${old}'`,
		);
		expect(readFileSync(path.join(old, "SKILL.md"), "utf8")).toBe("old");
	});

	it("on Windows copies the skill with a version stamp instead of linking, and refreshes its own copy", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		const skills = path.join(home, ".codex", "skills");
		mkdirSync(path.join(home, ".codex"));
		const windows = { platform: "win32" as const };

		const first = installSkill(options(home, source, windows));
		expect(first.ok).toBe(true);
		expect(lstatSync(target(skills)).isSymbolicLink()).toBe(false);
		expect(
			readFileSync(path.join(target(skills), "SKILL.md"), "utf8"),
		).toContain("name: review-panel");
		expect(
			JSON.parse(
				readFileSync(path.join(target(skills), SKILL_STAMP_FILE), "utf8"),
			),
		).toEqual({ package: "pi-review-panel", version: "1.2.3" });
		expect(first.lines.join("\n")).toContain(
			`Codex: copied to ${target(skills)}`,
		);

		writeFileSync(
			path.join(source, "SKILL.md"),
			"---\nname: review-panel\n---\nv2\n",
		);
		const second = installSkill(
			options(home, source, {
				...windows,
				source: { dir: source, version: "1.2.4" },
			}),
		);
		expect(second.ok).toBe(true);
		expect(
			readFileSync(path.join(target(skills), "SKILL.md"), "utf8"),
		).toContain("v2");
		expect(second.lines.join("\n")).toContain(
			`Codex: refreshed the copy at ${target(skills)} (1.2.3 to 1.2.4)`,
		);
	});
});

/** The frontmatter of the old host skill the 0.3.0 README told users to copy. */
const OLD_HOST_SKILL =
	'---\nname: review-panel\ndescription: "Run the review-panel CLI on a PR or a local change, read its report, and judge each finding keep or skip."\n---\n\n# Review panel from the command line\n';

describe("upgrades from earlier installs (R-2)", () => {
	function earlierInstall(present: boolean): string {
		const prefix = tempDir("rp-old-prefix-");
		const dir = path.join(
			prefix,
			"lib",
			"node_modules",
			"pi-review-panel",
			"skills",
			"review-panel",
		);
		if (present) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, "SKILL.md"), "old");
		}
		return dir;
	}

	for (const present of [true, false]) {
		it(`replaces a ${present ? "" : "broken "}link into an earlier pi-review-panel install without --force`, () => {
			const home = tempDir("rp-home-");
			const source = fakePackage();
			const skills = path.join(home, ".codex", "skills");
			mkdirSync(skills, { recursive: true });
			const old = earlierInstall(present);
			symlinkSync(old, target(skills));

			expect(skillStatus(options(home, source, { agents: ["codex"] }))).toEqual(
				[
					`- Codex: ${target(skills)} links to an earlier pi-review-panel install (${old}); run review-panel skill install`,
				],
			);
			const result = installSkill(options(home, source));
			expect(result.ok).toBe(true);
			expect(result.lines.join("\n")).toContain(
				`Codex: replaced the link to an earlier pi-review-panel install (${old}): linked ${target(skills)} -> ${source}`,
			);
			expect(readlinkSync(target(skills))).toBe(source);
			if (present) {
				expect(readFileSync(path.join(old, "SKILL.md"), "utf8")).toBe("old");
			}
		});
	}

	it("uninstall removes a link into an earlier pi-review-panel install", () => {
		const home = tempDir("rp-home-");
		const skills = path.join(home, ".grok", "skills");
		mkdirSync(skills, { recursive: true });
		const old = earlierInstall(true);
		symlinkSync(old, target(skills));
		const result = uninstallSkill(options(home, fakePackage()));
		expect(result.lines).toContain(`Grok: removed ${target(skills)}`);
		expect(lexistsSync(target(skills))).toBe(false);
		expect(existsSync(path.join(old, "SKILL.md"))).toBe(true);
	});

	it("replaces the old host-skill copy without --force, and names it", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		const skills = path.join(home, ".claude", "skills");
		mkdirSync(target(skills), { recursive: true });
		writeFileSync(path.join(target(skills), "SKILL.md"), OLD_HOST_SKILL);

		expect(skillStatus(options(home, source, { agents: ["claude"] }))).toEqual([
			`- Claude Code: ${target(skills)} is the old review-panel host-skill copy; run review-panel skill install to replace it`,
		]);
		expect(uninstallSkill(options(home, source)).lines).toContain(
			`Claude Code: left alone: ${target(skills)} is the old review-panel host-skill copy; review-panel skill install replaces it.`,
		);
		const result = installSkill(options(home, source));
		expect(result.ok).toBe(true);
		expect(result.lines.join("\n")).toContain(
			`Claude Code: replaced the old review-panel host-skill copy: linked ${target(skills)} -> ${source}`,
		);
		expect(readlinkSync(target(skills))).toBe(source);
	});

	it("still refuses a review-panel folder with anything beside that SKILL.md", () => {
		const home = tempDir("rp-home-");
		const skills = path.join(home, ".claude", "skills");
		mkdirSync(target(skills), { recursive: true });
		writeFileSync(path.join(target(skills), "SKILL.md"), OLD_HOST_SKILL);
		writeFileSync(path.join(target(skills), "notes.md"), "mine");
		const result = installSkill(options(home, fakePackage()));
		expect(result.ok).toBe(false);
		expect(readFileSync(path.join(target(skills), "notes.md"), "utf8")).toBe(
			"mine",
		);
	});
});

describe("skill uninstall", () => {
	it("removes only links into this package, and leaves the package's skill in place", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".claude"));
		mkdirSync(path.join(home, ".grok", "skills", "review-panel"), {
			recursive: true,
		});
		installSkill(options(home, source));

		const result = uninstallSkill(options(home, source));
		expect(result.ok).toBe(true);
		const claudeTarget = target(path.join(home, ".claude", "skills"));
		expect(existsSync(claudeTarget)).toBe(false);
		expect(existsSync(path.join(source, "SKILL.md"))).toBe(true);
		const text = result.lines.join("\n");
		expect(text).toContain(`Claude Code: removed ${claudeTarget}`);
		expect(text).toContain(
			`Grok: left alone: ${target(path.join(home, ".grok", "skills"))} is a folder that is not this package's link.`,
		);
		expect(existsSync(path.join(home, ".grok", "skills", "review-panel"))).toBe(
			true,
		);
	});

	it("removes this package's stamped Windows copy", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".grok"));
		const windows = { platform: "win32" as const };
		installSkill(options(home, source, windows));
		const result = uninstallSkill(options(home, source, windows));
		expect(result.ok).toBe(true);
		expect(existsSync(target(path.join(home, ".grok", "skills")))).toBe(false);
	});

	it("--dry-run removes nothing", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		mkdirSync(path.join(home, ".codex"));
		installSkill(options(home, source));
		const result = uninstallSkill(options(home, source, { dryRun: true }));
		expect(result.lines.join("\n")).toContain("Codex: would remove");
		expect(readlinkSync(target(path.join(home, ".codex", "skills")))).toBe(
			source,
		);
	});
});

describe("skill status for diagnose", () => {
	it("names each agent's state: linked, missing, broken, foreign, stale copy, and old pi-review copies", () => {
		const home = tempDir("rp-home-");
		const source = fakePackage();
		// Claude: linked. Codex: home but no skill. Grok: broken link. Pi: stale copy.
		mkdirSync(path.join(home, ".claude"));
		installSkill(options(home, source, { agents: ["claude"] }));
		mkdirSync(path.join(home, ".codex"));
		const grokSkills = path.join(home, ".grok", "skills");
		mkdirSync(grokSkills, { recursive: true });
		symlinkSync(path.join(home, "gone"), target(grokSkills));
		mkdirSync(path.join(grokSkills, "pi-review"));
		installSkill(
			options(home, source, {
				agents: ["pi"],
				platform: "win32",
				source: { dir: source, version: "1.0.0" },
			}),
		);

		const lines = skillStatus(options(home, source));
		expect(lines).toEqual([
			`- Claude Code: linked (${target(path.join(home, ".claude", "skills"))})`,
			`- Codex: not installed; run review-panel skill install`,
			`- Grok: broken link to ${path.join(home, "gone")} at ${target(grokSkills)}; run review-panel skill install --agent grok --force`,
			`- Grok: old pi-review skill at ${path.join(grokSkills, "pi-review")}; remove it yourself`,
			`- Pi: stale copy 1.0.0 (this is 1.2.3) at ${target(path.join(home, ".pi", "agent", "skills"))}; run review-panel skill install`,
		]);
	});

	it("says when an agent is not found", () => {
		const home = tempDir("rp-home-");
		expect(skillStatus(options(home, fakePackage()))).toEqual([
			`- Claude Code: not found (${path.join(home, ".claude")} does not exist)`,
			`- Codex: not found (${path.join(home, ".codex")} does not exist)`,
			`- Grok: not found (${path.join(home, ".grok")} does not exist)`,
			`- Pi: not found (${path.join(home, ".pi", "agent")} does not exist)`,
		]);
	});
});
