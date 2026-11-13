// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";

import {
	type ExtensionFailure,
	resolveSeatRuntime,
	type SeatServicesSdk,
} from "../seat/seat-runtime.js";
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

/**
 * One inspected roster key. `extensionFailures` names each configured
 * extension that failed to load or to register its providers.
 */
export type ModelInspection = {
	model: boolean;
	auth: boolean;
	extensionFailures?: ExtensionFailure[];
};

export type ReadinessInput = {
	repoDir: string;
	env: ConfigEnv;
	home: string;
	/** Test seam, production resolves the configured Pi model and provider auth. */
	inspectModel?: (
		provider: string,
		model: string,
		extensionPaths: readonly string[],
	) => Promise<ModelInspection>;
};

async function inspectConfiguredModel(
	provider: string,
	model: string,
	extensionPaths: readonly string[],
	input: Pick<ReadinessInput, "env" | "home" | "repoDir">,
): Promise<ModelInspection> {
	const moduleName = "@earendil-works/pi-coding-agent";
	const sdk = (await import(moduleName)) as SeatServicesSdk;
	const agentDir =
		input.env.PI_CODING_AGENT_DIR ?? path.join(input.home, ".pi", "agent");
	const authEnv = Object.fromEntries(
		Object.entries(input.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const runtime = await resolveSeatRuntime({
		sdk,
		cwd: input.repoDir,
		agentDir,
		provider,
		model,
		extensionPaths,
		authEnv,
	});
	return {
		model: runtime.model !== undefined,
		auth: runtime.authenticated,
		extensionFailures: runtime.extensionFailures,
	};
}

/**
 * Checks setup only. It neither starts a reviewer session, runs a model, nor
 * executes a scanner/project-check command. It does load each roster row's
 * configured `extraExtensionPaths`, exactly as that row's seat would, because
 * an extension can register the row's provider; that runs the extension's
 * code and its provider auth check (for example asking a provider CLI whether
 * it is logged in). The caller receives exactly one row for each unavailable
 * prerequisite and can repair setup before the first launch.
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

	const rows: ReadinessRow[] = [];
	const seenRows = new Set<string>();
	const push = (row: ReadinessRow): void => {
		if (!seenRows.has(row.prerequisite)) {
			seenRows.add(row.prerequisite);
			rows.push(row);
		}
	};
	const inspect = input.inspectModel ?? inspectConfiguredModel;

	// Each row is inspected with only its own extensions: a provider that row
	// A's extension registers must not make row B ready.
	const seenKeys = new Set<string>();
	for (const roster of config.roster) {
		const extensions = [
			...new Set((roster.extraExtensionPaths ?? []).filter(existsSync)),
		].sort();
		const key = [roster.provider, roster.model, ...extensions].join("\u0000");
		if (seenKeys.has(key)) {
			continue;
		}
		seenKeys.add(key);
		let inspection: ModelInspection | undefined;
		try {
			inspection = await inspect(
				roster.provider,
				roster.model,
				extensions,
				input,
			);
		} catch {
			// A missing runtime, credential store, or auth inspection is a setup
			// failure, not a tool failure. The pair receives its concrete
			// model/auth remediation below.
			inspection = undefined;
		}
		for (const failure of inspection?.extensionFailures ?? []) {
			push({
				prerequisite: `extension ${failure.extension}`,
				remediation: `Fix the configured extension at "${failure.extension}", which failed to load: ${failure.message}`,
			});
		}
		if (inspection?.model !== true) {
			push({
				prerequisite: `model ${roster.provider}/${roster.model}`,
				remediation: `Configure the exact Pi model "${roster.provider}/${roster.model}".`,
			});
		}
		if (inspection?.auth !== true) {
			push({
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
				push({
					prerequisite: `extension ${extension}`,
					remediation: `Install or correct the configured extension at "${extension}".`,
				});
			}
		}
	}

	return { ready: rows.length === 0, rows };
}
