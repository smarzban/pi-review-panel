/**
 * One place that decides whether a seat's exact `provider/model` is usable.
 * Readiness and the seat run both call it, so the two cannot disagree again.
 *
 * A Pi extension's `registerProvider` does not touch any model runtime. The
 * resource loader queues the registration, and Pi's public
 * `createAgentSessionServices` loads the extensions and then drains every
 * queue (by name, native, and virtual models where the SDK has them) into the
 * runtime. Only after that can the model and its auth be resolved.
 */

export type SeatModelRuntime = {
	getModel: (provider: string, model: string) => unknown;
	/** The registered provider, used to see whether it has its own check. */
	getProvider?: (
		provider: string,
	) => { auth?: { apiKey?: { check?: unknown } } } | undefined;
	/**
	 * Runs the provider's own auth `check` when it defines one. It reads the
	 * process environment only: Pi gives it no environment override.
	 */
	checkAuth: (provider: string) => Promise<unknown>;
	getAuth: (
		providerOrModel: unknown,
		overrides?: { env: Record<string, string> },
	) => Promise<unknown>;
};

export type SeatResourceLoader = {
	getExtensions: () => { errors: Array<{ path: string; error: string }> };
};

export type SeatServices = {
	modelRuntime: SeatModelRuntime;
	resourceLoader: SeatResourceLoader;
	settingsManager: unknown;
	diagnostics: Array<{ type: string; message: string }>;
};

export type SeatServicesSdk = {
	SettingsManager: { inMemory: (settings?: unknown) => unknown };
	createAgentSessionServices: (options: {
		cwd: string;
		agentDir: string;
		settingsManager: unknown;
		resourceLoaderOptions: Record<string, unknown>;
	}) => Promise<SeatServices>;
};

/** Every ambient resource is suppressed; only named extensions load. */
export const ISOLATED_LOADER_OPTIONS = {
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
} as const;

/** An extension that failed to load or to register what it declared. */
export type ExtensionFailure = { extension: string; message: string };

export type SeatRuntimeInput = {
	sdk: SeatServicesSdk;
	cwd: string;
	agentDir: string;
	provider: string;
	model: string;
	extensionPaths: readonly string[];
	/** Seat-only loader options, such as the system prompt and the guard. */
	loaderOptions?: Record<string, unknown>;
	/** Environment overrides for request-auth resolution. */
	authEnv?: Record<string, string>;
};

export type SeatRuntime = {
	services: SeatServices;
	/** The resolved Pi model, or undefined when the runtime has none. */
	model: unknown;
	/** True only when the provider's own check and request auth both pass. */
	authenticated: boolean;
	/** Why auth could not be decided, when the check or resolution threw. */
	authError?: string;
	extensionFailures: ExtensionFailure[];
};

const REGISTRATION_ERROR = /^Extension "(.+)" error: ([\s\S]*)$/;

function extensionFailures(services: SeatServices): ExtensionFailure[] {
	const failures: ExtensionFailure[] = services.resourceLoader
		.getExtensions()
		.errors.map((entry) => ({ extension: entry.path, message: entry.error }));
	for (const diagnostic of services.diagnostics) {
		if (diagnostic.type !== "error") {
			continue;
		}
		const match = REGISTRATION_ERROR.exec(diagnostic.message);
		failures.push(
			match
				? { extension: match[1], message: match[2] }
				: { extension: "<unknown>", message: diagnostic.message },
		);
	}
	return failures;
}

/**
 * Creates a fresh runtime and loader, loads exactly `extensionPaths`, applies
 * every provider those extensions registered, and only then resolves the
 * model and auth. Each call is independent, so one row's extension can never
 * make another row's provider visible.
 */
export async function resolveSeatRuntime(
	input: SeatRuntimeInput,
): Promise<SeatRuntime> {
	const services = await input.sdk.createAgentSessionServices({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: input.sdk.SettingsManager.inMemory({}),
		resourceLoaderOptions: {
			...input.loaderOptions,
			...ISOLATED_LOADER_OPTIONS,
			additionalExtensionPaths: [...input.extensionPaths],
		},
	});
	const runtime = services.modelRuntime;
	const model = runtime.getModel(input.provider, input.model);
	let authenticated = false;
	let authError: string | undefined;
	try {
		authenticated =
			(await providerCheckPasses(runtime, input.provider)) &&
			(await runtime.getAuth(
				model ?? input.provider,
				input.authEnv === undefined ? undefined : { env: input.authEnv },
			)) !== undefined;
	} catch (error) {
		// A check or resolution that throws (for example a provider CLI that is
		// missing) is an auth failure; the model and the extension failures
		// found by this load still stand.
		authError = error instanceof Error ? error.message : String(error);
	}
	return {
		services,
		model,
		authenticated,
		...(authError === undefined ? {} : { authError }),
		extensionFailures: extensionFailures(services),
	};
}

/**
 * `getAuth` resolves request credentials but never runs a provider's own
 * `check` (for example "is the Claude Code CLI logged in"), so a provider
 * that defines one must also pass `checkAuth`. A provider without its own
 * check is decided by `getAuth` alone, which honours the caller's
 * environment overrides; `checkAuth` would read only the process
 * environment. When the runtime cannot show the provider, `checkAuth` runs.
 */
async function providerCheckPasses(
	runtime: SeatModelRuntime,
	provider: string,
): Promise<boolean> {
	if (
		runtime.getProvider !== undefined &&
		typeof runtime.getProvider(provider)?.auth?.apiKey?.check !== "function"
	) {
		return true;
	}
	return (await runtime.checkAuth(provider)) !== undefined;
}
