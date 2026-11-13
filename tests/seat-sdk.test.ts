import { describe, expect, it } from "vitest";

import { createSdkSeatSession } from "../src/seat/sdk-session.js";
import { createConfinementGuard } from "../src/seat/seat-extension.js";

const spec = {
	provider: "anthropic",
	model: "claude-opus-5",
	lens: "security",
	lensPrompt: "Review the authentication change.",
	baseRef: "abc123",
	worktree: "/tmp",
	extraExtensionPaths: ["/outside/anthropic-auth.ts"],
};

describe("embedded SDK seat session", () => {
	it("pins exact identity/auth, disables ambient resources, and exposes only role tools", async () => {
		const calls: Array<{ name: string; value: unknown }> = [];
		const session = {
			prompt: async () => undefined,
			abort: async () => undefined,
			dispose: () => undefined,
			getSessionStats: () => ({
				tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				cost: 0.01,
			}),
		};
		const modelRuntime = {
			getModel: (provider: string, model: string) => {
				calls.push({ name: "model", value: [provider, model] });
				return { provider, model };
			},
			checkAuth: async (provider: string) => {
				calls.push({ name: "check", value: provider });
				return { type: "api_key", source: "fake" };
			},
			getAuth: async (model: unknown) => {
				calls.push({ name: "auth", value: model });
				return { kind: "api-key" };
			},
		};
		const resourceLoader = { getExtensions: () => ({ errors: [] }) };
		const result = await createSdkSeatSession({
			spec,
			tools: [{ name: "submit_findings" }],
			confinementGuard: createConfinementGuard({ worktree: spec.worktree }),
			sdk: {
				SettingsManager: { inMemory: (value: unknown) => value },
				SessionManager: { inMemory: (value: unknown) => value },
				// Pi's createAgentSessionServices builds its loader from these
				// options plus cwd and agentDir, loads the extensions, and drains
				// their provider registrations into the runtime it returns.
				createAgentSessionServices: async (options: {
					cwd: string;
					agentDir: string;
					resourceLoaderOptions: Record<string, unknown>;
				}) => {
					calls.push({
						name: "loader",
						value: {
							cwd: options.cwd,
							agentDir: options.agentDir,
							...options.resourceLoaderOptions,
						},
					});
					return {
						modelRuntime,
						resourceLoader,
						settingsManager: "settings",
						diagnostics: [],
					};
				},
				getAgentDir: () => "/agent",
				createAgentSession: async (options: Record<string, unknown>) => {
					calls.push({ name: "session", value: options });
					return { session };
				},
			},
		});

		// The model and auth resolve only after the extensions loaded.
		expect(calls.map((call) => call.name)).toEqual([
			"loader",
			"model",
			"check",
			"auth",
			"session",
		]);
		expect(calls).toContainEqual({
			name: "model",
			value: ["anthropic", "claude-opus-5"],
		});
		expect(calls.find((call) => call.name === "loader")?.value).toMatchObject({
			cwd: "/tmp",
			agentDir: "/agent",
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: ["/outside/anthropic-auth.ts"],
			systemPrompt:
				"You are a Review panel reviewer. Use only the supplied tools and record findings only through submit_findings.",
		});
		const sessionOptions = calls.find((call) => call.name === "session")?.value;
		expect(sessionOptions).toMatchObject({
			model: { provider: "anthropic", model: "claude-opus-5" },
			tools: ["read", "grep", "find", "ls", "git_diff", "submit_findings"],
			customTools: [{ name: "submit_findings" }],
			noTools: "all",
			// The session reuses the loader and runtime that loaded the
			// extensions, so each extension loads once per seat.
			modelRuntime,
			resourceLoader,
			settingsManager: "settings",
		});
		// No host UI or stream binding is supplied, so model output stays inside
		// the isolated session and crosses the boundary only through its tool.
		expect(sessionOptions).not.toMatchObject({ ui: expect.anything() });
		expect(sessionOptions).not.toMatchObject({ onMessage: expect.anything() });
		expect(result.session).toBe(session);

		// Exercise the factory that sdk-session registers with the resource
		// loader, rather than only asserting that one was supplied. This is the
		// host tool_call wiring that protects Pi's built-in read path.
		const loader = calls.find((call) => call.name === "loader")?.value as {
			extensionFactories: Array<
				(pi: { on: (event: string, handler: unknown) => void }) => void
			>;
		};
		let handler:
			| ((event: {
					toolName: string;
					input: Record<string, unknown>;
			  }) => unknown)
			| undefined;
		loader.extensionFactories[0]({
			on: (event, registered) => {
				expect(event).toBe("tool_call");
				handler = registered as typeof handler;
			},
		});
		expect(
			handler?.({ toolName: "read", input: { path: "/etc/passwd" } }),
		).toMatchObject({
			block: true,
		});
		expect(
			handler?.({ toolName: "read", input: { path: "/tmp/inside-worktree" } }),
		).toBeUndefined();
	});
});
