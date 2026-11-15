/**
 * Setup without Pi: `auth providers`, `models` and `extension install | list
 * | remove`, against the agent folder in use. Everything that touches the Pi
 * SDK sits behind `SetupSdk` (the real one is in `sdk.ts`); this module
 * decides what to load, filters, and words the output.
 */
import path from "node:path";

import { READINESS_ROW_TIMEOUT_MS } from "../config/readiness.js";
import {
	type AgentDirChoice,
	describeAgentDir,
	piAgentDir,
} from "./agent-dir.js";
import { shown } from "./args.js";

export type ProviderLogin = "account" | "api-key";

export type ProviderRow = {
	id: string;
	name: string;
	/** The logins `review-panel auth login` offers for it; empty when none. */
	logins: ProviderLogin[];
	/** Configured now: a stored credential, an environment variable or models.json. */
	loggedIn: boolean;
	/** Where the configuration comes from, when it is configured. */
	how?: string;
};

export type CatalogModel = {
	provider: string;
	model: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	thinking: boolean;
	images: boolean;
	/** The provider passes its login check now. */
	available: boolean;
};

/** What one isolated runtime (no extension, or one package's) offers. */
export type ModelGroup = {
	/** Providers that this group's own extensions registered. */
	registeredProviders: string[];
	models: CatalogModel[];
	extensionFailures: { extension: string; message: string }[];
};

export type InstalledExtension = {
	/** The source as the agent folder's settings.json records it. */
	source: string;
	installedPath?: string;
	/** The settings entry narrows the package's resources (Pi's object form). */
	filtered: boolean;
	/** The package's extension entry files, for `extraExtensionPaths`. */
	entries: string[];
};

export type SetupSdk = {
	providers(agentDir: string): Promise<ProviderRow[]>;
	models(input: {
		agentDir: string;
		cwd: string;
		extensionPaths: readonly string[];
	}): Promise<ModelGroup>;
	listExtensions(input: { agentDir: string }): Promise<InstalledExtension[]>;
	installExtension(input: {
		agentDir: string;
		source: string;
		progress(line: string): void;
	}): Promise<InstalledExtension>;
	removeExtension(input: {
		agentDir: string;
		source: string;
		progress(line: string): void;
	}): Promise<boolean>;
};

/** A refusal the runner reports with exit code 1. */
export class SetupError extends Error {}

/**
 * Text with any credential an extension source may carry hidden: the user
 * info of every `scheme://user:token@host` URL, and the value of every query
 * parameter whose name looks like a secret (`token`, `key`, `secret`,
 * `password`, `auth`, `sig`, `credential`). Sources reach the package manager
 * as given; only what is printed is redacted.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, "$1***@")
		.replace(
			/([?&][^=&#\s]*(?:token|key|secret|passw|pwd|auth|sig|credential)[^=&#\s]*=)[^&#\s]*/gi,
			"$1***",
		);
}

function redactedExtension(entry: InstalledExtension): InstalledExtension {
	return {
		...entry,
		source: redactSecrets(entry.source),
		...(entry.installedPath === undefined
			? {}
			: { installedPath: redactSecrets(entry.installedPath) }),
	};
}

function folderLine(agentDir: AgentDirChoice): string {
	return `Agent folder: ${describeAgentDir(agentDir)}`;
}

/** Column text, padded; the last column is not padded. */
function table(rows: string[][]): string[] {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);
	return rows.map((row) =>
		row
			.map((cell, column) =>
				column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
			)
			.join("  ")
			.trimEnd(),
	);
}

// ----- auth providers -----

export type ProvidersResult = { agentDir: string; providers: ProviderRow[] };

export async function listProviders(input: {
	agentDir: AgentDirChoice;
	sdk: SetupSdk;
	signal?: AbortSignal;
}): Promise<ProvidersResult> {
	return {
		agentDir: input.agentDir.dir,
		providers: await untilAborted(
			input.sdk.providers(input.agentDir.dir),
			input.signal,
		),
	};
}

function loginText(logins: readonly ProviderLogin[]): string {
	if (logins.length === 0) {
		return "none";
	}
	return logins
		.map((login) => (login === "account" ? "account" : "API key"))
		.join(" or ");
}

function providerState(row: ProviderRow): string {
	if (!row.loggedIn) {
		return row.logins.length === 0 ? "not configured" : "not logged in";
	}
	const how = row.how === undefined ? "" : ` (${row.how})`;
	return row.how === "stored credential"
		? `logged in${how}`
		: `configured${how}`;
}

export function renderProviders(
	result: ProvidersResult,
	agentDir: AgentDirChoice,
): string {
	return [
		folderLine(agentDir),
		...table([
			["provider", "name", "login", "status"],
			...result.providers.map((row) => [
				row.id,
				row.name,
				loginText(row.logins),
				providerState(row),
			]),
		]),
		"",
		"Log in with:",
		"  review-panel auth login <provider>                      account sign-in (OAuth or a subscription), in a terminal",
		"  review-panel auth login <provider> --api-key < key-file  save an API key read from stdin",
		'A provider whose login is "none" is set up outside review-panel: an environment variable, or models.json in the agent folder.',
		"A provider that an extension registers (for example claude-code) logs in the way that extension documents; see review-panel extension list.",
		"Then: review-panel models lists the models you can put in the roster.",
	].join("\n");
}

// ----- models -----

export type ListedModel = CatalogModel & {
	/** The roster row's `extraExtensionPaths` this model needs; empty for none. */
	extensionPaths: string[];
	/** The installed package's source, or the `--extension` path. */
	extensionSource?: string;
};

export type RosterRowExample = {
	id: string;
	provider: string;
	model: string;
	extraExtensionPaths?: string[];
};

export type ModelsResult = {
	agentDir: string;
	models: ListedModel[];
	/** A ready-to-copy roster row for the first listed model. */
	rosterRow?: RosterRowExample;
	/** Extensions that failed or did not finish loading. */
	problems: string[];
	/** A provider was named and it is not logged in. */
	notLoggedIn?: { provider: string; extension: boolean };
	/** Nothing to list without a provider or --all: no login works. */
	noneAvailable?: boolean;
	search?: string;
};

type Group = {
	label?: string;
	extensionPaths: string[];
};

const TIMED_OUT = Symbol("timed out");

/**
 * `work`, or a rejection with the signal's reason as soon as it aborts. The
 * first Ctrl-C ends a setup command at once, even while an extension or the
 * package manager is still busy.
 */
export function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (signal === undefined) {
		return work;
	}
	if (signal.aborted) {
		return Promise.reject(signal.reason);
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => {
		if (onAbort !== undefined) {
			signal.removeEventListener("abort", onAbort);
		}
	});
}

function withinBound<T>(
	work: Promise<T>,
	ms: number,
	signal?: AbortSignal,
): Promise<T | typeof TIMED_OUT> {
	let timer: NodeJS.Timeout | undefined;
	// The timer stays referenced: an extension that awaits a promise that never
	// settles holds no handle, and an unreferenced timer would let Node end the
	// process with the top-level await unsettled instead of reporting it.
	const bound = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), ms);
	});
	return untilAborted(Promise.race([work, bound]), signal).finally(() =>
		clearTimeout(timer),
	);
}

/**
 * A local source (anything that is not `npm:`, `git:` or a URL) resolved from
 * `cwd`, as Pi resolves one from the folder it runs in. Others pass through.
 */
export function absoluteSource(source: string, cwd: string): string {
	const trimmed = source.trim();
	if (
		/^(npm|git|github|http|https|ssh|builtin):/.test(trimmed) ||
		/^git@/.test(trimmed)
	) {
		return trimmed;
	}
	return path.resolve(cwd, trimmed);
}

function matchesSearch(row: CatalogModel, search: string | undefined): boolean {
	if (search === undefined) {
		return true;
	}
	const haystack = `${row.provider} ${row.model} ${row.name}`.toLowerCase();
	return search
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word !== "")
		.every((word) => haystack.includes(word));
}

export async function listModels(input: {
	agentDir: AgentDirChoice;
	cwd: string;
	provider?: string;
	search?: string;
	all: boolean;
	extensions: readonly string[];
	sdk: SetupSdk;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<ModelsResult> {
	const timeoutMs = input.timeoutMs ?? READINESS_ROW_TIMEOUT_MS;
	const agentDir = input.agentDir.dir;
	const groups: Group[] = [{ extensionPaths: [] }];
	for (const installed of await untilAborted(
		input.sdk.listExtensions({ agentDir }),
		input.signal,
	)) {
		// Every installed package loads, because only loading it tells which
		// providers it registers (any id, a built-in's included); Pi loads them all
		// on every start too. Each entry loads on its own, as one roster row's
		// path would, so a model's roster row names only the entry that
		// registered its provider.
		const source = redactSecrets(installed.source);
		for (const entry of installed.entries) {
			const within =
				installed.installedPath === undefined
					? path.basename(entry)
					: path.relative(installed.installedPath, entry);
			groups.push({
				label:
					installed.entries.length === 1 ? source : `${source} (${within})`,
				extensionPaths: [entry],
			});
		}
	}
	for (const extension of input.extensions) {
		const resolved = path.resolve(input.cwd, extension);
		groups.push({ label: resolved, extensionPaths: [resolved] });
	}

	const problems: string[] = [];
	const listed: ListedModel[] = [];
	const seen = new Set<string>();
	const registeredByExtension = new Set<string>();
	// Each group loads alone, as a seat loads only its own row's extensions.
	for (const group of groups) {
		let loaded: ModelGroup | typeof TIMED_OUT;
		try {
			loaded = await withinBound(
				input.sdk.models({
					agentDir,
					cwd: input.cwd,
					extensionPaths: group.extensionPaths,
				}),
				timeoutMs,
				input.signal,
			);
		} catch (error) {
			if (input.signal?.aborted) {
				throw error;
			}
			problems.push(
				`${group.label === undefined ? "The model catalog" : `Extension ${group.label}`} failed to load: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
			);
			continue;
		}
		if (loaded === TIMED_OUT) {
			const seconds = `${timeoutMs / 1000} s`;
			if (group.label === undefined) {
				problems.push(
					`The model catalog did not finish loading within ${seconds}; the built-in models are not listed`,
				);
				continue;
			}
			const where =
				group.label === group.extensionPaths[0]
					? group.label
					: `${group.label} (${group.extensionPaths.join(", ")})`;
			problems.push(
				`Extension ${where} did not finish loading within ${seconds}; its models are not listed`,
			);
			continue;
		}
		for (const failure of loaded.extensionFailures) {
			problems.push(
				`Extension ${redactSecrets(failure.extension)} failed to load: ${redactSecrets(failure.message)}`,
			);
		}
		const own = new Set(loaded.registeredProviders);
		for (const row of loaded.models) {
			// An extension group lists only the providers it registered itself.
			if (group.label !== undefined && !own.has(row.provider)) {
				continue;
			}
			if (group.label !== undefined) {
				registeredByExtension.add(row.provider);
			}
			const key = JSON.stringify([
				row.provider,
				row.model,
				group.extensionPaths,
			]);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			listed.push({
				...row,
				extensionPaths: [...group.extensionPaths],
				...(group.label === undefined ? {} : { extensionSource: group.label }),
			});
		}
	}

	if (
		input.provider !== undefined &&
		!listed.some((row) => row.provider === input.provider)
	) {
		// A package that failed or did not finish loading may be the one that
		// registers the provider: say so instead of only calling it missing.
		throw new SetupError(
			[
				`No provider ${shown(input.provider)} in this agent folder or its installed extensions. review-panel auth providers lists the providers; review-panel extension list lists the extensions.`,
				...(problems.length === 0
					? []
					: [
							"These did not load, and one of them may register it:",
							...problems.map((line) => `  ${line}`),
						]),
			].join("\n"),
		);
	}
	let models = listed.filter(
		(row) =>
			(input.provider === undefined || row.provider === input.provider) &&
			(input.all || input.provider !== undefined || row.available) &&
			matchesSearch(row, input.search),
	);
	models = models.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			a.model.localeCompare(b.model) ||
			a.extensionPaths.length - b.extensionPaths.length,
	);
	const first = models[0];
	const result: ModelsResult = {
		agentDir,
		models,
		problems,
		...(input.search === undefined ? {} : { search: input.search }),
	};
	if (first !== undefined) {
		result.rosterRow = {
			id: first.model,
			provider: first.provider,
			model: first.model,
			...(first.extensionPaths.length === 0
				? {}
				: { extraExtensionPaths: first.extensionPaths }),
		};
	}
	if (
		input.provider !== undefined &&
		!listed.some((row) => row.provider === input.provider && row.available)
	) {
		result.notLoggedIn = {
			provider: input.provider,
			extension: registeredByExtension.has(input.provider),
		};
	}
	if (
		input.provider === undefined &&
		!input.all &&
		!listed.some((row) => row.available)
	) {
		result.noneAvailable = true;
	}
	return result;
}

function tokens(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
	}
	return String(count);
}

export function renderModels(
	result: ModelsResult,
	agentDir: AgentDirChoice,
): string {
	const lines = [folderLine(agentDir)];
	if (result.notLoggedIn !== undefined) {
		const { provider, extension } = result.notLoggedIn;
		lines.push(
			extension
				? `Not logged in to ${provider}. Log in the way its extension documents.`
				: `Not logged in to ${provider}. Run: review-panel auth login ${provider}`,
		);
	}
	if (result.noneAvailable) {
		lines.push(
			"No model is available with the logins in this agent folder. review-panel auth providers lists the providers and how to log in; review-panel models --all lists every model.",
		);
	} else if (result.models.length === 0) {
		lines.push(
			result.search === undefined
				? "No model to list."
				: `No model matches "${result.search}".`,
		);
	} else {
		const withExtension = result.models.some(
			(row) => row.extensionSource !== undefined,
		);
		const header = [
			"provider",
			"model",
			"context",
			"max-out",
			"thinking",
			"images",
			...(withExtension ? ["extension"] : []),
		];
		lines.push(
			...table([
				header,
				...result.models.map((row) => [
					row.provider,
					row.model,
					tokens(row.contextWindow),
					tokens(row.maxTokens),
					row.thinking ? "yes" : "no",
					row.images ? "yes" : "no",
					...(withExtension ? [row.extensionSource ?? ""] : []),
				]),
			]),
		);
	}
	if (result.rosterRow !== undefined) {
		lines.push(
			"",
			`A roster row for ${result.rosterRow.provider}/${result.rosterRow.model} (rename the id; it goes in "roster" in ~/.pi-review-panel/config.json):`,
			`  ${JSON.stringify(result.rosterRow)}`,
		);
	}
	if (result.problems.length > 0) {
		lines.push("", "Problems:", ...result.problems.map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

// ----- extension install | list | remove -----

/** True when the folder in use is Pi's own, whatever chose it. */
function isPiFolder(agentDir: AgentDirChoice, home: string): boolean {
	return (
		agentDir.source === "pi" ||
		path.resolve(agentDir.dir) === path.resolve(piAgentDir(home))
	);
}

/**
 * The line that says Pi shares this change: always for `~/.pi/agent`, and
 * for any other folder `PI_CODING_AGENT_DIR` names, which a Pi started with
 * the same variable uses too.
 */
function piFolderNote(
	agentDir: AgentDirChoice,
	home: string,
	text: string,
	shared: string,
): string[] {
	if (isPiFolder(agentDir, home)) {
		return [`${agentDir.dir} ${text}`];
	}
	return agentDir.source === "environment" ? [shared] : [];
}

export async function installExtension(input: {
	agentDir: AgentDirChoice;
	home: string;
	cwd: string;
	source: string;
	sdk: SetupSdk;
	progress(line: string): void;
	signal?: AbortSignal;
}): Promise<string> {
	const source = absoluteSource(input.source, input.cwd);
	const installed = redactedExtension(
		await untilAborted(
			input.sdk.installExtension({
				agentDir: input.agentDir.dir,
				source,
				progress: (line) => input.progress(redactSecrets(line)),
			}),
			input.signal,
		),
	);
	const shownSource = redactSecrets(source);
	if (installed.entries.length === 0) {
		throw new SetupError(
			`Installed ${shownSource}, but the package declares no extension, so no seat can load it. Remove it with: review-panel extension remove ${installed.source}`,
		);
	}
	return [
		`Installed ${shownSource} at ${installed.installedPath ?? "(unknown)"} (agent folder ${input.agentDir.dir}).`,
		...piFolderNote(
			input.agentDir,
			input.home,
			`is Pi's own agent folder: Pi now loads ${shownSource} in every Pi session too, as after pi install. review-panel extension remove ${installed.source} (or pi remove) undoes that.`,
			`A Pi started with the same PI_CODING_AGENT_DIR loads ${shownSource} too.`,
		),
		"A seat loads it only once its path is in that seat's roster row, as extraExtensionPaths. review-panel models lists the models it adds.",
		"Extension entry paths (put the one that registers your provider in extraExtensionPaths):",
		...installed.entries.map((entry) => `  ${entry}`),
	].join("\n");
}

export type ExtensionsResult = {
	agentDir: string;
	extensions: InstalledExtension[];
};

export async function listExtensions(input: {
	agentDir: AgentDirChoice;
	sdk: SetupSdk;
	signal?: AbortSignal;
}): Promise<ExtensionsResult> {
	return {
		agentDir: input.agentDir.dir,
		extensions: (
			await untilAborted(
				input.sdk.listExtensions({ agentDir: input.agentDir.dir }),
				input.signal,
			)
		).map(redactedExtension),
	};
}

export function renderExtensions(
	result: ExtensionsResult,
	agentDir: AgentDirChoice,
): string {
	const lines = [folderLine(agentDir)];
	if (result.extensions.length === 0) {
		lines.push(
			"No extension is installed in this agent folder. Install one with: review-panel extension install <source>",
		);
	}
	for (const extension of result.extensions) {
		lines.push(
			`${extension.source}${extension.filtered ? " (filtered in settings.json)" : ""}`,
		);
		lines.push(
			extension.installedPath === undefined
				? "  not installed (run review-panel extension install with this source)"
				: `  installed at ${extension.installedPath}`,
		);
		if (extension.entries.length === 0) {
			lines.push("  no extension entry");
		} else {
			lines.push(
				"  extraExtensionPaths entries:",
				...extension.entries.map((entry) => `    ${entry}`),
			);
		}
	}
	return lines.join("\n");
}

export async function removeExtension(input: {
	agentDir: AgentDirChoice;
	home: string;
	cwd: string;
	source: string;
	sdk: SetupSdk;
	progress(line: string): void;
	signal?: AbortSignal;
}): Promise<string> {
	const configured = await untilAborted(
		input.sdk.listExtensions({ agentDir: input.agentDir.dir }),
		input.signal,
	);
	// The source as `extension list` prints it is taken as is: a relative local
	// source there is relative to the agent folder, not to the working folder.
	const source = configured.some((entry) => entry.source === input.source)
		? input.source
		: absoluteSource(input.source, input.cwd);
	const removed = await untilAborted(
		input.sdk.removeExtension({
			agentDir: input.agentDir.dir,
			source,
			progress: (line) => input.progress(redactSecrets(line)),
		}),
		input.signal,
	);
	const shownSource = redactSecrets(source);
	if (!removed) {
		throw new SetupError(
			`No installed extension matches ${shownSource} in ${input.agentDir.dir}. review-panel extension list prints the installed sources.`,
		);
	}
	return [
		`Removed ${shownSource} from ${input.agentDir.dir}.`,
		...piFolderNote(
			input.agentDir,
			input.home,
			"is Pi's own agent folder: Pi no longer loads it either.",
			"A Pi started with the same PI_CODING_AGENT_DIR no longer loads it either.",
		),
		"Remove its path from every roster row's extraExtensionPaths too, or diagnose reports the missing extension.",
	].join("\n");
}
