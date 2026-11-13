/**
 * The bundled Pi SDK, loaded only by dynamic import so that
 * `PI_CODING_AGENT_DIR` is already pinned (see `agent-dir.ts`) when any SDK
 * code first runs. Only types are imported statically.
 */
import path from "node:path";
import { env as processEnv } from "node:process";
import type * as PiSdk from "@earendil-works/pi-coding-agent";

import {
	resolveSeatRuntime,
	type SeatServicesSdk,
} from "../../src/seat/seat-runtime.js";
import type { AuthSdk, LoginRuntime, ProviderAuthState } from "./auth.js";
import type { AuthInteraction } from "./sdk-types.js";

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
		const error = runtime.authError ?? checkError;
		return {
			authenticated: runtime.authenticated,
			...(check === undefined ? {} : { check }),
			...(error === undefined ? {} : { error }),
			extensionFailures: runtime.extensionFailures,
		};
	},
};
