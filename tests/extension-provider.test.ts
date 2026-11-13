// These tests run Pi's real SDK from node_modules against fixture extensions
// that register providers. A fake SDK would only restate the ordering
// assumption under test: that a provider is visible before its extension loads.

// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// @ts-expect-error The initial scaffold has no Node type declarations.
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
const PROVIDER = "review-panel-fixture";
const UNAUTHED_PROVIDER = "review-panel-fixture-unauthed";
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

type Row = { id: string; provider: string; extraExtensionPaths?: string[] };

async function readiness(rows: Row[]) {
	const repoDir = path.join(root, "repo");
	mkdirSync(repoDir, { recursive: true });
	const configPath = path.join(root, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			roster: rows.map((row) => ({ model: MODEL, ...row })),
			defaults: { seats: [rows[0].id] },
		}),
	);
	return diagnoseReadiness({
		repoDir,
		env: {
			PI_REVIEW_PANEL_CONFIG: configPath,
			PI_CODING_AGENT_DIR: agentDir,
		},
		home: path.join(root, "home"),
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
		const session = {
			prompt: async () => undefined,
			abort: async () => undefined,
			dispose: () => undefined,
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
		};

		const result = await createSdkSeatSession({
			spec: seatSpec(PROVIDER, [PROVIDER_EXTENSION]),
			tools: [{ name: "submit_findings" }],
			confinementGuard: createConfinementGuard({ worktree: root }),
			sdk: {
				...sdk,
				createAgentSession: async (options: Record<string, unknown>) => {
					sessionOptions.push(options);
					return { session };
				},
			} as never,
		});

		expect(result.session).toBe(session);
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
