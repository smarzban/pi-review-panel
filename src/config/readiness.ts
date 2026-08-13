// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import { type ConfigEnv, loadConfig } from "./load.js";
import type { Config } from "./schema.js";

/** One concrete setup prerequisite that prevents model work. */
export type ReadinessRow = {
	prerequisite: string;
	remediation: string;
};

/** A compact diagnostic result. Missing rows are the complete remediation list. */
export type ReadinessReport = {
	ready: boolean;
	rows: ReadinessRow[];
};

export type ModelInspection = { model: boolean; auth: boolean };

export type ReadinessInput = {
	repoDir: string;
	env: ConfigEnv;
	home: string;
	/** Test seam, production resolves the configured Pi model and provider auth. */
	inspectModel?: (provider: string, model: string) => Promise<ModelInspection>;
};

type ModelRuntimeLike = {
	getModel: (provider: string, model: string) => unknown;
	getAuth: (
		provider: string,
		overrides: { env: Record<string, string> },
	) => Promise<unknown>;
};

type ModelRuntimeModule = {
	ModelRuntime: {
		create: (options: {
			allowModelNetwork: false;
			authPath: string;
			modelsPath: string;
		}) => Promise<ModelRuntimeLike>;
	};
};

async function inspectConfiguredModels(
	rows: Array<{ provider: string; model: string }>,
	input: Pick<ReadinessInput, "env" | "home">,
): Promise<Map<string, ModelInspection>> {
	const moduleName = "@earendil-works/pi-coding-agent";
	const { ModelRuntime } = (await import(moduleName)) as ModelRuntimeModule;
	const agentDir =
		input.env.PI_CODING_AGENT_DIR ?? path.join(input.home, ".pi", "agent");
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
	});
	const authEnv = Object.fromEntries(
		Object.entries(input.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const result = new Map<string, ModelInspection>();
	for (const row of rows) {
		const key = `${row.provider}\u0000${row.model}`;
		if (result.has(key)) {
			continue;
		}
		result.set(key, {
			model: runtime.getModel(row.provider, row.model) !== undefined,
			auth:
				(await runtime.getAuth(row.provider, { env: authEnv })) !== undefined,
		});
	}
	return result;
}

/**
 * Checks setup only. It neither starts a reviewer session nor executes a
 * scanner/project-check command. The caller receives exactly one row for each
 * unavailable prerequisite and can repair setup before the first launch.
 */
export async function diagnoseReadiness(
	input: ReadinessInput,
): Promise<ReadinessReport> {
	let config: Config;
	try {
		config = loadConfig({
			repoDir: input.repoDir,
			env: input.env,
			home: input.home,
		});
	} catch {
		return {
			ready: false,
			rows: [
				{
					prerequisite: "configuration",
					remediation:
						"Create the outside-repository config shown in the configuration guide.",
				},
			],
		};
	}

	let inspections: Map<string, ModelInspection> | undefined;
	if (input.inspectModel === undefined) {
		try {
			inspections = await inspectConfiguredModels(config.roster, input);
		} catch {
			// A missing runtime, credential store, or auth inspection is a setup
			// failure, not a tool failure. Each configured pair receives its
			// concrete model/auth remediation below.
			inspections = new Map();
		}
	}
	const rows: ReadinessRow[] = [];
	const seenModels = new Set<string>();
	for (const roster of config.roster) {
		const key = `${roster.provider}\u0000${roster.model}`;
		if (seenModels.has(key)) {
			continue;
		}
		seenModels.add(key);
		let inspection: ModelInspection | undefined;
		try {
			inspection = input.inspectModel
				? await input.inspectModel(roster.provider, roster.model)
				: inspections?.get(key);
		} catch {
			inspection = undefined;
		}
		if (inspection?.model !== true) {
			rows.push({
				prerequisite: `model ${roster.provider}/${roster.model}`,
				remediation: `Configure the exact Pi model "${roster.provider}/${roster.model}".`,
			});
		}
		if (inspection?.auth !== true) {
			rows.push({
				prerequisite: `authentication ${roster.provider}`,
				remediation: `Authenticate the Pi provider "${roster.provider}" for the configured model.`,
			});
		}
	}

	const seenExtensions = new Set<string>();
	for (const roster of config.roster) {
		for (const extension of roster.extraExtensionPaths ?? []) {
			if (seenExtensions.has(extension)) {
				continue;
			}
			seenExtensions.add(extension);
			if (!existsSync(extension)) {
				rows.push({
					prerequisite: `extension ${extension}`,
					remediation: `Install or correct the configured extension at "${extension}".`,
				});
			}
		}
	}

	return { ready: rows.length === 0, rows };
}
