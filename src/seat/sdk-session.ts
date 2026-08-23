import { DEFAULT_SEAT_PROFILE, type SeatProfile } from "./channel-profile.js";

const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/** Complete, serializable input required to run one embedded seat again. */
export type SeatSpec<P extends SeatProfile = typeof DEFAULT_SEAT_PROFILE> = {
	provider: string;
	model: string;
	lens: string;
	lensPrompt: string;
	/** Diff base for change review. Repository audits omit it. */
	baseRef?: string;
	scopingNote?: string;
	/** Untrusted records rendered after the role prompt, never in the binding scope. */
	dataAppendix?: string;
	worktree: string;
	extraExtensionPaths?: string[];
	profile?: P;
	expectedIds?: string[];
	cycle?: number;
};

export type SeatTool = { name: string };

export type SdkSession = {
	prompt: (text: string) => Promise<void>;
	abort: () => Promise<void>;
	dispose: () => void;
	getSessionStats: () => {
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
	};
};

export type SdkSeatSession = { session: SdkSession };

type PiSdk = {
	ModelRuntime: {
		create: () => Promise<{
			getModel: (provider: string, model: string) => unknown;
			getAuth: (model: unknown) => Promise<unknown>;
		}>;
	};
	SettingsManager: { inMemory: (settings?: unknown) => unknown };
	SessionManager: { inMemory: (cwd?: string) => unknown };
	DefaultResourceLoader: new (
		options: Record<string, unknown>,
	) => {
		reload: () => Promise<void>;
		getExtensions: () => { errors: Array<{ error: string }> };
	};
	getAgentDir: () => string;
	createAgentSession: (
		options: Record<string, unknown>,
	) => Promise<SdkSeatSession>;
};

export type SdkSeatSessionInput = {
	spec: SeatSpec<SeatProfile>;
	tools: SeatTool[];
	confinementGuard: (event: {
		toolName: string;
		input: Record<string, unknown>;
	}) => { block: true; reason: string } | undefined;
	sdk?: PiSdk;
};

/** Test seam and dynamic peer resolution for Pi's extension runtime. */
async function loadPiSdk(): Promise<PiSdk> {
	return (await import(PI_SDK_PACKAGE)) as PiSdk;
}

function profileFor(spec: SeatSpec<SeatProfile>): SeatProfile {
	return spec.profile ?? DEFAULT_SEAT_PROFILE;
}

/**
 * Opens one isolated in-memory SDK session. All ambient resources are
 * suppressed, while explicit external extensions remain available through the
 * loader's temporary extension path mechanism. No host UI binding is made,
 * so model output cannot be written to host interactive streams.
 */
export async function createSdkSeatSession(
	input: SdkSeatSessionInput,
): Promise<SdkSeatSession> {
	const sdk = input.sdk ?? (await loadPiSdk());
	const runtime = await sdk.ModelRuntime.create();
	const model = runtime.getModel(input.spec.provider, input.spec.model);
	if (model === undefined) {
		throw new Error(
			`seat model is not configured: ${input.spec.provider}/${input.spec.model}`,
		);
	}
	const auth = await runtime.getAuth(model);
	if (auth === undefined) {
		throw new Error(
			`seat model is not authenticated: ${input.spec.provider}/${input.spec.model}`,
		);
	}

	const profile = profileFor(input.spec);
	const settingsManager = sdk.SettingsManager.inMemory({});
	const loader = new sdk.DefaultResourceLoader({
		cwd: input.spec.worktree,
		agentDir: sdk.getAgentDir(),
		settingsManager,
		additionalExtensionPaths: input.spec.extraExtensionPaths ?? [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: profile.systemPrompt,
		extensionFactories: [
			(pi: { on: (event: string, handler: unknown) => void }) =>
				pi.on("tool_call", input.confinementGuard),
		],
	});
	await loader.reload();
	const extensionErrors = loader.getExtensions().errors;
	if (extensionErrors.length > 0) {
		throw new Error(
			`seat extension failed to load: ${extensionErrors[0].error}`,
		);
	}

	return sdk.createAgentSession({
		cwd: input.spec.worktree,
		modelRuntime: runtime,
		model,
		settingsManager,
		sessionManager: sdk.SessionManager.inMemory(input.spec.worktree),
		resourceLoader: loader,
		noTools: "all",
		tools: [...profile.tools],
		customTools: input.tools,
	});
}
