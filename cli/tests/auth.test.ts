import { describe, expect, it, vi } from "vitest";

import {
	AuthError,
	type AuthSdk,
	type AuthTerminal,
	type LoginRuntime,
	login,
	logout,
	renderStatus,
	status,
	statusRows,
} from "../src/auth.js";
import type { AuthInteraction } from "../src/sdk-types.js";

type Provider = ReturnType<LoginRuntime["getProviders"]>[number];

const ANTHROPIC: Provider = {
	id: "anthropic",
	name: "Anthropic",
	auth: { oauth: {}, apiKey: { login: () => {} } },
};
const CODEX: Provider = {
	id: "openai-codex",
	name: "ChatGPT",
	auth: { oauth: {} },
};
// Key login only, as Baseten has in Pi SDK 1.5.2 (the built-bin test logs in
// to the real one without --api-key).
const BASETEN: Provider = {
	id: "baseten",
	name: "Baseten",
	auth: { apiKey: { login: () => {} } },
};
const OLLAMA: Provider = { id: "ollama", name: "Ollama", auth: { apiKey: {} } };

function fakeRuntime(
	script: (interaction: AuthInteraction) => Promise<void> = async () => {},
) {
	const stored = new Map<string, string>();
	const logins: { provider: string; type: string; deviceId?: string }[] = [];
	const runtime: LoginRuntime = {
		getProviders: () => [ANTHROPIC, BASETEN, CODEX, OLLAMA],
		login: vi.fn(async (provider, type, interaction, options) => {
			await script(interaction);
			logins.push({
				provider,
				type,
				...(options?.getDeviceId ? { deviceId: options.getDeviceId() } : {}),
			});
			stored.set(provider, type);
			return {};
		}),
		logout: vi.fn(async (provider) => {
			stored.delete(provider);
		}),
		listCredentials: async () =>
			[...stored].map(([providerId, type]) => ({ providerId, type })),
		settleCredentialWrites: vi.fn(async () => {}),
	};
	return { runtime, stored, logins };
}

function sdkFor(runtime: LoginRuntime): AuthSdk & { dirs: string[] } {
	const dirs: string[] = [];
	return {
		dirs,
		createRuntime: async (agentDir) => {
			dirs.push(agentDir);
			return runtime;
		},
		deviceId: () => "device-1",
		inspect: async () => ({ authenticated: false, extensionFailures: [] }),
	};
}

function terminal(options: {
	interactive: boolean;
	stdin?: string;
	answers?: string[];
	secrets?: string[];
}) {
	const lines: string[] = [];
	const asked: string[] = [];
	const answers = [...(options.answers ?? [])];
	const secrets = [...(options.secrets ?? [])];
	const value: AuthTerminal = {
		interactive: options.interactive,
		write: (line) => lines.push(line),
		question: async (message) => {
			asked.push(message);
			return answers.shift() ?? "";
		},
		secret: async (message) => {
			asked.push(message);
			return secrets.shift() ?? "";
		},
		readStdin: async () => options.stdin ?? "",
	};
	return { value, lines, asked };
}

const signal = new AbortController().signal;

describe("auth login --api-key", () => {
	it("answers the provider's secret prompt with the key from stdin, never argv", async () => {
		let seen: string | undefined;
		const { runtime, logins, stored } = fakeRuntime(async (interaction) => {
			seen = await interaction.prompt({
				type: "secret",
				message: "Enter Anthropic API key",
			});
		});
		const sdk = sdkFor(runtime);
		const term = terminal({ interactive: false, stdin: "  sk-key\n" });
		const line = await login({
			provider: "anthropic",
			apiKey: true,
			agentDir: "/tmp/agent",
			cwd: "/",
			sdk,
			terminal: term.value,
			signal,
		});
		expect(seen).toBe("sk-key");
		expect(logins).toEqual([
			{ provider: "anthropic", type: "api_key", deviceId: "device-1" },
		]);
		expect(stored.get("anthropic")).toBe("api_key");
		expect(sdk.dirs).toEqual(["/tmp/agent"]);
		expect(line).toContain("/tmp/agent/auth.json");
		expect(runtime.settleCredentialWrites).toHaveBeenCalled();
	});

	it("asks for the key at a hidden prompt on a terminal", async () => {
		let seen: string | undefined;
		const { runtime } = fakeRuntime(async (interaction) => {
			seen = await interaction.prompt({ type: "secret", message: "key" });
		});
		const term = terminal({ interactive: true, secrets: ["typed-key"] });
		await login({
			provider: "baseten",
			apiKey: true,
			agentDir: "/a",
			cwd: "/",
			sdk: sdkFor(runtime),
			terminal: term.value,
			signal,
		});
		expect(seen).toBe("typed-key");
		expect(term.asked).toEqual(["Enter Baseten API key: "]);
	});

	it("refuses an empty key", async () => {
		const { runtime } = fakeRuntime();
		await expect(
			login({
				provider: "anthropic",
				apiKey: true,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: false, stdin: "\n" }).value,
				signal,
			}),
		).rejects.toThrow(/No API key on stdin/);
		expect(runtime.login).not.toHaveBeenCalled();
	});

	it("refuses a second prompt without a terminal", async () => {
		const { runtime } = fakeRuntime(async (interaction) => {
			await interaction.prompt({ type: "secret", message: "key" });
			await interaction.prompt({ type: "text", message: "Region" });
		});
		await expect(
			login({
				provider: "anthropic",
				apiKey: true,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: false, stdin: "k" }).value,
				signal,
			}),
		).rejects.toThrow(/Region.*interactive terminal/);
	});

	it("refuses --api-key for a provider that only has account sign-in", async () => {
		const { runtime } = fakeRuntime();
		await expect(
			login({
				provider: "openai-codex",
				apiKey: true,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: false, stdin: "k" }).value,
				signal,
			}),
		).rejects.toThrow(/no API key login/);
	});
});

describe("auth login (account sign-in)", () => {
	it("runs ModelRuntime.login with oauth and a terminal interaction", async () => {
		let code: string | undefined;
		let choice: string | undefined;
		const { runtime, logins } = fakeRuntime(async (interaction) => {
			interaction.notify({
				type: "auth_url",
				url: "https://example.test/auth",
				instructions: "Paste the code",
			});
			interaction.notify({
				type: "device_code",
				userCode: "AB-12",
				verificationUri: "https://example.test/device",
			});
			choice = await interaction.prompt({
				type: "select",
				message: "Method",
				options: [
					{ id: "browser", label: "Browser" },
					{ id: "device", label: "Device code" },
				],
			});
			code = await interaction.prompt({
				type: "manual_code",
				message: "Code",
				placeholder: "from the page",
			});
		});
		const term = terminal({ interactive: true, answers: ["x", "2", "C0DE"] });
		const line = await login({
			provider: "openai-codex",
			apiKey: false,
			agentDir: "/a",
			cwd: "/",
			sdk: sdkFor(runtime),
			terminal: term.value,
			signal,
		});
		expect(logins).toEqual([
			{ provider: "openai-codex", type: "oauth", deviceId: "device-1" },
		]);
		expect(choice).toBe("device");
		expect(code).toBe("C0DE");
		expect(term.lines).toContain(
			"Open this URL to sign in:\n  https://example.test/auth",
		);
		expect(term.lines).toContain("Paste the code");
		expect(term.lines).toContain(
			"Open https://example.test/device and enter code: AB-12",
		);
		expect(term.lines).toContain("Enter a number from 1 to 2.");
		expect(term.asked).toContain("Code (from the page): ");
		expect(line).toBe("Logged in to ChatGPT. Credentials are in /a/auth.json");
	});

	it("prefers the account sign-in when a provider has both", async () => {
		const { runtime, logins } = fakeRuntime();
		await login({
			provider: "anthropic",
			apiKey: false,
			agentDir: "/a",
			cwd: "/",
			sdk: sdkFor(runtime),
			terminal: terminal({ interactive: true }).value,
			signal,
		});
		expect(logins[0]?.type).toBe("oauth");
	});

	it("needs an interactive terminal", async () => {
		const { runtime } = fakeRuntime();
		await expect(
			login({
				provider: "openai-codex",
				apiKey: false,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: false }).value,
				signal,
			}),
		).rejects.toThrow(AuthError);
		expect(runtime.login).not.toHaveBeenCalled();
	});

	it("names the providers with a login for an unknown id", async () => {
		const { runtime } = fakeRuntime();
		await expect(
			login({
				provider: "nope",
				apiKey: false,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: true }).value,
				signal,
			}),
		).rejects.toThrow(
			"Unknown provider. Providers with a login: anthropic, baseten, openai-codex",
		);
	});

	it("does not repeat an unknown id, which may be a key typed in its place", async () => {
		const { runtime } = fakeRuntime();
		const refused = login({
			provider: "sk-ant-abc123secret",
			apiKey: true,
			agentDir: "/a",
			cwd: "/",
			sdk: sdkFor(runtime),
			terminal: terminal({ interactive: false, stdin: "k" }).value,
			signal,
		});
		await expect(refused).rejects.toThrow(AuthError);
		await expect(refused).rejects.not.toThrow(/secret/);
	});

	it("takes an API key without --api-key for a provider that has only key login", async () => {
		let seen: string | undefined;
		const { runtime, logins } = fakeRuntime(async (interaction) => {
			seen = await interaction.prompt({ type: "secret", message: "key" });
		});
		const line = await login({
			provider: "baseten",
			apiKey: false,
			agentDir: "/a",
			cwd: "/",
			sdk: sdkFor(runtime),
			terminal: terminal({ interactive: false, stdin: "sk-baseten\n" }).value,
			signal,
		});
		expect(seen).toBe("sk-baseten");
		expect(logins).toEqual([
			{ provider: "baseten", type: "api_key", deviceId: "device-1" },
		]);
		expect(line).toBe(
			"Saved the API key for Baseten. Credentials are in /a/auth.json",
		);
	});

	it("refuses a provider configured only outside (environment or models.json)", async () => {
		const { runtime } = fakeRuntime();
		await expect(
			login({
				provider: "ollama",
				apiKey: false,
				agentDir: "/a",
				cwd: "/",
				sdk: sdkFor(runtime),
				terminal: terminal({ interactive: true }).value,
				signal,
			}),
		).rejects.toThrow(/has no login/);
	});
});

describe("auth logout", () => {
	it("removes a stored credential, and says so when there is none", async () => {
		const { runtime, stored } = fakeRuntime();
		stored.set("anthropic", "api_key");
		const sdk = sdkFor(runtime);
		expect(
			await logout({ provider: "anthropic", agentDir: "/a", sdk, signal }),
		).toContain("Removed the stored credential for anthropic");
		expect(stored.has("anthropic")).toBe(false);
		expect(
			await logout({ provider: "anthropic", agentDir: "/a", sdk, signal }),
		).toContain('No stored credential for "anthropic"');
		expect(runtime.logout).toHaveBeenCalledTimes(1);
	});

	it("does not repeat an id that may be a key", async () => {
		const { runtime } = fakeRuntime();
		const line = await logout({
			provider: "sk-ant-abc123secret",
			agentDir: "/a",
			sdk: sdkFor(runtime),
			signal,
		});
		expect(line).toContain("No stored credential for (not shown");
		expect(line).not.toContain("secret");
	});
});

describe("auth status", () => {
	const roster = [
		{ id: "opus", provider: "anthropic", model: "claude-opus" },
		{ id: "sonnet", provider: "anthropic", model: "claude-sonnet" },
		{
			id: "cc",
			provider: "claude-code",
			model: "opus",
			extraExtensionPaths: ["/ext.ts"],
		},
	];

	it("groups roster seats by provider and extension set", () => {
		expect(statusRows(roster)).toEqual([
			{
				provider: "anthropic",
				model: "claude-opus",
				extensionPaths: [],
				seats: ["opus", "sonnet"],
			},
			{
				provider: "claude-code",
				model: "opus",
				extensionPaths: ["/ext.ts"],
				seats: ["cc"],
			},
		]);
	});

	it("checks each provider with its row's extensions, and reports a failed check", async () => {
		const inspected: unknown[] = [];
		const sdk: AuthSdk = {
			createRuntime: async () => {
				throw new Error("unused");
			},
			deviceId: () => "",
			inspect: async (input) => {
				inspected.push(input);
				if (input.provider === "claude-code") {
					throw new Error("claude CLI missing");
				}
				return {
					authenticated: true,
					check: { type: "oauth", source: "stored credential" },
					extensionFailures: [],
				};
			},
		};
		const result = await status({
			repoDir: "/repo",
			agentDir: "/agent",
			roster,
			sdk,
		});
		expect(inspected).toEqual([
			{
				repoDir: "/repo",
				agentDir: "/agent",
				provider: "anthropic",
				model: "claude-opus",
				extensionPaths: [],
			},
			{
				repoDir: "/repo",
				agentDir: "/agent",
				provider: "claude-code",
				model: "opus",
				extensionPaths: ["/ext.ts"],
			},
		]);
		expect(renderStatus(result)).toBe(
			[
				"Agent folder: /agent",
				"anthropic [seats: opus, sonnet]: logged in (oauth, stored credential)",
				"claude-code [seats: cc]: not logged in. Log in the way its extension documents",
				"  error: claude CLI missing",
			].join("\n"),
		);
	});
});
