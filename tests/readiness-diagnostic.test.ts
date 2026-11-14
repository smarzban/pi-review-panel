import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diagnoseReadiness } from "../src/config/readiness.js";
import {
	MAX_PRESENTATION_BYTES,
	renderReadiness,
	truncateCodePoints,
} from "../src/tool/review-presentation.js";

let root = "";

afterEach(() => {
	if (root !== "") {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function setup(config: unknown): { repoDir: string; configPath: string } {
	root = mkdtempSync(path.join(tmpdir(), "review-panel-readiness-"));
	const repoDir = path.join(root, "repo");
	const configPath = path.join(root, "config.json");
	mkdirSync(repoDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify(config));
	return { repoDir, configPath };
}

const baseConfig = {
	roster: [
		{
			id: "terra",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			extraExtensionPaths: ["/missing/provider-extension.ts"],
		},
	],
	defaults: { seats: ["terra"], lenses: ["correctness"] },
};

describe("readiness diagnostic", () => {
	it("cuts appended text by whole code points, never splitting a character", () => {
		const text = `${"a".repeat(1_499)}😀b`;
		expect(truncateCodePoints(text, 1_500)).toBe(`${"a".repeat(1_499)}😀…`);
		expect(truncateCodePoints("short", 1_500)).toBe("short");
	});

	it("keeps room for text appended after the report, so the whole reply stays under the cap", () => {
		const report = {
			ready: false,
			rows: Array.from({ length: 100 }, (_, index) => ({
				prerequisite: `prerequisite-${index}-${"x".repeat(500)}`,
				remediation: `remediation-${index}-${"y".repeat(1_000)}`,
			})),
		};
		const appended = `\n## Warnings\n- ${"w".repeat(1_500)}`;
		const reserve = new TextEncoder().encode(appended).length;
		const text = `${renderReadiness(report, reserve)}${appended}`;
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
			MAX_PRESENTATION_BYTES,
		);
		expect(
			new TextEncoder().encode(renderReadiness(report)).length,
		).toBeGreaterThan(MAX_PRESENTATION_BYTES - reserve);
	});

	it("keeps ready status and bounded actionable rows under the 16 KiB public cap", () => {
		const text = renderReadiness({
			ready: false,
			rows: Array.from({ length: 100 }, (_, index) => ({
				prerequisite: `prerequisite-${index}-${"x".repeat(500)}`,
				remediation: `remediation-${index}-${"y".repeat(1_000)}`,
			})),
		});
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
			MAX_PRESENTATION_BYTES,
		);
		expect(text).toContain("# Review panel readiness");
		expect(text).toContain("- Status: needs setup");
		expect(text).toContain("prerequisite-0-");
		expect(text).toContain("additional remediation row(s) omitted");
	});
	it("keeps accepted remediation rows when the omitted-count line consumes the remaining slack", () => {
		const rows = [
			...Array.from({ length: 10 }, (_, index) => ({
				prerequisite: `p${index}-${"p".repeat(500)}`,
				remediation: `r${index}-${"r".repeat(1_000)}`,
			})),
			{
				prerequisite: `narrow-${"n".repeat(240)}`,
				remediation: "n".repeat(1_000),
			},
			{ prerequisite: "omitted", remediation: "must remain omitted" },
		];
		const text = renderReadiness({ ready: false, rows });

		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
			MAX_PRESENTATION_BYTES,
		);
		expect(text).toContain("p0-");
		expect(text).toContain("additional remediation row(s) omitted");
		expect(text).not.toContain("Readiness detail exceeded");
	});

	it("reports exactly one actionable remediation per missing prerequisite without a model launch", async () => {
		const { repoDir, configPath } = setup(baseConfig);
		let modelChecks = 0;

		const report = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: configPath },
			home: path.join(root, "home"),
			inspectModel: async () => {
				modelChecks += 1;
				return { model: false, auth: false };
			},
		});

		expect(modelChecks).toBe(1);
		expect(report.ready).toBe(false);
		expect(report.rows).toEqual([
			{
				prerequisite: "model openai-codex/gpt-5.6-terra",
				remediation:
					'Configure the exact Pi model "openai-codex/gpt-5.6-terra".',
			},
			{
				prerequisite: "authentication openai-codex",
				remediation:
					'Authenticate the Pi provider "openai-codex" for the configured model.',
			},
			{
				prerequisite: "extension /missing/provider-extension.ts",
				remediation:
					'Install or correct the configured extension at "/missing/provider-extension.ts".',
			},
		]);
	});

	it("does not require repair-only commands for a ready review-only start", async () => {
		const reviewOnlyConfig = {
			...baseConfig,
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
			],
		};
		const { repoDir, configPath } = setup(reviewOnlyConfig);

		const report = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: configPath },
			home: path.join(root, "home"),
			inspectModel: async () => ({ model: true, auth: true }),
		});

		expect(report).toEqual({ ready: true, rows: [] });
	});

	it("turns model inspection failures into model and authentication remediations", async () => {
		const completeConfig = {
			...baseConfig,
			roster: [
				{
					id: "terra",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
			],
		};
		const { repoDir, configPath } = setup(completeConfig);

		const report = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: configPath },
			home: path.join(root, "isolated-home"),
			inspectModel: async () => {
				throw new Error("unavailable credential storage");
			},
		});

		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: "model openai-codex/gpt-5.6-terra",
					remediation:
						'Configure the exact Pi model "openai-codex/gpt-5.6-terra".',
				},
				{
					prerequisite: "authentication openai-codex",
					remediation:
						'Authenticate the Pi provider "openai-codex" for the configured model.',
				},
			],
		});
	});

	it("names the invalid field and its allowed values for a config that does not validate", async () => {
		root = mkdtempSync(path.join(tmpdir(), "review-panel-readiness-invalid-"));
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		const configPath = path.join(root, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				roster: [{ id: "a", provider: "p", model: "m" }],
				defaults: { seats: ["a"], prComment: "sometimes" },
			}),
		);
		const report = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: configPath },
			home: path.join(root, "home"),
			inspectModel: async () => ({ model: true, auth: true }),
		});
		expect(report.ready).toBe(false);
		expect(report.rows).toHaveLength(1);
		expect(report.rows[0]?.prerequisite).toBe("configuration");
		expect(report.rows[0]?.remediation).toContain(
			'defaults.prComment must be "auto" or "ownerApproved"',
		);
	});

	it("reports the configuration failure alone and does not inspect a model", async () => {
		root = mkdtempSync(path.join(tmpdir(), "review-panel-readiness-config-"));
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		let modelChecks = 0;

		const report = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: path.join(root, "missing.json") },
			home: path.join(root, "home"),
			inspectModel: async () => {
				modelChecks += 1;
				return { model: true, auth: true };
			},
		});

		expect(modelChecks).toBe(0);
		expect(report).toEqual({
			ready: false,
			rows: [
				{
					prerequisite: "configuration",
					remediation:
						"Create the outside-repository config shown in the configuration guide.",
				},
			],
		});
	});

	it("names the problem for a config that is not JSON, or sits inside the repository", async () => {
		root = mkdtempSync(path.join(tmpdir(), "review-panel-readiness-bad-"));
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		const broken = path.join(root, "config.json");
		writeFileSync(broken, '{"roster": [ "secret-ish text');
		const notJson = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: broken },
			home: path.join(root, "home"),
			inspectModel: async () => ({ model: true, auth: true }),
		});
		expect(notJson.rows).toEqual([
			{
				prerequisite: "configuration",
				remediation: "Fix the owner config: it is not valid JSON.",
			},
		]);
		const inside = path.join(repoDir, "config.json");
		writeFileSync(inside, "{}");
		const inRepo = await diagnoseReadiness({
			repoDir,
			env: { PI_REVIEW_PANEL_CONFIG: inside },
			home: path.join(root, "home"),
			inspectModel: async () => ({ model: true, auth: true }),
		});
		expect(inRepo.rows).toEqual([
			{
				prerequisite: "configuration",
				remediation:
					"Move the owner config outside the reviewed repository; a config inside it is refused.",
			},
		]);
	});
});
