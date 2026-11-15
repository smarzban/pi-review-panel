/**
 * The bundled Pi SDK, loaded only by dynamic import so that
 * `PI_CODING_AGENT_DIR` is already pinned (see `agent-dir.ts`) when any SDK
 * code first runs. Only types are imported statically.
 */
import path from "node:path";
import { env as processEnv } from "node:process";
import type * as PiSdk from "@earendil-works/pi-coding-agent";

import {
	createIsolatedServices,
	extensionFailures,
	resolveSeatRuntime,
	type SeatServicesSdk,
} from "../seat/seat-runtime.js";
import type { AuthSdk, LoginRuntime, ProviderAuthState } from "./auth.js";
import type { AuthInteraction } from "./sdk-types.js";
import {
	type CatalogModel,
	type InstalledExtension,
	type ProviderLogin,
	type ProviderRow,
	redactSecrets,
	type SetupSdk,
} from "./setup.js";

export const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

let loaded: typeof PiSdk | undefined;

async function loadSdk(): Promise<typeof PiSdk> {
	loaded ??= (await import(PI_SDK_PACKAGE)) as typeof PiSdk;
	return loaded;
}

export async function sdkVersion(): Promise<string> {
	try {
		return (await loadSdk()).VERSION;
	} catch (error) {
		return `unavailable (${error instanceof Error ? error.message : String(error)})`;
	}
}

/** Compile-time check that our restated interaction fits the SDK's. */
type SdkInteraction = Parameters<PiSdk.ModelRuntime["login"]>[2];
const _interactionFits = (value: AuthInteraction): SdkInteraction => value;
void _interactionFits;

export const realAuthSdk: AuthSdk = {
	async createRuntime(agentDir: string): Promise<LoginRuntime> {
		const sdk = await loadSdk();
		return sdk.ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: AbortSignal.timeout(15_000),
		});
	},
	deviceId(agentDir: string, cwd: string): string {
		// Only the login flows that need a device id call this, always after
		// createRuntime loaded the SDK. The id lives in the agent folder's
		// settings.json, as in Pi.
		if (loaded === undefined) {
			throw new Error("The Pi SDK is not loaded yet");
		}
		const { SettingsManager } = loaded;
		return SettingsManager.create(cwd, agentDir, {
			projectTrusted: false,
		}).getOrCreateDeviceId();
	},
	async inspect(input): Promise<ProviderAuthState> {
		const sdk = await loadSdk();
		const authEnv = Object.fromEntries(
			Object.entries(processEnv).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		);
		const runtime = await resolveSeatRuntime({
			sdk: sdk as unknown as SeatServicesSdk,
			cwd: input.repoDir,
			agentDir: input.agentDir,
			provider: input.provider,
			model: input.model,
			extensionPaths: input.extensionPaths,
			authEnv,
		});
		let check: ProviderAuthState["check"];
		let checkError: string | undefined;
		try {
			const found = (await runtime.services.modelRuntime.checkAuth(
				input.provider,
			)) as { type: string; source?: string } | undefined;
			check = found;
		} catch (error) {
			checkError = error instanceof Error ? error.message : String(error);
		}
		// A check may refresh an OAuth token; let that write finish.
		await (
			runtime.services.modelRuntime as {
				settleCredentialWrites?: () => Promise<void>;
			}
		).settleCredentialWrites?.();
		const error = runtime.authError ?? checkError;
		return {
			authenticated: runtime.authenticated,
			...(check === undefined ? {} : { check }),
			...(error === undefined ? {} : { error }),
			extensionFailures: runtime.extensionFailures,
		};
	},
};

function createModelRuntime(
	sdk: typeof PiSdk,
	agentDir: string,
): Promise<PiSdk.ModelRuntime> {
	return sdk.ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		allowModelNetwork: false,
		signal: AbortSignal.timeout(15_000),
	});
}

/** Words for where a provider's configuration comes from (`AuthStatus.source`). */
function configuredHow(status: {
	source?: string;
	label?: string;
}): string | undefined {
	switch (status.source) {
		case undefined:
			return undefined;
		case "stored":
			return "stored credential";
		case "environment":
			return status.label === undefined
				? "environment"
				: `environment ${status.label}`;
		case "models_json_key":
			return "models.json key";
		case "models_json_command":
			return "models.json command";
		default:
			return status.label ?? status.source;
	}
}

/**
 * Pi's package manager on the agent folder's own settings.json only. Its
 * working folder is the agent folder and project settings are untrusted, so
 * nothing from the folder the command runs in (a reviewed repository's
 * `.pi/settings.json` or `.pi/extensions`) is ever read or installed.
 */
function packageManager(sdk: typeof PiSdk, agentDir: string) {
	// git never stops to ask for a user name or password on the terminal: a
	// source that needs one fails with git's own message instead.
	process.env.GIT_TERMINAL_PROMPT = "0";
	const settingsManager = sdk.SettingsManager.create(agentDir, agentDir, {
		projectTrusted: false,
	});
	const manager = new sdk.DefaultPackageManager({
		cwd: agentDir,
		agentDir,
		settingsManager,
	});
	return { settingsManager, manager };
}

async function installedPackages(
	manager: PiSdk.DefaultPackageManager,
): Promise<InstalledExtension[]> {
	const configured = manager
		.listConfiguredPackages()
		.filter((entry) => entry.scope === "user");
	if (configured.length === 0) {
		return [];
	}
	// A package that is configured but missing is skipped, never installed.
	const resolved = await manager.resolve(async () => "skip");
	return configured.map((entry) => ({
		source: entry.source,
		...(entry.installedPath === undefined
			? {}
			: { installedPath: entry.installedPath }),
		filtered: entry.filtered,
		entries: resolved.extensions
			.filter(
				(resource) =>
					resource.enabled &&
					resource.metadata.origin === "package" &&
					resource.metadata.scope === "user" &&
					resource.metadata.source === entry.source,
			)
			.map((resource) => resource.path),
	}));
}

async function settle(settingsManager: PiSdk.SettingsManager): Promise<void> {
	await settingsManager.flush();
	const errors = settingsManager.drainErrors();
	if (errors.length > 0) {
		throw new Error(
			`settings.json: ${errors.map((entry) => entry.error.message).join("; ")}`,
		);
	}
}

/** The slice of `ModelRuntime` that `providerRows` reads. */
export type ProviderRuntime = Pick<
	PiSdk.ModelRuntime,
	| "getProviders"
	| "listCredentials"
	| "getAvailable"
	| "getProviderAuthStatus"
	| "checkAuth"
>;

type Bounded<T> =
	| { kind: "done"; value: T }
	| { kind: "failed"; error: unknown }
	| { kind: "timed-out" };

/**
 * `work` settled within `ms`, or not. The timer stays referenced while it
 * waits, so a check that awaits a promise that never settles still ends.
 */
function bounded<T>(work: Promise<T>, ms: number): Promise<Bounded<T>> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<Bounded<T>>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timed-out" }), ms);
	});
	return Promise.race([
		work.then(
			(value): Bounded<T> => ({ kind: "done", value }),
			(error: unknown): Bounded<T> => ({ kind: "failed", error }),
		),
		late,
	]).finally(() => clearTimeout(timer));
}

/**
 * One row per provider. The runtime's availability pass fills its auth
 * snapshot, but one check that throws fails the whole pass, so a provider the
 * snapshot does not show as configured is checked again on its own. Those
 * checks run concurrently, each within `checkTimeoutMs`: a check that fails
 * or never finishes marks only its own row, and the command has an overall
 * bound of about three times that.
 */
export async function providerRows(
	runtime: ProviderRuntime,
	options: { checkTimeoutMs?: number } = {},
): Promise<ProviderRow[]> {
	const ms = options.checkTimeoutMs ?? 15_000;
	const signal = () => AbortSignal.timeout(ms);
	const credentials = await bounded(
		Promise.resolve().then(() => runtime.listCredentials({ signal: signal() })),
		ms,
	);
	// An unreadable auth.json leaves stored logins to the checks below.
	const stored = new Set(
		credentials.kind === "done"
			? credentials.value.map((entry) => entry.providerId)
			: [],
	);
	// One failing check fails the pass; each provider is checked below.
	await bounded(
		Promise.resolve().then(() =>
			runtime.getAvailable(undefined, { signal: signal() }),
		),
		ms,
	);
	const rows = await Promise.all(
		runtime.getProviders().map(async (provider): Promise<ProviderRow> => {
			const logins: ProviderLogin[] = [];
			if (provider.auth.oauth !== undefined) {
				logins.push("account");
			}
			if (provider.auth.apiKey?.login !== undefined) {
				logins.push("api-key");
			}
			const row: ProviderRow = {
				id: provider.id,
				name: provider.name,
				logins,
				loggedIn: false,
			};
			const status = runtime.getProviderAuthStatus(provider.id);
			if (stored.has(provider.id)) {
				row.loggedIn = true;
				row.how = "stored credential";
				return row;
			}
			if (status.configured) {
				row.loggedIn = true;
				const how = configuredHow(status);
				if (how !== undefined) {
					row.how = how;
				}
				return row;
			}
			const check = await bounded(
				Promise.resolve().then(() =>
					runtime.checkAuth(provider.id, { signal: signal() }),
				),
				ms,
			);
			if (check.kind === "done" && check.value !== undefined) {
				row.loggedIn = true;
				row.how = check.value.source ?? check.value.type;
			} else if (check.kind === "failed") {
				row.checkError = redactSecrets(
					check.error instanceof Error
						? check.error.message
						: String(check.error),
				);
			} else if (check.kind === "timed-out") {
				row.checkError = `the login check did not finish within ${ms / 1000} s`;
			}
			return row;
		}),
	);
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export const realSetupSdk: SetupSdk = {
	async providers(agentDir) {
		const sdk = await loadSdk();
		const runtime = await createModelRuntime(sdk, agentDir);
		try {
			return await providerRows(runtime);
		} finally {
			await runtime.settleCredentialWrites();
		}
	},
	async models(input) {
		const sdk = await loadSdk();
		const services = await createIsolatedServices({
			sdk: sdk as unknown as SeatServicesSdk,
			cwd: input.cwd,
			agentDir: input.agentDir,
			extensionPaths: input.extensionPaths,
			// The same offline runtime as auth providers: no catalog refresh.
			modelRuntime: await createModelRuntime(sdk, input.agentDir),
		});
		const runtime = services.modelRuntime as unknown as PiSdk.ModelRuntime;
		try {
			const registered = [...runtime.getRegisteredProviderIds()];
			const own = (provider: string) =>
				input.extensionPaths.length === 0 || registered.includes(provider);
			const all = runtime.getModels().filter((model) => own(model.provider));
			const available = new Set<string>();
			for (const provider of new Set(all.map((model) => model.provider))) {
				try {
					// The SDK's catalogs and the provider's own login check; no
					// request lists models.
					for (const model of await runtime.getAvailable(provider, {
						signal: AbortSignal.timeout(15_000),
					})) {
						available.add(`${model.provider}/${model.id}`);
					}
				} catch {
					// A check that throws leaves the provider's models unavailable.
				}
			}
			const models: CatalogModel[] = all.map((model) => ({
				provider: model.provider,
				model: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinking: model.reasoning,
				images: model.input.includes("image"),
				available: available.has(`${model.provider}/${model.id}`),
			}));
			return {
				registeredProviders: registered,
				models,
				extensionFailures: extensionFailures(services),
			};
		} finally {
			await runtime.settleCredentialWrites();
		}
	},
	async listExtensions(input) {
		const { manager } = packageManager(await loadSdk(), input.agentDir);
		return installedPackages(manager);
	},
	async installExtension(input) {
		const { settingsManager, manager } = packageManager(
			await loadSdk(),
			input.agentDir,
		);
		manager.setProgressCallback((event) => {
			if (
				(event.type === "start" || event.type === "progress") &&
				event.message !== undefined
			) {
				input.progress(event.message);
			}
		});
		await manager.installAndPersist(input.source);
		await settle(settingsManager);
		const where = manager.getInstalledPath(input.source, "user");
		const packages = await installedPackages(manager);
		const found =
			packages.find(
				(entry) =>
					where !== undefined &&
					entry.installedPath !== undefined &&
					path.resolve(entry.installedPath) === path.resolve(where),
			) ?? packages.find((entry) => entry.source === input.source);
		if (found === undefined) {
			throw new Error(
				`installed ${input.source}, but ${path.join(input.agentDir, "settings.json")} does not list it`,
			);
		}
		return found;
	},
	async removeExtension(input) {
		const { settingsManager, manager } = packageManager(
			await loadSdk(),
			input.agentDir,
		);
		manager.setProgressCallback((event) => {
			if (event.type === "start" && event.message !== undefined) {
				input.progress(event.message);
			}
		});
		const removed = await manager.removeAndPersist(input.source);
		await settle(settingsManager);
		return removed;
	},
};
