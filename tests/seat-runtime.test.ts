import { describe, expect, it } from "vitest";

import { resolveSeatRuntime } from "../src/seat/seat-runtime.js";

// Pi only emits registration diagnostics in the exact
// `Extension "<path>" error: <message>` shape (proven against the real SDK in
// extension-provider.test.ts). This stub covers the shapes the real SDK cannot
// be made to produce from a fixture: an error in another shape, and a warning.
function sdkWithDiagnostics(
	diagnostics: Array<{ type: string; message: string }>,
) {
	return {
		SettingsManager: { inMemory: () => ({}) },
		createAgentSessionServices: async () => ({
			modelRuntime: {
				getModel: () => ({ provider: "p", id: "m" }),
				checkAuth: async () => ({ type: "api_key" }),
				getAuth: async () => ({ auth: {} }),
			},
			resourceLoader: { getExtensions: () => ({ errors: [] }) },
			settingsManager: {},
			diagnostics,
		}),
	};
}

describe("seat runtime registration diagnostics", () => {
	it("names the extension of a registration error, keeps an unattributed error, and ignores warnings", async () => {
		const runtime = await resolveSeatRuntime({
			sdk: sdkWithDiagnostics([
				{ type: "error", message: 'Extension "/x/ext.ts" error: bad provider' },
				{ type: "error", message: "Unknown option: --flag" },
				{ type: "warning", message: 'Extension "/x/warn.ts" error: ignored' },
			]),
			cwd: "/repo",
			agentDir: "/agent",
			provider: "p",
			model: "m",
			extensionPaths: ["/x/ext.ts"],
		});

		expect(runtime.extensionFailures).toEqual([
			{ extension: "/x/ext.ts", message: "bad provider" },
			{ extension: "<unknown>", message: "Unknown option: --flag" },
		]);
	});
});

// Each branch of the auth gate, through a fake runtime. `checkAuth` returns
// undefined (a provider's own check saying "not configured") so that running
// it is visible as an authentication failure.
function sdkWithRuntime(runtime: Record<string, unknown>, checks: string[]) {
	return {
		SettingsManager: { inMemory: () => ({}) },
		createAgentSessionServices: async () => ({
			modelRuntime: {
				getModel: () => ({ provider: "p", id: "m" }),
				checkAuth: async (provider: string) => {
					checks.push(provider);
					return undefined;
				},
				getAuth: async () => ({ auth: {} }),
				...runtime,
			},
			resourceLoader: { getExtensions: () => ({ errors: [] }) },
			settingsManager: {},
			diagnostics: [],
		}),
	};
}

async function gate(runtime: Record<string, unknown>) {
	const checks: string[] = [];
	const result = await resolveSeatRuntime({
		sdk: sdkWithRuntime(runtime, checks),
		cwd: "/repo",
		agentDir: "/agent",
		provider: "p",
		model: "m",
		extensionPaths: [],
	});
	return { authenticated: result.authenticated, checks };
}

const withCheck = { auth: { apiKey: { check: async () => undefined } } };

describe("seat runtime auth gate", () => {
	it("skips checkAuth for a provider no extension registered", async () => {
		expect(
			await gate({
				getRegisteredProviderIds: () => ["other"],
				getProvider: () => withCheck,
			}),
		).toEqual({ authenticated: true, checks: [] });
	});

	it("skips checkAuth for an extension provider that defines no check", async () => {
		expect(
			await gate({
				getRegisteredProviderIds: () => ["p"],
				getProvider: () => ({ auth: { apiKey: {} } }),
			}),
		).toEqual({ authenticated: true, checks: [] });
	});

	it("runs checkAuth for an extension provider with its own check", async () => {
		expect(
			await gate({
				getRegisteredProviderIds: () => ["p"],
				getProvider: () => withCheck,
			}),
		).toEqual({ authenticated: false, checks: ["p"] });
	});

	it("runs checkAuth when the runtime cannot show registrations or checks", async () => {
		expect(await gate({})).toEqual({ authenticated: false, checks: ["p"] });
	});
});
