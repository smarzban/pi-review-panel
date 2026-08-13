// @ts-expect-error The initial scaffold has no Node type declarations.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import type { Config, ConfigError } from "./schema.js";
import { validateConfig } from "./schema.js";

export type ConfigEnv = Record<string, string | undefined>;

export const EXAMPLE_CONFIG = `{
  "roster": [
    {"id":"terra","provider":"openai-codex","model":"gpt-5.6-terra"},
    {"id":"claude","provider":"anthropic","model":"claude-opus-5","extraExtensionPaths":["/absolute/provider-extension.ts"]}
  ],
  "defaults": {
    "seats":["terra","claude"],
    "seatBudgetMs":1200000
  }
}`;

export function resolveConfigPath({
	env,
	home,
}: {
	env: ConfigEnv;
	home: string;
}): string {
	const override = env.PI_REVIEW_PANEL_CONFIG;
	if (override === undefined || override === "") {
		return path.join(home, ".pi-review-panel", "config.json");
	}
	if (!path.isAbsolute(override)) {
		throw new Error(
			`Config override PI_REVIEW_PANEL_CONFIG must be an absolute path, got "${override}"`,
		);
	}
	return path.resolve(override);
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	// Equality counts as inside: a config path that IS the repository root is
	// not outside the reviewed repository. Segment-aware containment: a true
	// parent escape is exactly ".." or begins "..<sep>", while dotted child
	// names such as "..config" are ordinary descendants and stay inside.
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function missingConfigError(selected: string): Error {
	return new Error(
		`No config file at "${selected}". Create one with the example below:\n\n${EXAMPLE_CONFIG}`,
	);
}

function causeDetail(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function loadConfig({
	env,
	home,
	repoDir,
}: {
	env: ConfigEnv;
	home: string;
	repoDir: string;
}): Config {
	const selected = resolveConfigPath({ env, home });

	const repoRoot = path.resolve(repoDir);
	if (isInside(repoRoot, path.resolve(selected))) {
		throw new Error(
			`Config path "${selected}" is inside the reviewed repository "${repoDir}" and is refused`,
		);
	}

	try {
		lstatSync(selected);
	} catch (error) {
		if (isEnoent(error)) {
			throw missingConfigError(selected);
		}
		throw new Error(
			`Could not access config "${selected}": ${causeDetail(error)}`,
		);
	}

	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(repoDir);
	} catch (error) {
		throw new Error(
			`Could not resolve the reviewed repository "${repoDir}": ${causeDetail(error)}`,
		);
	}
	let canonicalTarget: string;
	try {
		canonicalTarget = realpathSync(selected);
	} catch (error) {
		throw new Error(
			`Could not resolve config path "${selected}": ${causeDetail(error)}`,
		);
	}

	if (isInside(canonicalRoot, canonicalTarget)) {
		throw new Error(
			`Config path "${selected}" resolves inside the reviewed repository "${repoDir}" and is refused`,
		);
	}

	let bytes: string;
	try {
		bytes = readFileSync(selected, "utf8");
	} catch (error) {
		throw new Error(
			`Could not read config "${selected}": ${causeDetail(error)}`,
		);
	}

	let document: unknown;
	try {
		document = JSON.parse(bytes);
	} catch (error) {
		throw new Error(
			`Failed to parse config "${selected}": ${causeDetail(error)}`,
		);
	}

	const result = validateConfig(document);
	if (!result.ok) {
		const causes = result.errors
			.map((error: ConfigError) => `${error.field} ${error.message}`)
			.join("; ");
		throw new Error(`Config "${selected}" is invalid: ${causes}`);
	}

	return result.config;
}
