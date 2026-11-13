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
	/** Runs the provider's own auth `check` when it defines one. */
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
	// `getAuth` resolves request credentials but never runs a provider's own
	// `check` (for example "is the Claude Code CLI logged in"); `checkAuth`
	// does, and falls back to the same resolution when there is no check.
	const checked = (await runtime.checkAuth(input.provider)) !== undefined;
	const resolved =
		checked &&
		(await runtime.getAuth(
			model ?? input.provider,
			input.authEnv === undefined ? undefined : { env: input.authEnv },
		)) !== undefined;
	return {
		services,
		model,
		authenticated: resolved,
		extensionFailures: extensionFailures(services),
	};
}
