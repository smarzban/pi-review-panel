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
		const result = await createSdkSeatSession({
			spec,
			tools: [{ name: "submit_findings" }],
			confinementGuard: createConfinementGuard({ worktree: spec.worktree }),
			sdk: {
				ModelRuntime: {
					create: async () => ({
						getModel: (provider: string, model: string) => {
							calls.push({ name: "model", value: [provider, model] });
							return { provider, model };
						},
						getAuth: async (model: unknown) => {
							calls.push({ name: "auth", value: model });
							return { kind: "api-key" };
						},
					}),
				},
				SettingsManager: { inMemory: (value: unknown) => value },
				SessionManager: { inMemory: (value: unknown) => value },
				DefaultResourceLoader: class {
					constructor(options: unknown) {
						calls.push({ name: "loader", value: options });
					}
					async reload() {}
					getExtensions() {
						return { errors: [] };
					}
				},
				getAgentDir: () => "/agent",
				createAgentSession: async (options: unknown) => {
					calls.push({ name: "session", value: options });
					return { session };
				},
			},
		});

		expect(calls).toContainEqual({
			name: "model",
			value: ["anthropic", "claude-opus-5"],
		});
		expect(calls.find((call) => call.name === "loader")?.value).toMatchObject({
			cwd: "/tmp",
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
