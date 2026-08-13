// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	EXAMPLE_CONFIG,
	loadConfig,
	resolveConfigPath,
} from "../src/config/load.js";
import { validateConfig } from "../src/config/schema.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "config-load-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
	it("resolves the home default when PI_REVIEW_PANEL_CONFIG is unset", () => {
		const home = path.join(root, "home");

		expect(resolveConfigPath({ env: {}, home })).toBe(
			path.join(home, ".pi-review-panel", "config.json"),
		);
	});

	it("resolves the home default when PI_REVIEW_PANEL_CONFIG is empty", () => {
		const home = path.join(root, "home");

		expect(
			resolveConfigPath({ env: { PI_REVIEW_PANEL_CONFIG: "" }, home }),
		).toBe(path.join(home, ".pi-review-panel", "config.json"));
	});

	it("accepts an absolute PI_REVIEW_PANEL_CONFIG override", () => {
		const home = path.join(root, "home");
		const override = path.join(root, "custom", "config.json");

		expect(
			resolveConfigPath({ env: { PI_REVIEW_PANEL_CONFIG: override }, home }),
		).toBe(path.resolve(override));
	});

	it("refuses a relative PI_REVIEW_PANEL_CONFIG override", () => {
		const home = path.join(root, "home");

		let error: unknown;
		try {
			resolveConfigPath({
				env: { PI_REVIEW_PANEL_CONFIG: "relative/config.json" },
				home,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("absolute");
	});
});

describe("loadConfig", () => {
	it("refuses a lexical in-repository config path before reading it", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		const inRepo = path.join(repoDir, "nested", "config.json");

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: inRepo }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("inside the reviewed repository");
		expect(message).toContain(inRepo);
		expect(message).not.toContain("No config");
	});

	it("refuses an external symlink whose target is inside the repository before reading it", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const repoFile = path.join(repoDir, "evil-config.json");
		writeFileSync(repoFile, EXAMPLE_CONFIG);
		const link = path.join(outside, "config.json");
		symlinkSync(repoFile, link);

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: link }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("resolves inside the reviewed repository");
		expect(message).not.toContain("No config");
	});

	it("accepts and parses an outside-repository config file", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const configPath = path.join(outside, "config.json");
		writeFileSync(configPath, EXAMPLE_CONFIG);

		expect(
			loadConfig({
				env: { PI_REVIEW_PANEL_CONFIG: configPath },
				home,
				repoDir,
			}),
		).toEqual(JSON.parse(EXAMPLE_CONFIG));
	});

	it("refuses a config that does not parse, naming the path and the cause", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const configPath = path.join(outside, "config.json");
		writeFileSync(configPath, '{ "roster": ');

		let error: unknown;
		try {
			loadConfig({
				env: { PI_REVIEW_PANEL_CONFIG: configPath },
				home,
				repoDir,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Failed to parse config");
		expect(message).toContain(configPath);
	});

	it("refuses an invalid config whole, naming every cause", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const configPath = path.join(outside, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				roster: [
					{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
				],
				defaults: {},
			}),
		);

		let error: unknown;
		try {
			loadConfig({
				env: { PI_REVIEW_PANEL_CONFIG: configPath },
				home,
				repoDir,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("defaults.seats");
		expect(message).toContain("is required");
	});

	it("refuses a missing config naming the resolved path", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		const resolved = path.join(home, ".pi-review-panel", "config.json");

		let error: unknown;
		try {
			loadConfig({ env: {}, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(resolved);
	});

	it("embeds EXAMPLE_CONFIG in the missing refusal and the embedded bytes validate", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });

		let error: unknown;
		try {
			loadConfig({ env: {}, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain(EXAMPLE_CONFIG);

		const embedded = message.slice(message.indexOf(EXAMPLE_CONFIG));
		const parsed = JSON.parse(embedded) as unknown;
		const result = validateConfig(parsed);
		expect(result.ok).toBe(true);
	});

	it("refuses a valid config under a dotted first segment of the repository before reading it", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const dottedDir = path.join(repoDir, "..config");
		mkdirSync(dottedDir, { recursive: true });
		const inRepo = path.join(dottedDir, "config.json");
		writeFileSync(inRepo, EXAMPLE_CONFIG);

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: inRepo }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("inside the reviewed repository");
		expect(message).toContain(inRepo);
		expect(message).not.toContain("No config");
	});

	it("refuses an external symlink whose canonical target sits under a dotted first segment of the repository", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		const dottedDir = path.join(repoDir, "..config");
		mkdirSync(dottedDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const repoFile = path.join(dottedDir, "config.json");
		writeFileSync(repoFile, EXAMPLE_CONFIG);
		const link = path.join(outside, "config.json");
		symlinkSync(repoFile, link);

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: link }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("resolves inside the reviewed repository");
		expect(message).not.toContain("No config");
	});

	it("refuses a config path equal to the repository root before reading it", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: repoDir }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("inside the reviewed repository");
		expect(message).toContain(repoDir);
		expect(message).not.toContain("No config");
		expect(message).not.toContain("EISDIR");
	});

	it("refuses an external symlink whose target is the repository root", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const link = path.join(outside, "config.json");
		symlinkSync(repoDir, link);

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: link }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("resolves inside the reviewed repository");
		expect(message).not.toContain("No config");
		expect(message).not.toContain("EISDIR");
	});

	it("reports a missing config only for ENOENT and names other access failures", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		mkdirSync(repoDir, { recursive: true });
		// A NUL byte makes lstatSync fail deterministically with a non-ENOENT
		// argument error on every platform Node supports, no permissions needed.
		const hostile = path.join(root, "outside", "bad\u0000config.json");

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: hostile }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Could not access config");
		expect(message).toContain(hostile);
		expect(message).not.toContain("No config file");
		expect(message).not.toContain(EXAMPLE_CONFIG);
	});

	it("names the path and cause when the config path cannot be resolved", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		// lstat succeeds on a symlink even when its target is gone; realpath then
		// fails deterministically with ENOENT, no permissions involved.
		const link = path.join(outside, "config.json");
		symlinkSync(path.join(outside, "nowhere", "target.json"), link);

		let error: unknown;
		try {
			loadConfig({ env: { PI_REVIEW_PANEL_CONFIG: link }, home, repoDir });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Could not resolve config path");
		expect(message).toContain(link);
		expect(message).toContain("ENOENT");
		expect(message).not.toContain("No config file");
	});

	it("names the path and cause when the repository root cannot be resolved", () => {
		const home = path.join(root, "home");
		const outside = path.join(root, "outside");
		mkdirSync(outside, { recursive: true });
		const configPath = path.join(outside, "config.json");
		writeFileSync(configPath, EXAMPLE_CONFIG);
		const missingRepo = path.join(root, "repo", "does-not-exist");

		let error: unknown;
		try {
			loadConfig({
				env: { PI_REVIEW_PANEL_CONFIG: configPath },
				home,
				repoDir: missingRepo,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Could not resolve the reviewed repository");
		expect(message).toContain(missingRepo);
		expect(message).toContain("ENOENT");
	});

	it("refuses a config that still names loopPolicy", () => {
		const home = path.join(root, "home");
		const repoDir = path.join(root, "repo");
		const outside = path.join(root, "outside");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		const configPath = path.join(outside, "config.json");
		const document = {
			roster: [
				{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
			],
			defaults: { seats: ["terra"], lenses: ["correctness"] },
			loopPolicy: { auditSeat: "terra" },
		};
		writeFileSync(configPath, JSON.stringify(document));

		let error: unknown;
		try {
			loadConfig({
				env: { PI_REVIEW_PANEL_CONFIG: configPath },
				home,
				repoDir,
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("loopPolicy");
	});
});
