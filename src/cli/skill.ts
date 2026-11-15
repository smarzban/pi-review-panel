/**
 * `review-panel skill install` / `uninstall`, and the skill rows diagnose
 * prints. The package's one skill (`skills/review-panel`) is linked into each
 * coding agent's personal skills folder:
 *
 * | Agent       | Folder variable       | Default home   | Skills folder    |
 * |-------------|-----------------------|----------------|------------------|
 * | Claude Code | `CLAUDE_CONFIG_DIR`   | `~/.claude`    | `<home>/skills`  |
 * | Codex       | `CODEX_HOME`          | `~/.codex`     | `<home>/skills`  |
 * | Grok        | `GROK_HOME`           | `~/.grok`      | `<home>/skills`  |
 * | Pi          | `PI_CODING_AGENT_DIR` | `~/.pi/agent`  | `<home>/skills`  |
 *
 * An agent counts as present when its home folder exists; no folder is ever
 * created for an absent agent unless it is named with `--agent`. A
 * `review-panel` entry that is not this package's link (or, on Windows, this
 * package's stamped copy) is replaced only with `--force`, and uninstall
 * removes only this package's own link or copy. Old `pi-review` skills are
 * named, never deleted.
 */
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export const SKILL_NAME = "review-panel";
/** The retired host skill that started Pi from another agent. */
export const OLD_SKILL_NAME = "pi-review";
/** Written into a copied skill (Windows), naming the package and version. */
export const SKILL_STAMP_FILE = ".review-panel-install.json";
const PACKAGE_NAME = "pi-review-panel";

export type AgentId = "claude" | "codex" | "grok" | "pi";

export type AgentSpec = {
	id: AgentId;
	label: string;
	/** The variable the agent itself reads to move its home folder. */
	envVar: string;
	/** The home folder when the variable is unset, under the user's home. */
	defaultHome: readonly string[];
};

export const AGENTS: readonly AgentSpec[] = [
	{
		id: "claude",
		label: "Claude Code",
		envVar: "CLAUDE_CONFIG_DIR",
		defaultHome: [".claude"],
	},
	{
		id: "codex",
		label: "Codex",
		envVar: "CODEX_HOME",
		defaultHome: [".codex"],
	},
	{ id: "grok", label: "Grok", envVar: "GROK_HOME", defaultHome: [".grok"] },
	{
		id: "pi",
		label: "Pi",
		envVar: "PI_CODING_AGENT_DIR",
		defaultHome: [".pi", "agent"],
	},
];

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

export function isAgentId(value: string): value is AgentId {
	return (AGENT_IDS as readonly string[]).includes(value);
}

export type SkillOptions = {
	home: string;
	/**
	 * The environment as the CLI was started, before it pins
	 * `PI_CODING_AGENT_DIR` for the SDK: Pi's own folder comes from here.
	 */
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	/** This package's `skills/review-panel` folder and the package version. */
	source: { dir: string; version: string };
	/** `--agent`: only these, created when missing. Otherwise every agent found. */
	agents?: readonly AgentId[];
	dryRun?: boolean;
	force?: boolean;
};

export type SkillResult = { lines: string[]; ok: boolean };

function expandTilde(value: string, home: string): string {
	if (value === "~") {
		return home;
	}
	if (value.startsWith("~/")) {
		return path.join(home, value.slice(2));
	}
	return value;
}

/** The agent's home folder: its variable when set and not empty, else the default. */
export function agentHome(
	agent: AgentSpec,
	home: string,
	env: Record<string, string | undefined>,
): string {
	const fromEnv = env[agent.envVar];
	if (fromEnv !== undefined && fromEnv !== "") {
		return path.resolve(expandTilde(fromEnv, home));
	}
	return path.join(home, ...agent.defaultHome);
}

function isDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function lexists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

type TargetState =
	| { kind: "absent" }
	| { kind: "ours-link" }
	| { kind: "broken-link"; to: string }
	| { kind: "other-link"; to: string }
	| { kind: "ours-copy"; version: string }
	| { kind: "other" };

function readStamp(dir: string): string | undefined {
	try {
		const stamp = JSON.parse(
			readFileSync(path.join(dir, SKILL_STAMP_FILE), "utf8"),
		) as { package?: unknown; version?: unknown };
		return stamp.package === PACKAGE_NAME && typeof stamp.version === "string"
			? stamp.version
			: undefined;
	} catch {
		return undefined;
	}
}

function inspect(target: string, source: string): TargetState {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(target);
	} catch {
		return { kind: "absent" };
	}
	if (stats.isSymbolicLink()) {
		const to = path.resolve(path.dirname(target), readlinkSync(target));
		if (!existsSync(target)) {
			return { kind: "broken-link", to };
		}
		return samePath(target, source)
			? { kind: "ours-link" }
			: { kind: "other-link", to };
	}
	if (stats.isDirectory()) {
		const version = readStamp(target);
		if (version !== undefined) {
			return { kind: "ours-copy", version };
		}
	}
	return { kind: "other" };
}

/** Why a target is not ours, for skip and leave-alone lines. */
function notOurs(target: string, state: TargetState): string {
	switch (state.kind) {
		case "broken-link":
			return `${target} is a broken link to ${state.to}`;
		case "other-link":
			return `${target} links to ${state.to}, not this package`;
		default:
			return `${target} is a folder that is not this package's link`;
	}
}

type Planned = {
	agent: AgentSpec;
	home: string;
	skills: string;
	target: string;
	found: boolean;
};

function plan(options: SkillOptions): Planned[] {
	const chosen = options.agents;
	return AGENTS.filter(
		(agent) => chosen === undefined || chosen.includes(agent.id),
	).map((agent) => {
		const home = agentHome(agent, options.home, options.env);
		const skills = path.join(home, "skills");
		return {
			agent,
			home,
			skills,
			target: path.join(skills, SKILL_NAME),
			found: isDirectory(home),
		};
	});
}

function shellQuote(file: string): string {
	return `'${file.replaceAll("'", `'\\''`)}'`;
}

function oldSkillHints(planned: Planned[]): string[] {
	return planned.flatMap(({ found, skills }) => {
		const old = path.join(skills, OLD_SKILL_NAME);
		return found && lexists(old)
			? [
					`Hint: ${old} is the retired pi-review skill; review-panel replaces it. Remove it yourself when you are ready: rm -rf ${shellQuote(old)}`,
				]
			: [];
	});
}

function removeEntry(target: string): void {
	const stats = lstatSync(target);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		unlinkSync(target);
	} else {
		rmSync(target, { recursive: true, force: true });
	}
}

/** Links the skill (copies it with a stamp on Windows). */
function place(options: SkillOptions, target: string): void {
	if (options.platform === "win32") {
		cpSync(options.source.dir, target, { recursive: true });
		writeFileSync(
			path.join(target, SKILL_STAMP_FILE),
			`${JSON.stringify({ package: PACKAGE_NAME, version: options.source.version })}\n`,
		);
		return;
	}
	symlinkSync(options.source.dir, target, "dir");
}

function placedWord(options: SkillOptions, target: string): string {
	return options.platform === "win32"
		? `copied to ${target}`
		: `linked ${target} -> ${options.source.dir}`;
}

function checkSource(options: SkillOptions): void {
	if (!existsSync(path.join(options.source.dir, "SKILL.md"))) {
		throw new Error(
			`this package has no skill at ${options.source.dir}; reinstall pi-review-panel`,
		);
	}
}

export function installSkill(options: SkillOptions): SkillResult {
	checkSource(options);
	const planned = plan(options);
	const explicit = options.agents !== undefined;
	const lines: string[] = [];
	let ok = true;
	let acted = 0;
	const would = options.dryRun === true ? "would " : "";
	for (const entry of planned) {
		const { agent, home, skills, target } = entry;
		if (!entry.found && !explicit) {
			lines.push(`${agent.label}: not found (${home} does not exist)`);
			continue;
		}
		acted++;
		const state = inspect(target, options.source.dir);
		if (state.kind === "ours-link") {
			lines.push(`${agent.label}: already linked (${target})`);
			continue;
		}
		if (state.kind === "ours-copy" && options.platform === "win32") {
			if (options.dryRun !== true) {
				removeEntry(target);
				place(options, target);
			}
			lines.push(
				`${agent.label}: ${would}refresh${would === "" ? "ed" : ""} the copy at ${target} (${state.version} to ${options.source.version})`,
			);
			continue;
		}
		const replacing = state.kind !== "absent";
		if (replacing && state.kind !== "ours-copy" && options.force !== true) {
			ok = false;
			lines.push(
				`${agent.label}: skipped: ${notOurs(target, state)}. Re-run with --force to replace it.`,
			);
			continue;
		}
		if (options.dryRun === true) {
			lines.push(
				`${agent.label}: would ${replacing ? "replace" : options.platform === "win32" ? "copy to" : "link"} ${target}`,
			);
			continue;
		}
		mkdirSync(skills, { recursive: true });
		if (replacing) {
			removeEntry(target);
		}
		place(options, target);
		lines.push(
			replacing
				? `${agent.label}: replaced ${target} (${placedWord(options, target)})`
				: `${agent.label}: ${placedWord(options, target)}`,
		);
	}
	if (acted === 0) {
		ok = false;
		lines.push(
			`No coding agent found. Pass --agent ${AGENT_IDS.join(",")} to install anyway.`,
		);
	}
	lines.push(...oldSkillHints(planned));
	return { lines, ok };
}

export function uninstallSkill(options: SkillOptions): SkillResult {
	const planned = plan(options);
	const lines: string[] = [];
	for (const { agent, home, target, found } of planned) {
		if (!found) {
			lines.push(`${agent.label}: not found (${home} does not exist)`);
			continue;
		}
		const state = inspect(target, options.source.dir);
		if (state.kind === "absent") {
			lines.push(`${agent.label}: not installed`);
			continue;
		}
		if (state.kind !== "ours-link" && state.kind !== "ours-copy") {
			lines.push(`${agent.label}: left alone: ${notOurs(target, state)}.`);
			continue;
		}
		if (options.dryRun === true) {
			lines.push(`${agent.label}: would remove ${target}`);
			continue;
		}
		removeEntry(target);
		lines.push(`${agent.label}: removed ${target}`);
	}
	lines.push(...oldSkillHints(planned));
	return { lines, ok: true };
}

/** One `- Agent: state` row per agent, plus a row per old pi-review copy. */
export function skillStatus(options: SkillOptions): string[] {
	const rows: string[] = [];
	for (const { agent, home, skills, target, found } of plan(options)) {
		const label = `- ${agent.label}:`;
		if (!found) {
			rows.push(`${label} not found (${home} does not exist)`);
			continue;
		}
		const state = inspect(target, options.source.dir);
		switch (state.kind) {
			case "absent":
				rows.push(`${label} not installed; run review-panel skill install`);
				break;
			case "ours-link":
				rows.push(`${label} linked (${target})`);
				break;
			case "ours-copy":
				rows.push(
					state.version === options.source.version
						? `${label} copy ${state.version} (${target})`
						: `${label} stale copy ${state.version} (this is ${options.source.version}) at ${target}; run review-panel skill install`,
				);
				break;
			case "broken-link":
				rows.push(
					`${label} broken link to ${state.to} at ${target}; run review-panel skill install --force`,
				);
				break;
			case "other-link":
				rows.push(
					`${label} ${target} links to ${state.to}, not this package; run review-panel skill install --force to replace it`,
				);
				break;
			case "other":
				rows.push(
					`${label} ${target} is a folder that is not this package's; run review-panel skill install --force to replace it`,
				);
				break;
		}
		const old = path.join(skills, OLD_SKILL_NAME);
		if (lexists(old)) {
			rows.push(`${label} old pi-review skill at ${old}; remove it yourself`);
		}
	}
	return rows;
}
