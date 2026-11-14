// These tests run Pi's real SDK from node_modules against fixture extensions
// that register providers. A fake SDK would only restate the ordering
// assumption under test: that a provider is visible before its extension loads.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagnoseReadiness } from "../src/config/readiness.js";
import { createSdkSeatSession } from "../src/seat/sdk-session.js";
import { createConfinementGuard } from "../src/seat/seat-extension.js";

const fixtures = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"extension-provider",
);
const PROVIDER_EXTENSION = path.join(fixtures, "provider-extension.ts");
const OTHER_EXTENSION = path.join(fixtures, "other-extension.ts");
const BROKEN_EXTENSION = path.join(fixtures, "broken-extension.ts");
const REJECTED_EXTENSION = path.join(
	fixtures,
	"rejected-registration-extension.ts",
);
const THROWING_EXTENSION = path.join(fixtures, "throwing-check-extension.ts");
const HANGING_EXTENSION = path.join(fixtures, "hanging-check-extension.ts");
const HANGING_LOAD_EXTENSION = path.join(fixtures, "hanging-load-extension.ts");
const PROVIDER = "review-panel-fixture";
const UNAUTHED_PROVIDER = "review-panel-fixture-unauthed";
const THROWING_PROVIDER = "review-panel-fixture-throwing";
const HANGING_PROVIDER = "review-panel-fixture-hanging";
const MODEL = "fixture-model";

type LoadCounter = { __reviewPanelFixtureLoads?: number };

let root = "";
let agentDir = "";

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "review-panel-extension-provider-"));
	agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// Keep the owner's auth.json and models.json out of these tests.
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

type Row = {
	id: string;
	provider: string;
	model?: string;
	extraExtensionPaths?: string[];
};

async function readiness(
	rows: Row[],
	options: {
		env?: Record<string, string>;
		inspectionTimeoutMs?: number;
	} = {},
) {
	const repoDir = path.join(root, "repo");
	mkdirSync(repoDir, { recursive: true });
	const configPath = path.join(root, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			roster: rows.map((row) => ({ ...row, model: row.model ?? MODEL })),
			defaults: { seats: [rows[0].id] },
		}),
	);
	return diagnoseReadiness({
		repoDir,
		env: {
			...options.env,
			PI_REVIEW_PANEL_CONFIG: configPath,
			PI_CODING_AGENT_DIR: agentDir,
		},
		home: path.join(root, "home"),
		inspectionTimeoutMs: options.inspectionTimeoutMs,
	});
}

function modelRows(provider: string) {
	return [
		{
			prerequisite: `model ${provider}/${MODEL}`,
			remediation: `Configure the exact Pi model "${provider}/${MODEL}".`,
		},
		{
			prerequisite: `authentication ${provider}`,
			remediation: `Authenticate the Pi provider "${provider}" for the configured model.`,
		},
	];
}

describe("readiness for a provider registered by a seat extension", () => {
	it("reports ready when the row's own extension registers the provider", async () => {
		const report = await readiness([
			{
				id: "fixture",
				provider: PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION],
			},
		]);

		expect(report).toEqual({ ready: true, rows: [] });
	});

	it("reports the model rows when the row loads no extension", async () => {
		const report = await readiness([{ id: "bare", provider: PROVIDER }]);

		expect(report).toEqual({ ready: false, rows: modelRows(PROVIDER) });
	});

	it("does not let another row's extension satisfy a row", async () => {
		const report = await readiness([
			{
				id: "owner",
				provider: PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION],
			},
			{
				id: "borrower",
				provider: PROVIDER,
				extraExtensionPaths: [OTHER_EXTENSION],
			},
		]);

		expect(report).toEqual({ ready: false, rows: modelRows(PROVIDER) });
	});

	it("reports authentication when the provider's own check says not configured", async () => {
		const report = await readiness([
			{
				id: "unauthed",
				provider: UNAUTHED_PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION],
			},
		]);

		expect(report).toEqual({
			ready: false,
			rows: [modelRows(UNAUTHED_PROVIDER)[1]],
		});
	});

	it("names an extension that fails to load", async () => {
		const report = await readiness([
			{
				id: "broken",
				provider: PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION, BROKEN_EXTENSION],
			},
		]);

		expect(report.ready).toBe(false);
		expect(report.rows).toContainEqual({
			prerequisite: `extension ${BROKEN_EXTENSION}`,
			remediation: expect.stringContaining(
				"review-panel fixture extension refuses to load",
			),
		});
	});

	it("names an extension whose provider registration Pi rejects", async () => {
		// The extension loads; Pi rejects its registration while applying it to
		// the runtime, so the failure arrives as a services diagnostic.
		const report = await readiness([
			{
				id: "rejected",
				provider: PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION, REJECTED_EXTENSION],
			},
		]);

		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: `extension ${REJECTED_EXTENSION}`,
					remediation: `Fix the configured extension at "${REJECTED_EXTENSION}", which failed to load: Provider id must not be empty.`,
				},
			],
		});
	});

	it("treats a provider check that throws as an authentication failure and keeps extension rows", async () => {
		const report = await readiness([
			{
				id: "throwing",
				provider: THROWING_PROVIDER,
				extraExtensionPaths: [THROWING_EXTENSION, BROKEN_EXTENSION],
			},
		]);

		expect(report.ready).toBe(false);
		expect(report.rows.map((row) => row.prerequisite)).toEqual([
			`extension ${BROKEN_EXTENSION}`,
			`authentication ${THROWING_PROVIDER}`,
		]);
	});

	it("names the row's extensions when its check does not finish within the bound, and inspects later rows", async () => {
		const report = await readiness(
			[
				{
					id: "hanging",
					provider: HANGING_PROVIDER,
					extraExtensionPaths: [PROVIDER_EXTENSION, HANGING_EXTENSION],
				},
				{ id: "bare", provider: PROVIDER },
			],
			// The bound also covers the healthy row, which loads Pi's real SDK:
			// it must be long enough for that under a loaded test run.
			{ inspectionTimeoutMs: 3_000 },
		);

		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: `readiness check ${HANGING_PROVIDER}/${MODEL} (${PROVIDER_EXTENSION}, ${HANGING_EXTENSION})`,
					remediation: `The readiness check for "${HANGING_PROVIDER}/${MODEL}" timed out after 3 s while loading its extensions (${PROVIDER_EXTENSION}, ${HANGING_EXTENSION}) and checking provider auth. Fix or remove the extension that does not finish.`,
				},
				...modelRows(PROVIDER),
			],
		});
	});

	it("gives each timed-out row for the same provider/model its own row naming its own extensions", async () => {
		const report = await readiness(
			[
				{
					id: "hanging-with-provider",
					provider: HANGING_PROVIDER,
					extraExtensionPaths: [PROVIDER_EXTENSION, HANGING_EXTENSION],
				},
				{
					id: "hanging-alone",
					provider: HANGING_PROVIDER,
					extraExtensionPaths: [HANGING_EXTENSION],
				},
			],
			{ inspectionTimeoutMs: 200 },
		);

		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: `readiness check ${HANGING_PROVIDER}/${MODEL} (${PROVIDER_EXTENSION}, ${HANGING_EXTENSION})`,
					remediation: `The readiness check for "${HANGING_PROVIDER}/${MODEL}" timed out after 0.2 s while loading its extensions (${PROVIDER_EXTENSION}, ${HANGING_EXTENSION}) and checking provider auth. Fix or remove the extension that does not finish.`,
				},
				{
					prerequisite: `readiness check ${HANGING_PROVIDER}/${MODEL} (${HANGING_EXTENSION})`,
					remediation: `The readiness check for "${HANGING_PROVIDER}/${MODEL}" timed out after 0.2 s while loading its extensions (${HANGING_EXTENSION}) and checking provider auth. Fix or remove the extension that does not finish.`,
				},
			],
		});
	});

	it("bounds an extension whose load never settles, names it, and inspects later rows", async () => {
		const report = await readiness(
			[
				{
					id: "hanging-load",
					provider: PROVIDER,
					extraExtensionPaths: [PROVIDER_EXTENSION, HANGING_LOAD_EXTENSION],
				},
				{ id: "bare", provider: PROVIDER },
			],
			{ inspectionTimeoutMs: 3_000 },
		);

		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: `readiness check ${PROVIDER}/${MODEL} (${PROVIDER_EXTENSION}, ${HANGING_LOAD_EXTENSION})`,
					remediation: `The readiness check for "${PROVIDER}/${MODEL}" timed out after 3 s while loading its extensions (${PROVIDER_EXTENSION}, ${HANGING_LOAD_EXTENSION}) and checking provider auth. Fix or remove the extension that does not finish.`,
				},
				...modelRows(PROVIDER),
			],
		});
	});

	it("honours a built-in provider key supplied only through the readiness env", async () => {
		vi.stubEnv("OPENAI_API_KEY", undefined);

		const report = await readiness(
			[{ id: "openai", provider: "openai", model: "gpt-4o" }],
			{ env: { OPENAI_API_KEY: "sk-review-panel-fixture" } },
		);

		expect(report).toEqual({ ready: true, rows: [] });
	});

	it("honours an env-only key for a built-in provider that models.json overlays", async () => {
		// Any models.json entry makes Pi compose the built-in provider with its
		// own auth check, which reads only the process environment.
		vi.stubEnv("OPENAI_API_KEY", undefined);
		writeFileSync(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: { openai: { baseUrl: "https://example.invalid/v1" } },
			}),
		);

		const report = await readiness(
			[{ id: "openai", provider: "openai", model: "gpt-4o" }],
			{ env: { OPENAI_API_KEY: "sk-review-panel-fixture" } },
		);

		expect(report).toEqual({ ready: true, rows: [] });
	});

	it("keeps the missing-path row without trying to load the extension", async () => {
		const missing = path.join(root, "missing-extension.ts");
		const report = await readiness([
			{
				id: "missing",
				provider: PROVIDER,
				extraExtensionPaths: [PROVIDER_EXTENSION, missing],
			},
		]);

		expect(report.rows).toContainEqual({
			prerequisite: `extension ${missing}`,
			remediation: `Install or correct the configured extension at "${missing}".`,
		});
		expect(
			report.rows.filter((row) => row.prerequisite === `extension ${missing}`),
		).toHaveLength(1);
	});
});

describe("seat session for a provider registered by a seat extension", () => {
	function seatSpec(provider: string, extraExtensionPaths: string[]) {
		return {
			provider,
			model: MODEL,
			lens: "correctness",
			lensPrompt: "Review the change.",
			baseRef: "abc123",
			worktree: root,
			extraExtensionPaths,
		};
	}

	async function realSdk() {
		const moduleName = "@earendil-works/pi-coding-agent";
		return (await import(moduleName)) as Record<string, unknown>;
	}

	it("resolves the model after loading the extension and hands the same loader and runtime to the session", async () => {
		const sdk = await realSdk();
		const counter = globalThis as LoadCounter;
		const loadsBefore = counter.__reviewPanelFixtureLoads ?? 0;
		const sessionOptions: Array<Record<string, unknown>> = [];
		const createAgentSession = sdk.createAgentSession as (
			options: Record<string, unknown>,
		) => Promise<{ session: { dispose: () => void } }>;

		const result = await createSdkSeatSession({
			spec: seatSpec(PROVIDER, [PROVIDER_EXTENSION]),
			tools: [{ name: "submit_findings" }],
			confinementGuard: createConfinementGuard({ worktree: root }),
			sdk: {
				...sdk,
				// Call through to the real session so a reload there would show
				// in the load counter below.
				createAgentSession: async (options: Record<string, unknown>) => {
					sessionOptions.push(options);
					return createAgentSession(options);
				},
			} as never,
		});

		result.session.dispose();
		expect(sessionOptions).toHaveLength(1);
		const options = sessionOptions[0] as {
			model: { provider: string; id: string };
			modelRuntime: { getModel: (p: string, m: string) => unknown };
			resourceLoader: {
				getExtensions: () => { extensions: Array<{ path: string }> };
			};
		};
		expect(options.model).toMatchObject({ provider: PROVIDER, id: MODEL });
		// The session's runtime is the one the extension registered into.
		expect(options.modelRuntime.getModel(PROVIDER, MODEL)).toBe(options.model);
		// The session's loader is the one that loaded the extension, once.
		expect(
			options.resourceLoader
				.getExtensions()
				.extensions.map((extension) => extension.path),
		).toContain(PROVIDER_EXTENSION);
		expect(counter.__reviewPanelFixtureLoads).toBe(loadsBefore + 1);
	});

	it("fails the seat when the provider's own check says not configured", async () => {
		const sdk = await realSdk();

		await expect(
			createSdkSeatSession({
				spec: seatSpec(UNAUTHED_PROVIDER, [PROVIDER_EXTENSION]),
				tools: [{ name: "submit_findings" }],
				confinementGuard: createConfinementGuard({ worktree: root }),
				sdk: sdk as never,
			}),
		).rejects.toThrow(
			`seat model is not authenticated: ${UNAUTHED_PROVIDER}/${MODEL}`,
		);
	});

	it("fails the seat as unauthenticated when the provider's own check throws", async () => {
		const sdk = await realSdk();

		await expect(
			createSdkSeatSession({
				spec: seatSpec(THROWING_PROVIDER, [THROWING_EXTENSION]),
				tools: [{ name: "submit_findings" }],
				confinementGuard: createConfinementGuard({ worktree: root }),
				sdk: sdk as never,
			}),
		).rejects.toThrow(
			`seat model is not authenticated: ${THROWING_PROVIDER}/${MODEL}`,
		);
	});

	it("fails the seat before creating a session when Pi rejects an extension's provider registration", async () => {
		const sdk = await realSdk();
		let sessions = 0;

		await expect(
			createSdkSeatSession({
				spec: seatSpec(PROVIDER, [PROVIDER_EXTENSION, REJECTED_EXTENSION]),
				tools: [{ name: "submit_findings" }],
				confinementGuard: createConfinementGuard({ worktree: root }),
				sdk: {
					...sdk,
					createAgentSession: async () => {
						sessions += 1;
						throw new Error("the seat must not reach createAgentSession");
					},
				} as never,
			}),
		).rejects.toThrow(
			`seat extension failed to load: ${REJECTED_EXTENSION}: Provider id must not be empty.`,
		);
		expect(sessions).toBe(0);
	});

	it("fails the seat with a message that names an extension that fails to load", async () => {
		const sdk = await realSdk();

		await expect(
			createSdkSeatSession({
				spec: seatSpec(PROVIDER, [PROVIDER_EXTENSION, BROKEN_EXTENSION]),
				tools: [{ name: "submit_findings" }],
				confinementGuard: createConfinementGuard({ worktree: root }),
				sdk: sdk as never,
			}),
		).rejects.toThrow(BROKEN_EXTENSION);
	});
});
