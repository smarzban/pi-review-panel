/**
 * `auth login | logout | status` against the agent folder in use. Credentials
 * live in that folder's `auth.json`; nothing is ever copied between folders.
 * Login goes through `ModelRuntime.login` with a terminal `AuthInteraction`,
 * the same call Pi's own `pi auth login` makes.
 */
import { shown } from "./args.js";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "./sdk-types.js";

/** The slice of `ModelRuntime` the auth commands use. */
export type LoginRuntime = {
	getProviders(): readonly {
		id: string;
		name: string;
		auth: { oauth?: unknown; apiKey?: { login?: unknown } };
	}[];
	login(
		providerId: string,
		type: "api_key" | "oauth",
		interaction: AuthInteraction,
		options?: { getDeviceId?: () => string },
	): Promise<unknown>;
	logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
	listCredentials(options?: {
		signal?: AbortSignal;
	}): Promise<readonly { providerId: string; type: string }[]>;
	settleCredentialWrites(): Promise<void>;
};

/** What `auth status` learns about one roster provider. */
export type ProviderAuthState = {
	authenticated: boolean;
	/** From `checkAuth`: how the provider is configured, when it says. */
	check?: { type: string; source?: string };
	error?: string;
	extensionFailures: { extension: string; message: string }[];
};

export type StatusRow = {
	provider: string;
	model: string;
	extensionPaths: readonly string[];
	seats: string[];
};

export type AuthSdk = {
	createRuntime(agentDir: string): Promise<LoginRuntime>;
	deviceId(agentDir: string, cwd: string): string;
	inspect(input: {
		repoDir: string;
		agentDir: string;
		provider: string;
		model: string;
		extensionPaths: readonly string[];
	}): Promise<ProviderAuthState>;
};

/** The terminal the login talks through: stderr for text, stdin for answers. */
export type AuthTerminal = {
	interactive: boolean;
	write(line: string): void;
	question(message: string, signal: AbortSignal): Promise<string>;
	secret(message: string, signal: AbortSignal): Promise<string>;
	/** All of stdin, when it is not a terminal; rejects when the signal aborts. */
	readStdin(signal: AbortSignal): Promise<string>;
};

export class AuthError extends Error {}

function chooseOption(
	prompt: Extract<AuthPrompt, { type: "select" }>,
	terminal: AuthTerminal,
	signal: AbortSignal,
): Promise<string> {
	terminal.write(prompt.message);
	prompt.options.forEach((option, index) => {
		terminal.write(
			`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
		);
	});
	const ask = async (): Promise<string> => {
		const answer = (
			await terminal.question(`Select 1-${prompt.options.length}: `, signal)
		).trim();
		const option = /^\d+$/.test(answer)
			? prompt.options[Number(answer) - 1]
			: undefined;
		if (option !== undefined) {
			return option.id;
		}
		terminal.write(`Enter a number from 1 to ${prompt.options.length}.`);
		return ask();
	};
	return ask();
}

function promptSignal(prompt: AuthPrompt, signal: AbortSignal): AbortSignal {
	return prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
}

function notify(event: AuthEvent, terminal: AuthTerminal): void {
	switch (event.type) {
		case "auth_url":
			terminal.write(`Open this URL to sign in:\n  ${event.url}`);
			if (event.instructions) {
				terminal.write(event.instructions);
			}
			return;
		case "device_code":
			terminal.write(
				`Open ${event.verificationUri} and enter code: ${event.userCode}`,
			);
			terminal.write("Waiting for authentication...");
			return;
		case "info":
			terminal.write(event.message);
			for (const link of event.links ?? []) {
				terminal.write(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
			}
			return;
		case "progress":
			terminal.write(event.message);
			return;
	}
}

/** The interactive sign-in: every prompt goes to the terminal. */
export function terminalInteraction(
	terminal: AuthTerminal,
	signal: AbortSignal,
): AuthInteraction {
	return {
		signal,
		prompt(prompt) {
			const scoped = promptSignal(prompt, signal);
			if (prompt.type === "select") {
				return chooseOption(prompt, terminal, scoped);
			}
			const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
			const message = `${prompt.message}${placeholder}: `;
			return prompt.type === "secret"
				? terminal.secret(message, scoped)
				: terminal.question(message, scoped);
		},
		notify(event) {
			notify(event, terminal);
		},
	};
}

/**
 * The API key login: the provider's one secret prompt is answered with the
 * key from stdin (or a hidden prompt). Any other prompt needs a terminal.
 */
export function apiKeyInteraction(
	key: string,
	terminal: AuthTerminal,
	signal: AbortSignal,
): AuthInteraction {
	const interactive = terminalInteraction(terminal, signal);
	let used = false;
	return {
		signal,
		prompt(prompt) {
			if (prompt.type === "secret" && !used) {
				used = true;
				return Promise.resolve(key);
			}
			if (!terminal.interactive) {
				return Promise.reject(
					new AuthError(
						`The provider also asks "${prompt.message}", which needs an interactive terminal`,
					),
				);
			}
			return interactive.prompt(prompt);
		},
		notify: interactive.notify,
	};
}

async function readApiKey(
	terminal: AuthTerminal,
	providerName: string,
	signal: AbortSignal,
): Promise<string> {
	const raw = terminal.interactive
		? await terminal.secret(`Enter ${providerName} API key: `, signal)
		: await terminal.readStdin(signal);
	const key = raw.trim();
	if (key === "") {
		throw new AuthError(
			terminal.interactive
				? "No API key entered"
				: "No API key on stdin. Pipe it in, for example: review-panel auth login <provider> --api-key < key-file",
		);
	}
	return key;
}

export type LoginInput = {
	provider: string;
	apiKey: boolean;
	agentDir: string;
	cwd: string;
	sdk: AuthSdk;
	terminal: AuthTerminal;
	signal: AbortSignal;
};

/** Returns the line to print on success; throws AuthError on a refusal. */
export async function login(input: LoginInput): Promise<string> {
	const runtime = await input.sdk.createRuntime(input.agentDir);
	try {
		const provider = runtime
			.getProviders()
			.find((candidate) => candidate.id === input.provider);
		if (provider === undefined) {
			const ids = runtime
				.getProviders()
				.filter(
					(candidate) =>
						candidate.auth.oauth !== undefined ||
						candidate.auth.apiKey?.login !== undefined,
				)
				.map((candidate) => candidate.id)
				.sort();
			// The id is not repeated: it may be a key typed in the wrong place.
			throw new AuthError(
				`Unknown provider. Providers with a login: ${ids.join(", ")}`,
			);
		}
		const hasKeyLogin = provider.auth.apiKey?.login !== undefined;
		const hasOAuth = provider.auth.oauth !== undefined;
		let type: "api_key" | "oauth";
		if (input.apiKey) {
			if (!hasKeyLogin) {
				throw new AuthError(
					`${provider.name} has no API key login.${hasOAuth ? " Omit --api-key to sign in with the account." : ""}`,
				);
			}
			type = "api_key";
		} else if (hasOAuth) {
			type = "oauth";
		} else if (hasKeyLogin) {
			// Providers without account login take an API key, as in Pi.
			type = "api_key";
		} else {
			throw new AuthError(
				`${provider.name} is configured outside review-panel (environment or models.json); it has no login.`,
			);
		}
		let interaction: AuthInteraction;
		if (type === "api_key") {
			const key = await readApiKey(input.terminal, provider.name, input.signal);
			interaction = apiKeyInteraction(key, input.terminal, input.signal);
		} else {
			if (!input.terminal.interactive) {
				throw new AuthError(
					`Signing in to ${provider.name} needs an interactive terminal`,
				);
			}
			interaction = terminalInteraction(input.terminal, input.signal);
		}
		await runtime.login(provider.id, type, interaction, {
			getDeviceId: () => input.sdk.deviceId(input.agentDir, input.cwd),
		});
		return `${type === "oauth" ? `Logged in to ${provider.name}` : `Saved the API key for ${provider.name}`}. Credentials are in ${input.agentDir}/auth.json`;
	} finally {
		await runtime.settleCredentialWrites();
	}
}

export async function logout(input: {
	provider: string;
	agentDir: string;
	sdk: AuthSdk;
	signal: AbortSignal;
}): Promise<string> {
	const runtime = await input.sdk.createRuntime(input.agentDir);
	try {
		const stored = await runtime.listCredentials({ signal: input.signal });
		const credential = stored.find(
			(candidate) => candidate.providerId === input.provider,
		);
		if (credential === undefined) {
			return `No stored credential for ${shown(input.provider)} in ${input.agentDir}/auth.json. Environment variables and models.json are unchanged.`;
		}
		await runtime.logout(credential.providerId, { signal: input.signal });
		return `Removed the stored credential for ${input.provider} from ${input.agentDir}/auth.json.`;
	} finally {
		await runtime.settleCredentialWrites();
	}
}

/** One row per distinct provider (and extension set) in the roster. */
export function statusRows(
	roster: readonly {
		id: string;
		provider: string;
		model: string;
		extraExtensionPaths?: string[];
	}[],
): StatusRow[] {
	const rows = new Map<string, StatusRow>();
	for (const row of roster) {
		const extensionPaths = row.extraExtensionPaths ?? [];
		const key = JSON.stringify([row.provider, extensionPaths]);
		const existing = rows.get(key);
		if (existing === undefined) {
			rows.set(key, {
				provider: row.provider,
				model: row.model,
				extensionPaths,
				seats: [row.id],
			});
		} else {
			existing.seats.push(row.id);
		}
	}
	return [...rows.values()];
}

export type StatusResult = {
	agentDir: string;
	providers: (StatusRow & ProviderAuthState)[];
};

export async function status(input: {
	repoDir: string;
	agentDir: string;
	roster: Parameters<typeof statusRows>[0];
	sdk: AuthSdk;
}): Promise<StatusResult> {
	const providers: StatusResult["providers"] = [];
	for (const row of statusRows(input.roster)) {
		let state: ProviderAuthState;
		try {
			state = await input.sdk.inspect({
				repoDir: input.repoDir,
				agentDir: input.agentDir,
				provider: row.provider,
				model: row.model,
				extensionPaths: row.extensionPaths,
			});
		} catch (error) {
			state = {
				authenticated: false,
				error: error instanceof Error ? error.message : String(error),
				extensionFailures: [],
			};
		}
		providers.push({ ...row, ...state });
	}
	return { agentDir: input.agentDir, providers };
}

export function renderStatus(result: StatusResult): string {
	const lines = [`Agent folder: ${result.agentDir}`];
	for (const row of result.providers) {
		const seats = `seats: ${row.seats.join(", ")}`;
		let state: string;
		if (row.authenticated) {
			const how =
				row.check === undefined
					? ""
					: ` (${row.check.type}${row.check.source ? `, ${row.check.source}` : ""})`;
			state = `logged in${how}`;
		} else if (row.extensionPaths.length > 0) {
			// The provider comes from an extension, which owns its login.
			state = "not logged in. Log in the way its extension documents";
		} else {
			state = `not logged in. Run: review-panel auth login ${row.provider}`;
		}
		lines.push(`${row.provider} [${seats}]: ${state}`);
		if (row.error !== undefined) {
			lines.push(`  error: ${row.error}`);
		}
		for (const failure of row.extensionFailures) {
			lines.push(`  extension ${failure.extension}: ${failure.message}`);
		}
	}
	return lines.join("\n");
}
