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
 * package's stamped copy) is replaced only with `--force`, which needs `--agent`, and uninstall
 * removes only this package's own link or copy. Old `pi-review` skills are
 * named, never deleted.
 */
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
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

/**
 * The agent's home folder: its variable when set and not empty, else the
 * default. A relative value is refused: the agent would resolve it against its
 * own working folder, which this command cannot know.
 */
export function agentHome(
	agent: AgentSpec,
	home: string,
	env: Record<string, string | undefined>,
): string {
	const fromEnv = env[agent.envVar];
	if (fromEnv !== undefined && fromEnv !== "") {
		const expanded = expandTilde(fromEnv, home);
		if (!path.isAbsolute(expanded)) {
			throw new Error(
				`${agent.envVar} is a relative path (${JSON.stringify(fromEnv)}); set it to an absolute path`,
			);
		}
		return path.normalize(expanded);
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
	/** A link (live or broken) into another pi-review-panel install's skill. */
	| { kind: "earlier-link"; to: string }
	| { kind: "ours-copy"; version: string }
	/**
	 * An exact copy of a host-skills/review-panel/SKILL.md this repository
	 * shipped before the one skill (never in a release): one SKILL.md, nothing else.
	 */
	| { kind: "old-host-copy" }
	| { kind: "other" };

/**
 * A link into `.../pi-review-panel/skills/review-panel`: an install of this
 * package under another prefix or Node version (nvm, a new npm prefix, the
 * npx cache), so it is replaced and removed like our own link.
 */
function isEarlierInstall(to: string): boolean {
	const parts = path.resolve(to).split(path.sep).filter(Boolean);
	return parts.slice(-3).join("/") === `${PACKAGE_NAME}/skills/${SKILL_NAME}`;
}

/**
 * The sha256 of every version ever committed at
 * host-skills/review-panel/SKILL.md (`git log -- host-skills/review-panel/SKILL.md`,
 * eight blobs, 0ec3ca3 to 1cfd865). A folder counts as that old copy only when
 * its SKILL.md is byte for byte one of these; an edited copy is the user's.
 */
const OLD_HOST_SKILL_SHA256 = new Set([
	"880c4a5d79cfaa39c692d1c3c64de6e853ee3dd4a4d8d8447c17d139b652772f",
	"47783f9acf46ed4f8ba9ea2813594f47e861c5893a560e672b7d9551189b96ac",
	"3f616f94afb18e11abadd96b2ca6de96624e8d48fa3b7f9e66883976908c0963",
	"13691acfe7cdb85d78c43008490de2013f10c2a7b4e6995fdd65b30e739d8c8f",
	"035a812c0fdca70e8178c2aa71e242a309984ab1eeadf1a5374c864adac7a47d",
	"0d7b5a5e93d5d07bd86b70ceaa4bb1313070ff2cc0f613338f4328018661b4ad",
	"64a4b3d20cd0201979207acf382860e196299babe81da0585f13234cc85d2e44",
	"957cca0db3e46eae2b7f6ba469a2f8784b062e300afb9e2e00cf7909be46389a",
]);

/** A folder holding only a SKILL.md whose bytes are a shipped host skill. */
function isOldHostCopy(dir: string): boolean {
	try {
		if (readdirSync(dir).join("/") !== "SKILL.md") {
			return false;
		}
		const file = path.join(dir, "SKILL.md");
		if (!lstatSync(file).isFile()) {
			return false;
		}
		const digest = createHash("sha256")
			.update(readFileSync(file))
			.digest("hex");
		return OLD_HOST_SKILL_SHA256.has(digest);
	} catch {
		return false;
	}
}

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
		const live = existsSync(target);
		if (live && samePath(target, source)) {
			return { kind: "ours-link" };
		}
		if (isEarlierInstall(to)) {
			return { kind: "earlier-link", to };
		}
		return live ? { kind: "other-link", to } : { kind: "broken-link", to };
	}
	if (stats.isDirectory()) {
		const version = readStamp(target);
		if (version !== undefined) {
			return { kind: "ours-copy", version };
		}
		if (isOldHostCopy(target)) {
			return { kind: "old-host-copy" };
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

/** An agent whose folder variable cannot be used: the reason. */
type Unusable = { agent: AgentSpec; problem: string };

function plan(options: SkillOptions): Array<Planned | Unusable> {
	const chosen = options.agents;
	return AGENTS.filter(
		(agent) => chosen === undefined || chosen.includes(agent.id),
	).map((agent) => {
		let home: string;
		try {
			home = agentHome(agent, options.home, options.env);
		} catch (error) {
			return { agent, problem: (error as Error).message };
		}
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

function isUnusable(entry: Planned | Unusable): entry is Unusable {
	return "problem" in entry;
}

function usable(entries: Array<Planned | Unusable>): Planned[] {
	return entries.filter((entry): entry is Planned => !isUnusable(entry));
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
	if (options.force === true && options.agents === undefined) {
		// --force can delete a real folder: it applies only to agents named.
		throw new Error(
			"--force needs --agent, so it replaces only the agents you name",
		);
	}
	const planned = plan(options);
	const explicit = options.agents !== undefined;
	const lines: string[] = [];
	let ok = true;
	let acted = 0;
	const would = options.dryRun === true ? "would " : "";
	for (const entry of planned) {
		if (isUnusable(entry)) {
			acted++;
			ok = false;
			lines.push(`${entry.agent.label}: skipped: ${entry.problem}`);
			continue;
		}
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
		const replaceable =
			state.kind === "ours-copy" ||
			state.kind === "earlier-link" ||
			state.kind === "old-host-copy";
		if (replacing && !replaceable && options.force !== true) {
			ok = false;
			lines.push(
				`${agent.label}: skipped: ${notOurs(target, state)}. Re-run with --agent ${agent.id} --force to replace it.`,
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
			state.kind === "earlier-link"
				? `${agent.label}: replaced the link to an earlier pi-review-panel install (${state.to}): ${placedWord(options, target)}`
				: state.kind === "old-host-copy"
					? `${agent.label}: replaced the old review-panel host-skill copy: ${placedWord(options, target)}`
					: replacing
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
	lines.push(...oldSkillHints(usable(planned)));
	return { lines, ok };
}

export function uninstallSkill(options: SkillOptions): SkillResult {
	const planned = plan(options);
	const lines: string[] = [];
	let ok = true;
	for (const entry of planned) {
		if (isUnusable(entry)) {
			ok = false;
			lines.push(`${entry.agent.label}: skipped: ${entry.problem}`);
			continue;
		}
		const { agent, home, target, found } = entry;
		if (!found) {
			lines.push(`${agent.label}: not found (${home} does not exist)`);
			continue;
		}
		const state = inspect(target, options.source.dir);
		if (state.kind === "absent") {
			lines.push(`${agent.label}: not installed`);
			continue;
		}
		if (state.kind === "old-host-copy") {
			lines.push(
				`${agent.label}: left alone: ${target} is the old review-panel host-skill copy; review-panel skill install replaces it.`,
			);
			continue;
		}
		if (
			state.kind !== "ours-link" &&
			state.kind !== "ours-copy" &&
			state.kind !== "earlier-link"
		) {
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
	lines.push(...oldSkillHints(usable(planned)));
	return { lines, ok };
}

/** One `- Agent: state` row per agent, plus a row per old pi-review copy. */
export function skillStatus(options: SkillOptions): string[] {
	const rows: string[] = [];
	for (const entry of plan(options)) {
		if (isUnusable(entry)) {
			rows.push(`- ${entry.agent.label}: ${entry.problem}`);
			continue;
		}
		const { agent, home, skills, target, found } = entry;
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
			case "earlier-link":
				rows.push(
					`${label} ${target} links to an earlier pi-review-panel install (${state.to}); run review-panel skill install`,
				);
				break;
			case "old-host-copy":
				rows.push(
					`${label} ${target} is the old review-panel host-skill copy; run review-panel skill install to replace it`,
				);
				break;
			case "broken-link":
				rows.push(
					`${label} broken link to ${state.to} at ${target}; run review-panel skill install --agent ${agent.id} --force`,
				);
				break;
			case "other-link":
				rows.push(
					`${label} ${target} links to ${state.to}, not this package; run review-panel skill install --agent ${agent.id} --force to replace it`,
				);
				break;
			case "other":
				rows.push(
					`${label} ${target} is a folder that is not this package's; run review-panel skill install --agent ${agent.id} --force to replace it`,
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
