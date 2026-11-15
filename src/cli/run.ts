/**
 * Runs one parsed command and returns the process exit code. Exit codes never
 * encode review content: 0 the command completed (whatever its report says),
 * 1 a refusal or an operational failure, 2 a usage error.
 */
import path from "node:path";

import type { ActionContext, ActionResult } from "../actions/actions.js";
import {
	type ActionFunctions,
	AUDIT_REMOVED,
	CallArgumentError,
	CallRepositoryError,
	callAction,
	coerceCallArguments,
} from "../actions/call.js";
import {
	canonicalizeRepository,
	resolveReviewRepository,
} from "../actions/repository.js";
import { loadConfig } from "../config/load.js";
import { renderReviewProgress } from "../tool/review-presentation.js";
import { type AgentDirChoice, describeAgentDir } from "./agent-dir.js";
import {
	ACTIONS,
	type ActionName,
	type Command,
	type DismissedSource,
	HELP,
	parseCommand,
	UsageError,
	withoutKeyLikeNames,
} from "./args.js";
import {
	AuthError,
	type AuthSdk,
	type AuthTerminal,
	login,
	logout,
	renderStatus,
	status,
} from "./auth.js";
import {
	installExtension,
	listExtensions,
	listModels,
	listProviders,
	removeExtension,
	renderExtensions,
	renderModels,
	renderProviders,
	SetupError,
	type SetupSdk,
} from "./setup.js";
import {
	installSkill,
	type SkillOptions,
	skillStatus,
	uninstallSkill,
} from "./skill.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** A refusal that is not a usage mistake, such as comment without approval. */
export class RefusalError extends Error {}

export { type ActionFunctions, realActions } from "../actions/call.js";

export type RunIo = {
	cwd: string;
	env: Record<string, string | undefined>;
	home: string;
	stdout(text: string): void;
	stderr(text: string): void;
	/** All of stdin; rejects when the signal aborts first. */
	readStdin(signal: AbortSignal): Promise<string>;
	readFile(file: string): string;
	signal: AbortSignal;
	terminal: AuthTerminal;
};

export type RunDeps = {
	agentDir: AgentDirChoice;
	cliVersion: string;
	sdkVersion(): Promise<string>;
	actions: ActionFunctions;
	authSdk: AuthSdk;
	setupSdk: SetupSdk;
	/** The bound on loading one extension group in `models` (default 30 s). */
	extensionTimeoutMs?: number;
	loadConfig?: typeof loadConfig;
	/** This package's `skills/review-panel`, its version, and the platform. */
	skillSource: { dir: string; version: string; platform: NodeJS.Platform };
};

function skillOptions(io: RunIo, deps: RunDeps): SkillOptions {
	return {
		home: io.home,
		env: io.env,
		platform: deps.skillSource.platform,
		source: { dir: deps.skillSource.dir, version: deps.skillSource.version },
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `--repo` is taken strictly: a path that is not a Git repository is refused.
 * Without it, the Git top-level of the working folder is used. A `call`
 * object's `repository` may be omitted or a placeholder: the working folder's
 * Git top-level is used then.
 */
function resolveRepo(io: RunIo, flag: string | undefined): string {
	return flag === undefined
		? resolveReviewRepository(undefined, io.cwd)
		: canonicalizeRepository(path.resolve(io.cwd, flag));
}

function render(result: ActionResult, json: boolean): string {
	if (json) {
		return `${JSON.stringify(result, null, 2)}\n`;
	}
	return `${result.content.map((part) => part.text).join("\n\n")}\n`;
}

async function dismissedText(
	source: DismissedSource,
	io: RunIo,
): Promise<string> {
	switch (source.from) {
		case "stdin":
			return io.readStdin(io.signal);
		case "file":
			try {
				return io.readFile(path.resolve(io.cwd, source.path));
			} catch (error) {
				throw new UsageError(
					`--dismissed: cannot read "${source.path}": ${message(error)}`,
				);
			}
		case "text":
			return source.text;
	}
}

/** What diagnose prints before the readiness report: this install's own state. */
async function diagnoseHeader(io: RunIo, deps: RunDeps): Promise<string> {
	return [
		`review-panel ${deps.cliVersion} (Pi SDK ${await deps.sdkVersion()})`,
		`Agent folder: ${describeAgentDir(deps.agentDir)}`,
		"Skill (review-panel skill install links it into each agent):",
		...skillStatus(skillOptions(io, deps)),
	].join("\n");
}

/**
 * Finds the `--repo` repository. When diagnose cannot (not a Git repository),
 * it still prints the install's own state first, then fails as before.
 */
async function repositoryFor(
	action: string,
	find: () => string,
	io: RunIo,
	deps: RunDeps,
	json: boolean,
): Promise<string> {
	try {
		return find();
	} catch (error) {
		if (action === "diagnose") {
			await printDiagnoseHeader(io, deps, json);
		}
		throw error;
	}
}

async function printDiagnoseHeader(
	io: RunIo,
	deps: RunDeps,
	json: boolean,
): Promise<void> {
	io.stdout(
		render(
			{ content: [{ type: "text", text: await diagnoseHeader(io, deps) }] },
			json,
		),
	);
}

/**
 * Validates one argument record and runs its action through `callAction`.
 * `repoDir` is the `--repo` repository when given; otherwise `callAction`
 * finds it from the record's `repository` or the working folder.
 */
async function runAction(
	action: ActionName,
	args: Record<string, unknown>,
	repoDir: string | undefined,
	io: RunIo,
	deps: RunDeps,
	json: boolean,
): Promise<number> {
	if (action === "comment" && args.ownerApproved !== true) {
		throw new RefusalError(
			"comment refused: pass --owner-approved (ownerApproved: true) only after the owner asked to post",
		);
	}
	const context: ActionContext = {
		signal: io.signal,
		startedAt: Date.now(),
		onProgress: (view) => io.stderr(`${renderReviewProgress(view)}\n`),
	};
	let result: ActionResult;
	try {
		result = await callAction(
			{ ...args, action },
			{
				cwd: io.cwd,
				...(repoDir === undefined ? {} : { repoDir }),
				context,
				actions: deps.actions,
			},
		);
	} catch (error) {
		if (error instanceof CallArgumentError) {
			// A `call` object's unknown argument name may be a key pasted there.
			throw new UsageError(
				withoutKeyLikeNames(message(error), Object.keys(args)),
			);
		}
		if (error instanceof CallRepositoryError && action === "diagnose") {
			await printDiagnoseHeader(io, deps, json);
		}
		throw error;
	}
	if (io.signal.aborted) {
		// A run that still returned after Ctrl-C is printed, but did not
		// complete as asked.
		io.stdout(render(result, json));
		throw new Error("interrupted before the action finished");
	}
	if (action === "diagnose") {
		const header = await diagnoseHeader(io, deps);
		result = { content: [{ type: "text", text: header }, ...result.content] };
	}
	io.stdout(render(result, json));
	return EXIT_OK;
}

function parseCallPayload(text: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		// JSON.parse quotes the text it read; keep only where it failed, so a
		// key passed here by mistake is not echoed.
		const where = /at position \d+/.exec(message(error))?.[0];
		throw new UsageError(
			`call: the argument is not JSON${where === undefined ? "" : ` (${where})`}`,
		);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new UsageError("call: the argument must be a JSON object");
	}
	return coerceCallArguments(value as Record<string, unknown>);
}

async function execute(
	command: Command,
	io: RunIo,
	deps: RunDeps,
): Promise<number> {
	switch (command.kind) {
		case "help":
			io.stdout(`${HELP}\n`);
			return EXIT_OK;
		case "version":
			io.stdout(`${deps.cliVersion}\n`);
			return EXIT_OK;
		case "action": {
			const args = { ...command.args };
			if (command.dismissed !== undefined) {
				args.dismissed = await dismissedText(command.dismissed, io);
			}
			const repo = command.repo;
			const repoDir =
				repo === undefined
					? undefined
					: await repositoryFor(
							command.action,
							() => resolveRepo(io, repo),
							io,
							deps,
							command.json,
						);
			return runAction(command.action, args, repoDir, io, deps, command.json);
		}
		case "call": {
			const args = parseCallPayload(
				command.payload === "-"
					? await io.readStdin(io.signal)
					: command.payload,
			);
			const action = args.action;
			if (action === "audit") {
				throw new UsageError(`call: ${AUDIT_REMOVED}`);
			}
			if (
				typeof action !== "string" ||
				!(ACTIONS as readonly string[]).includes(action)
			) {
				throw new UsageError(
					`call: "action" must be one of ${ACTIONS.join(", ")}`,
				);
			}
			if (command.repo !== undefined && args.repository !== undefined) {
				throw new UsageError(
					'call: give the repository either as --repo or as "repository", not both',
				);
			}
			const repo = command.repo;
			const repoDir =
				repo === undefined
					? undefined
					: await repositoryFor(
							action,
							() => resolveRepo(io, repo),
							io,
							deps,
							command.json,
						);
			return runAction(
				action as ActionName,
				args,
				repoDir,
				io,
				deps,
				command.json,
			);
		}
		case "auth-login":
			io.stdout(
				`${await login({
					provider: command.provider,
					apiKey: command.apiKey,
					agentDir: deps.agentDir.dir,
					cwd: io.cwd,
					sdk: deps.authSdk,
					terminal: io.terminal,
					signal: io.signal,
				})}\n`,
			);
			return EXIT_OK;
		case "auth-logout":
			io.stdout(
				`${await logout({
					provider: command.provider,
					agentDir: deps.agentDir.dir,
					sdk: deps.authSdk,
					signal: io.signal,
				})}\n`,
			);
			return EXIT_OK;
		case "skill-install":
		case "skill-uninstall": {
			const options: SkillOptions = {
				...skillOptions(io, deps),
				...(command.agents === undefined ? {} : { agents: command.agents }),
				dryRun: command.dryRun,
				...(command.kind === "skill-install" ? { force: command.force } : {}),
			};
			const result =
				command.kind === "skill-install"
					? installSkill(options)
					: uninstallSkill(options);
			io.stdout(`${result.lines.join("\n")}\n`);
			return result.ok ? EXIT_OK : EXIT_FAILED;
		}
		case "auth-status": {
			const repoDir = resolveRepo(io, command.repo);
			const config = (deps.loadConfig ?? loadConfig)({
				env: io.env,
				home: io.home,
				repoDir,
			});
			const result = await status({
				repoDir,
				agentDir: deps.agentDir.dir,
				roster: config.roster,
				sdk: deps.authSdk,
			});
			io.stdout(
				command.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${renderStatus(result)}\n`,
			);
			return EXIT_OK;
		}
		case "auth-providers": {
			const result = await listProviders({
				agentDir: deps.agentDir,
				sdk: deps.setupSdk,
			});
			io.stdout(
				command.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${renderProviders(result, deps.agentDir)}\n`,
			);
			return EXIT_OK;
		}
		case "models": {
			const result = await listModels({
				agentDir: deps.agentDir,
				cwd: io.cwd,
				...(command.provider === undefined
					? {}
					: { provider: command.provider }),
				...(command.search === undefined ? {} : { search: command.search }),
				all: command.all,
				extensions: command.extensions,
				sdk: deps.setupSdk,
				...(deps.extensionTimeoutMs === undefined
					? {}
					: { timeoutMs: deps.extensionTimeoutMs }),
			});
			io.stdout(
				command.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${renderModels(result, deps.agentDir)}\n`,
			);
			return EXIT_OK;
		}
		case "extension-install":
		case "extension-remove": {
			const input = {
				agentDir: deps.agentDir,
				home: io.home,
				cwd: io.cwd,
				source: command.source,
				sdk: deps.setupSdk,
				progress: (line: string) => io.stderr(`${line}\n`),
			};
			io.stdout(
				`${
					command.kind === "extension-install"
						? await installExtension(input)
						: await removeExtension(input)
				}\n`,
			);
			return EXIT_OK;
		}
		case "extension-list": {
			const result = await listExtensions({
				agentDir: deps.agentDir,
				sdk: deps.setupSdk,
			});
			io.stdout(
				command.json
					? `${JSON.stringify(result, null, 2)}\n`
					: `${renderExtensions(result, deps.agentDir)}\n`,
			);
			return EXIT_OK;
		}
	}
}

export async function run(
	argv: readonly string[],
	io: RunIo,
	deps: RunDeps,
): Promise<number> {
	try {
		return await execute(parseCommand(argv), io, deps);
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(
				`review-panel: ${error.message}\nRun "review-panel --help" for usage.\n`,
			);
			return EXIT_USAGE;
		}
		if (io.signal.aborted) {
			io.stderr(`review-panel: aborted (${message(error)})\n`);
			return EXIT_FAILED;
		}
		const prefix =
			error instanceof RefusalError ||
			error instanceof AuthError ||
			error instanceof SetupError
				? ""
				: "failed: ";
		io.stderr(`review-panel: ${prefix}${message(error)}\n`);
		return EXIT_FAILED;
	}
}
