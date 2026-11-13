/**
 * Turns argv into one command. Action flags map one-to-one onto the
 * `review_panel` tool's arguments (kebab-case here, camelCase there) and are
 * handed to the same `parse*Arguments` validation the tool uses. There are no
 * `--provider` or `--model` flags: seats come only from the owner config.
 */

export class UsageError extends Error {}

export const ACTIONS = [
	"diagnose",
	"review",
	"audit",
	"verify",
	"resume",
	"comment",
] as const;

export type ActionName = (typeof ACTIONS)[number];

/** Where `comment --dismissed` comes from; read by the runner, not here. */
export type DismissedSource =
	| { from: "stdin" }
	| { from: "file"; path: string }
	| { from: "text"; text: string };

export type Command =
	| { kind: "help"; topic?: string }
	| { kind: "version" }
	| {
			kind: "action";
			action: ActionName;
			/** The tool's argument record, without `action` and `repository`. */
			args: Record<string, unknown>;
			dismissed?: DismissedSource;
			repo?: string;
			json: boolean;
	  }
	| { kind: "call"; json: boolean; repo?: string; payload: string }
	| { kind: "auth-login"; provider: string; apiKey: boolean }
	| { kind: "auth-logout"; provider: string }
	| { kind: "auth-status"; repo?: string; json: boolean };

type FlagKind = "string" | "list" | "boolean";

type FlagSpec = { key: string; kind: FlagKind };

const STRING = (key: string): FlagSpec => ({ key, kind: "string" });
const LIST = (key: string): FlagSpec => ({ key, kind: "list" });
const BOOLEAN = (key: string): FlagSpec => ({ key, kind: "boolean" });

/** Flags every action takes besides its own. */
const COMMON: Record<string, FlagSpec> = {
	repo: STRING("repo"),
	json: BOOLEAN("json"),
};

/** Each action's flags, named after the tool argument they set. */
const ACTION_FLAGS: Record<ActionName, Record<string, FlagSpec>> = {
	diagnose: {},
	review: {
		base: STRING("base"),
		head: STRING("head"),
		seats: LIST("seats"),
		lenses: LIST("lenses"),
		"scoping-note": STRING("scopingNote"),
	},
	audit: {
		seats: LIST("seats"),
		passes: LIST("passes"),
		"scoping-note": STRING("scopingNote"),
	},
	verify: {
		"prior-run-id": STRING("priorRunId"),
		head: STRING("head"),
		"kept-finding-ids": LIST("keptFindingIds"),
		seats: LIST("seats"),
		"scoping-note": STRING("scopingNote"),
	},
	resume: {
		"prior-run-id": STRING("priorRunId"),
	},
	comment: {
		"prior-run-id": STRING("priorRunId"),
		"owner-approved": BOOLEAN("ownerApproved"),
		pr: STRING("pr"),
		dismissed: STRING("dismissed"),
		"low-advisory": LIST("lowAdvisory"),
		"verify-run-id": STRING("verifyRunId"),
		head: STRING("head"),
	},
};

type RawFlags = {
	values: Map<string, string | string[] | true>;
	positionals: string[];
	help: boolean;
};

/** Splits argv into `--flag value`, `--flag=value` and positionals. */
function readFlags(
	argv: readonly string[],
	specs: Record<string, FlagSpec>,
	command: string,
): RawFlags {
	const values = new Map<string, string | string[] | true>();
	const positionals: string[] = [];
	let help = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			if (arg.startsWith("-") && arg !== "-") {
				throw new UsageError(`${command}: unknown option "${arg}"`);
			}
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const spec = specs[name];
		if (spec === undefined) {
			throw new UsageError(`${command}: unknown option "--${name}"`);
		}
		if (spec.kind === "boolean") {
			if (eq !== -1) {
				throw new UsageError(`${command}: --${name} takes no value`);
			}
			values.set(name, true);
			continue;
		}
		let value: string | undefined;
		if (eq !== -1) {
			value = arg.slice(eq + 1);
		} else {
			value = argv[index + 1];
			if (value === undefined) {
				throw new UsageError(`${command}: --${name} needs a value`);
			}
			index++;
		}
		if (spec.kind === "list") {
			const previous = values.get(name);
			const list = Array.isArray(previous) ? previous : [];
			values.set(name, [...list, value]);
		} else {
			if (values.has(name)) {
				throw new UsageError(`${command}: --${name} was given more than once`);
			}
			values.set(name, value);
		}
	}
	return { values, positionals, help };
}

/** `--seats a,b --seats c` is `["a", "b", "c"]`; `--kept-finding-ids ""` is `[]`. */
function splitList(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(","))
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function parseAction(action: ActionName, argv: readonly string[]): Command {
	const specs = { ...COMMON, ...ACTION_FLAGS[action] };
	const flags = readFlags(argv, specs, action);
	if (flags.help) {
		return { kind: "help", topic: action };
	}
	if (flags.positionals.length > 0) {
		throw new UsageError(
			`${action}: unexpected argument "${flags.positionals[0]}"`,
		);
	}
	const args: Record<string, unknown> = {};
	let dismissed: DismissedSource | undefined;
	for (const [name, value] of flags.values) {
		if (name === "repo" || name === "json") {
			continue;
		}
		const spec = specs[name] as FlagSpec;
		if (name === "dismissed") {
			const text = value as string;
			dismissed =
				text === "-"
					? { from: "stdin" }
					: text.startsWith("@")
						? { from: "file", path: text.slice(1) }
						: { from: "text", text };
			continue;
		}
		if (name === "pr") {
			const text = value as string;
			args.pr = /^\d+$/.test(text) ? Number(text) : text;
			continue;
		}
		args[spec.key] =
			spec.kind === "list" ? splitList(value as string[]) : value;
	}
	const repo = flags.values.get("repo");
	return {
		kind: "action",
		action,
		args,
		...(dismissed === undefined ? {} : { dismissed }),
		...(typeof repo === "string" ? { repo } : {}),
		json: flags.values.get("json") === true,
	};
}

function parseCall(argv: readonly string[]): Command {
	const flags = readFlags(argv, COMMON, "call");
	if (flags.help) {
		return { kind: "help", topic: "call" };
	}
	if (flags.positionals.length !== 1) {
		throw new UsageError(
			"call takes exactly one argument: the tool's JSON object, or - to read it from stdin",
		);
	}
	const repo = flags.values.get("repo");
	return {
		kind: "call",
		payload: flags.positionals[0] as string,
		...(typeof repo === "string" ? { repo } : {}),
		json: flags.values.get("json") === true,
	};
}

function parseAuth(argv: readonly string[]): Command {
	const [sub, ...rest] = argv;
	if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
		return { kind: "help", topic: "auth" };
	}
	if (sub === "login") {
		const flags = readFlags(
			rest,
			{ "api-key": BOOLEAN("apiKey") },
			"auth login",
		);
		if (flags.help) {
			return { kind: "help", topic: "auth" };
		}
		if (flags.positionals.length !== 1) {
			throw new UsageError(
				"auth login takes one provider id, for example: review-panel auth login anthropic",
			);
		}
		return {
			kind: "auth-login",
			provider: flags.positionals[0] as string,
			apiKey: flags.values.get("api-key") === true,
		};
	}
	if (sub === "logout") {
		const flags = readFlags(rest, {}, "auth logout");
		if (flags.help) {
			return { kind: "help", topic: "auth" };
		}
		if (flags.positionals.length !== 1) {
			throw new UsageError("auth logout takes one provider id");
		}
		return { kind: "auth-logout", provider: flags.positionals[0] as string };
	}
	if (sub === "status") {
		const flags = readFlags(rest, COMMON, "auth status");
		if (flags.help) {
			return { kind: "help", topic: "auth" };
		}
		if (flags.positionals.length > 0) {
			throw new UsageError(
				`auth status: unexpected argument "${flags.positionals[0]}"`,
			);
		}
		const repo = flags.values.get("repo");
		return {
			kind: "auth-status",
			...(typeof repo === "string" ? { repo } : {}),
			json: flags.values.get("json") === true,
		};
	}
	throw new UsageError(
		`auth: unknown command "${sub}"; use login, logout or status`,
	);
}

export function parseCommand(argv: readonly string[]): Command {
	const [first, ...rest] = argv;
	if (
		first === undefined ||
		first === "--help" ||
		first === "-h" ||
		first === "help"
	) {
		return {
			kind: "help",
			...(rest[0] === undefined ? {} : { topic: rest[0] }),
		};
	}
	if (first === "--version" || first === "-v" || first === "version") {
		return { kind: "version" };
	}
	if ((ACTIONS as readonly string[]).includes(first)) {
		return parseAction(first as ActionName, rest);
	}
	if (first === "call") {
		return parseCall(rest);
	}
	if (first === "auth") {
		return parseAuth(rest);
	}
	throw new UsageError(`unknown command "${first}"`);
}

export const HELP = `review-panel: run the multi-model review panel from a terminal.

Usage: review-panel <command> [options]

Actions (the same as the review_panel tool's):
  diagnose                     Check the owner config, every seat's model and login, and the record key
  review                       Review base...head: --base <ref> --head <ref> [--seats a,b] [--lenses x,y] [--scoping-note <text>]
  audit                        Advisory whole-repository sweep of HEAD: [--seats a,b] [--passes p,q] [--scoping-note <text>]
  verify                       Check fixes against a prior run: --prior-run-id <run> --head <ref> --kept-finding-ids F-1,F-2 [--seats a,b] [--scoping-note <text>]
  resume                       Run the unfinished seats of an interrupted run again: --prior-run-id <run>
  comment                      Post the close-out PR comment, after the owner said yes: --prior-run-id <run> --owner-approved
                               [--pr <n>] [--verify-run-id <run>] [--head <ref>] [--low-advisory F-3,F-4]
                               [--dismissed <json> | --dismissed @<file> | --dismissed -]
  call '<json>'                Run the tool's own argument object, e.g. '{"action":"diagnose"}' (- reads it from stdin)

Logins (stored in the agent folder in use; see diagnose):
  auth login <provider>        Sign in with the provider's account (OAuth, including subscriptions)
  auth login <provider> --api-key
                               Save an API key, read from stdin or a hidden prompt (never from the command line)
  auth logout <provider>       Remove the stored credential
  auth status                  Show login status for each provider in the owner config's roster

Options for actions, call and auth status:
  --repo <path>                The repository (default: the Git top-level of the current folder)
  --json                       Print the result object as JSON

Other:
  --help, -h                   Show this help (also: review-panel <command> --help)
  --version, -v                Show the CLI version

Seats come only from the owner config (~/.pi-review-panel/config.json, or PI_REVIEW_PANEL_CONFIG).
The report goes to stdout, progress to stderr. Exit codes: 0 the command completed (whatever the
report says), 1 refused or failed, 2 usage error. No exit code reports findings.`;
