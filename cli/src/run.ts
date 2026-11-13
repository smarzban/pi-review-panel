/**
 * Runs one parsed command and returns the process exit code. Exit codes never
 * encode review content: 0 the command completed (whatever its report says),
 * 1 a refusal or an operational failure, 2 a usage error.
 */
import path from "node:path";

import {
	type ActionContext,
	type ActionResult,
	auditAction,
	coerceJsonValue,
	coerceStringList,
	commentAction,
	diagnoseAction,
	parseAuditArguments,
	parseCommentArguments,
	parseDiagnoseArguments,
	parseResumeArguments,
	parseReviewArguments,
	parseSuggestArguments,
	parseVerifyArguments,
	resumeAction,
	reviewAction,
	suggestAction,
	verifyAction,
} from "../../src/actions/actions.js";
import {
	canonicalizeRepository,
	resolveReviewRepository,
} from "../../src/actions/repository.js";
import { loadConfig } from "../../src/config/load.js";
import { renderReviewProgress } from "../../src/tool/review-presentation.js";
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

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** A refusal that is not a usage mistake, such as comment without approval. */
export class RefusalError extends Error {}

export type ActionFunctions = {
	diagnose: typeof diagnoseAction;
	review: typeof reviewAction;
	audit: typeof auditAction;
	verify: typeof verifyAction;
	resume: typeof resumeAction;
	comment: typeof commentAction;
	suggest: typeof suggestAction;
};

export const realActions: ActionFunctions = {
	diagnose: diagnoseAction,
	review: reviewAction,
	audit: auditAction,
	verify: verifyAction,
	resume: resumeAction,
	comment: commentAction,
	suggest: suggestAction,
};

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
	loadConfig?: typeof loadConfig;
};

const PARSERS: Record<
	ActionName,
	(args: Record<string, unknown>) => Record<string, unknown>
> = {
	diagnose: parseDiagnoseArguments,
	review: parseReviewArguments,
	audit: parseAuditArguments,
	verify: parseVerifyArguments,
	resume: parseResumeArguments,
	comment: parseCommentArguments,
	suggest: parseSuggestArguments,
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `--repo` is taken strictly: a path that is not a Git repository is refused.
 * Without it, the Git top-level of the working folder is used. A `call`
 * object's `repository` is resolved exactly as the tool resolves it.
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

/** Validates the tool's argument record and runs one action. */
async function runAction(
	action: ActionName,
	args: Record<string, unknown>,
	repoDir: string,
	io: RunIo,
	deps: RunDeps,
	json: boolean,
): Promise<number> {
	if (action === "comment" && args.ownerApproved !== true) {
		throw new RefusalError(
			"comment refused: pass --owner-approved (ownerApproved: true) only after the owner asked to post",
		);
	}
	let input: Record<string, unknown>;
	try {
		input = PARSERS[action](args);
	} catch (error) {
		// A `call` object's unknown argument name may be a key pasted there.
		throw new UsageError(
			withoutKeyLikeNames(message(error), Object.keys(args)),
		);
	}
	const context: ActionContext = {
		signal: io.signal,
		startedAt: Date.now(),
		onProgress: (view) => io.stderr(`${renderReviewProgress(view)}\n`),
	};
	const run = deps.actions[action] as (
		input: Record<string, unknown>,
		context: ActionContext,
	) => Promise<ActionResult>;
	let result = await run({ repoDir, ...input }, context);
	if (io.signal.aborted) {
		// A run that still returned after Ctrl-C is printed, but did not
		// complete as asked.
		io.stdout(render(result, json));
		throw new Error("interrupted before the action finished");
	}
	if (action === "diagnose") {
		const header = [
			`review-panel ${deps.cliVersion} (Pi SDK ${await deps.sdkVersion()})`,
			`Agent folder: ${describeAgentDir(deps.agentDir)}`,
		].join("\n");
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
	return coerceLikeTheTool(value as Record<string, unknown>);
}

/**
 * The tool's `prepareArguments` coercions, so `call` accepts what the tool
 * accepts: a string for a list, JSON text for `dismissed`, and
 * `"ownerApproved": "true"`.
 */
function coerceLikeTheTool(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...args };
	for (const key of [
		"seats",
		"lenses",
		"passes",
		"keptFindingIds",
		"lowAdvisory",
	]) {
		if (Object.hasOwn(next, key)) {
			next[key] = coerceStringList(next[key]);
		}
	}
	if (typeof next.dismissed === "string") {
		next.dismissed = coerceJsonValue(next.dismissed);
	}
	if (next.ownerApproved === "true") {
		next.ownerApproved = true;
	}
	return next;
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
			const repoDir = resolveRepo(io, command.repo);
			return runAction(command.action, args, repoDir, io, deps, command.json);
		}
		case "call": {
			const args = parseCallPayload(
				command.payload === "-"
					? await io.readStdin(io.signal)
					: command.payload,
			);
			const action = args.action;
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
			const repoDir =
				command.repo === undefined
					? resolveReviewRepository(args.repository, io.cwd)
					: resolveRepo(io, command.repo);
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
			error instanceof RefusalError || error instanceof AuthError
				? ""
				: "failed: ";
		io.stderr(`review-panel: ${prefix}${message(error)}\n`);
		return EXIT_FAILED;
	}
}
