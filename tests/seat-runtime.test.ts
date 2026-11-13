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
