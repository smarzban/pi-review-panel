/**
 * Setup without Pi: `auth providers`, `models` and `extension install | list
 * | remove`, against the agent folder in use. Everything that touches the Pi
 * SDK sits behind `SetupSdk` (the real one is in `sdk.ts`); this module
 * decides what to load, filters, and words the output.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	/** The provider's own login check threw; only this row says so. */
	checkError?: string;
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
	/**
	 * Set when a credential in the recorded source was hidden (`***`) in these
	 * paths, which therefore cannot be copied into a roster row.
	 */
	credentialHidden?: true;
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
	/** The source as Pi's package manager parses it, installing nothing. */
	parseSource(source: string): Promise<ParsedSource>;
};

/** A refusal the runner reports with exit code 1. */
export class SetupError extends Error {}

/**
 * Text with any credential an extension source may carry hidden:
 *
 * - the user info of an `http(s)://` URL, and of any other `scheme://` URL
 *   when it holds a password (`ssh://git@host` names a user, not a secret);
 * - the user info of a scheme-less `git:` source (`git:user:token@host/...`,
 *   `git:token@host/...`), which Pi clones over HTTPS, but not an scp-style
 *   SSH user (`git:git@host:owner/repo`);
 * - the value of a query parameter whose name looks like a secret.
 *
 * It reads source strings only: a local path that holds an `@` is never
 * changed. A folder Pi named after a recorded source's credential is hidden
 * with that source's own parse (`redactorFor`). Sources reach the package
 * manager as given; only what is printed changes.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/(\b(?:git\+)?https?:\/\/)[^\s/@?#]+@/gi, "$1***@")
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#:]+:[^\s/@?#]*@/gi, "$1***@")
		.replace(/(\bgit:\s*)[^\s/@:]+:[^\s/@]+@/gi, "$1***@")
		.replace(/(\bgit:\s*)(?!git@)[^\s/@:]+@(?=[^\s/@]+\/)/gi, "$1***@")
		.replace(
			/([?&][^=&#\s/]*(?:token|key|secret|passw|pwd|auth|sig|credential)[^=&#\s/]*=)[^&#\s/]*/gi,
			"$1***",
		);
}

/** A source as Pi's own package manager parses it (`parseSource`). */
export type ParsedSource =
	| { type: "npm"; spec: string; name: string; version?: string }
	| { type: "git"; repo: string; host: string; path: string; ref?: string }
	| { type: "local"; path: string };

const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"]);
/** A branch, tag or commit name as a pinned ref: no `?`, `@`, `:` or space. */
const GIT_REF = /^[A-Za-z0-9._/+-]+$/;

/** The scheme, user info and query of a `scheme://` URL, when it is one. */
function urlParts(
	url: string,
): { scheme: string; userinfo?: string; query: boolean } | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)[^?#]*(\?[^#]*)?/i.exec(
		url.trim(),
	);
	if (match === null) {
		return undefined;
	}
	const authority = match[2] as string;
	const at = authority.lastIndexOf("@");
	return {
		scheme: (match[1] as string).toLowerCase(),
		...(at === -1 ? {} : { userinfo: authority.slice(0, at) }),
		query: match[3] !== undefined,
	};
}

/**
 * Why `extension install` refuses a source, decided on what Pi's own package
 * manager parses from it (`parsed`), never on the raw text, or undefined when
 * it may be installed. Pi keeps a git source's user info in the clone
 * folder's name and a query in its path, records the source in settings.json,
 * and git prints the folder, so a source is refused when:
 *
 * - a git source has user info other than the SSH user `git`
 *   (`git@host:owner/repo`, `ssh://git@host/...`): a password, any user name on
 *   an `http(s)://` URL (a token often sits there alone), any other SSH user,
 *   or an `@` anywhere else in its host; or a percent sign in its host;
 * - a git source has a query string anywhere, its ref included (it can carry
 *   a token, and Pi keeps it in the folder name), a `#` anywhere (Pi reads
 *   `#ref` as a ref only for a hosted source and keeps the `#` in the clone
 *   URL), or a ref that is not a plain branch, tag or commit name. An `@ref`
 *   such as `@release/1.0` is allowed;
 * - an `npm:` source that is not a registry package (`isRegistryPackage`);
 * - Pi reads it as a local path although it starts with a scheme (`HTTPS://`,
 *   `git+https://`, `github:`, a `git:` form its parser rejects): Pi would
 *   look for a folder of that name and print it in its error.
 */
/** An npm package name: lowercase, optionally `@scope/`, no path or URL. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** A version, range or dist-tag: no `:`, `/`, `@`, `?` or `#`. */
const NPM_VERSION = /^[A-Za-z0-9._+^~<>=|* -]+$/;

/**
 * True for `npm:<name>` and `npm:<name>@<version, range or tag>` only, as Pi
 * parses them. Any URL, `git+`, `git:`, `github:`, `file:`, alias (`npm:`) or
 * path spec is not a registry package, whether or not it holds a credential.
 */
function isRegistryPackage(
	parsed: Extract<ParsedSource, { type: "npm" }>,
): boolean {
	if (!NPM_NAME.test(parsed.name)) {
		return false;
	}
	if (parsed.version === undefined) {
		return parsed.spec === parsed.name;
	}
	return (
		NPM_VERSION.test(parsed.version) &&
		parsed.version.trim() !== "" &&
		parsed.spec === `${parsed.name}@${parsed.version}`
	);
}

/**
 * The exact credential text in a parsed source: user info that can hold a
 * secret (with its `@`) and query strings (with their `?`). Printing a source,
 * or a folder Pi named after it, hides these.
 */
export function credentialParts(parsed: ParsedSource): string[] {
	const parts: string[] = [];
	const fromUrl = (url: string, allowSshUser: boolean) => {
		const found = urlParts(url);
		if (
			found?.userinfo !== undefined &&
			!(
				allowSshUser &&
				SSH_SCHEMES.has(found.scheme) &&
				found.userinfo === "git"
			)
		) {
			parts.push(`${found.userinfo}@`);
		}
		const query = /\?[^#\s]*/.exec(url);
		if (query !== null) {
			parts.push(query[0]);
		}
	};
	if (parsed.type === "git") {
		const at = parsed.host.lastIndexOf("@");
		if (at !== -1) {
			parts.push(parsed.host.slice(0, at + 1));
		}
		fromUrl(parsed.repo, true);
		const query = /\?[^#\s/]*/.exec(parsed.path);
		if (query !== null) {
			parts.push(query[0]);
		}
	} else if (parsed.type === "npm") {
		fromUrl(parsed.version ?? "", false);
	}
	return [...new Set(parts)]
		.filter((part) => part !== "@" && part !== "?")
		.sort((a, b) => b.length - a.length);
}

/** `text` with each credential part shown as `***`. */
export function hideParts(text: string, parts: readonly string[]): string {
	let result = text;
	for (const part of parts) {
		result = result.replaceAll(part, part.startsWith("?") ? "?***" : "***@");
	}
	return result;
}

/*
 * Every refusal is fixed text: no part of the source is ever repeated, since
 * any part of it (user info, host, path, ref, npm name or version) can hold a
 * token, and no redaction can tell which.
 */
const REFUSED_CREDENTIAL =
	"The source carries a credential (a user name, password or token), so review-panel does not install it and does not repeat it here: Pi would keep the credential in settings.json and in the clone folder's name, and git would print it. Give git the token through a credential helper (git config credential.helper), use an SSH source (git:git@host:owner/repo), or put an npm token in .npmrc, then install the source without it.";
const REFUSED_QUERY =
	"The source has a query string, which can carry a token and which Pi would keep in the clone folder's name, so review-panel does not install it and does not repeat it here. Pin a ref with @<ref> instead, and give git any token through a credential helper (git config credential.helper).";
const REFUSED_PERCENT_HOST =
	"The source has a percent-encoded host, which can hide user info, so review-panel does not install it and does not repeat it here. Write the host plainly, as git:host/owner/repo or git:git@host:owner/repo.";
const REFUSED_REF =
	"The source pins a ref that is not a plain branch, tag or commit name (letters, digits, . _ / + -), so review-panel does not install it and does not repeat it here, in case the ref holds a token. Pin a plain ref with @<ref>, such as git:host/owner/repo@release/1.0.";
const REFUSED_FRAGMENT =
	"The source has a #, which Pi does not read as a ref for every host and would keep in the clone URL and the clone folder's name, so review-panel does not install it and does not repeat it here, in case it holds a token. Pin a ref with @<ref> instead, such as git:host/owner/repo@release/1.0.";
const REFUSED_NPM =
	"The source is not a registry package, so review-panel does not install it and does not repeat it here, in case it holds a token. review-panel installs npm:<name> or npm:<name>@<version, range or tag> only, never a URL, git, file or alias spec. Install a private package from your registry with a token in .npmrc, or use a git: source (git:git@host:owner/repo).";
const REFUSED_UNREADABLE =
	"Pi cannot read the source as git or npm: it would look for a local folder of that name and print it, so review-panel does not install it and does not repeat it here, in case it holds a token. Write a git source as git:host/owner/repo, git:git@host:owner/repo or https://host/owner/repo, and an npm package as npm:<name>.";
const REFUSED_SCP =
	"The source looks like an SSH Git source without the git: prefix, which Pi would take for a local folder, so review-panel does not use it and does not repeat it here, in case it holds a token. Write it with the prefix, as git:git@host:owner/repo.";
const REFUSED_FILE_URL =
	"The source is a file: URL that names no local path, so review-panel does not use it and does not repeat it here, in case it holds a token. Write the folder as a path (./ext, ~/ext or /full/path) or as file:///full/path.";

export function sourceProblem(
	raw: string,
	parsed: ParsedSource,
): string | undefined {
	switch (parsed.type) {
		case "local":
			return /^\s*[a-z][a-z0-9+.-]+:/i.test(raw)
				? REFUSED_UNREADABLE
				: undefined;
		case "npm":
			return isRegistryPackage(parsed) ? undefined : REFUSED_NPM;
		case "git": {
			const ref = parsed.ref ?? "";
			if (
				parsed.repo.includes("?") ||
				parsed.path.includes("?") ||
				ref.includes("?")
			) {
				return REFUSED_QUERY;
			}
			// Pi splits a #ref off only for a hosted source (github.com and the
			// like), and keeps the # in the clone URL even then.
			if (
				parsed.repo.includes("#") ||
				parsed.path.includes("#") ||
				ref.includes("#")
			) {
				return REFUSED_FRAGMENT;
			}
			if (parsed.host.includes("@")) {
				return REFUSED_CREDENTIAL;
			}
			if (parsed.host.includes("%")) {
				return REFUSED_PERCENT_HOST;
			}
			if (ref !== "" && !GIT_REF.test(ref)) {
				return REFUSED_REF;
			}
			const url = urlParts(parsed.repo);
			if (url !== undefined) {
				if (url.userinfo === undefined) {
					return undefined;
				}
				// The only SSH user allowed is git; any other may be a token.
				return SSH_SCHEMES.has(url.scheme) && url.userinfo === "git"
					? undefined
					: REFUSED_CREDENTIAL;
			}
			// scp-style SSH (user@host:path): only the user git.
			const scp = /^([^@\s/:]+)@[^@\s/:]+:/.exec(parsed.repo);
			if (scp !== null) {
				return scp[1] === "git" ? undefined : REFUSED_CREDENTIAL;
			}
			return parsed.repo.includes("@") ? REFUSED_CREDENTIAL : undefined;
		}
	}
}

/**
 * How to print text about one recorded source: its own credential parts (from
 * Pi's parse of it) hidden first, then `redactSecrets`. Only that source's
 * credential text is hidden, so no other `@` in a path changes.
 */
async function redactorFor(
	sdk: SetupSdk,
	source: string,
): Promise<(text: string) => string> {
	let parts: string[] = [];
	try {
		parts = credentialParts(await sdk.parseSource(source));
	} catch {
		// Unparseable: the source-string rules still apply.
	}
	return (text) => redactSecrets(hideParts(text, parts));
}

async function redactedExtension(
	sdk: SetupSdk,
	entry: InstalledExtension,
): Promise<InstalledExtension> {
	const redact = await redactorFor(sdk, entry.source);
	const entries = entry.entries.map(redact);
	const installedPath =
		entry.installedPath === undefined ? undefined : redact(entry.installedPath);
	const hidden =
		entries.some((shown, index) => shown !== entry.entries[index]) ||
		installedPath !== entry.installedPath;
	return {
		...entry,
		source: redact(entry.source),
		entries,
		...(installedPath === undefined ? {} : { installedPath }),
		...(hidden ? { credentialHidden: true as const } : {}),
	};
}

const UNCOPYABLE =
	"*** hides a credential from the source, so these paths cannot be copied into a roster row; remove it and install the source again without the credential";

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
	if (row.checkError !== undefined) {
		return `check failed (${row.checkError})`;
	}
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
	/** Loaded as given. */
	extensionPaths: string[];
	/** How its paths are printed. */
	redact?: (text: string) => string;
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
 * A local source (anything that is not `npm:`, `git:` or a URL) as an
 * absolute path: a leading `~` is the home folder, a `file:` URL is decoded,
 * and anything else is resolved from `cwd`, as Pi resolves one from the folder
 * it runs in. Other sources pass through. An SSH source written the scp way
 * (`git@host:owner/repo`) is refused: Pi would take it for a local path, and
 * only `git:git@host:owner/repo` reaches git.
 */
export function absoluteSource(
	source: string,
	cwd: string,
	home: string,
): string {
	const trimmed = source.trim();
	// Anything with a scheme (any case; `file:` aside) goes to Pi as given, and
	// install refuses what Pi cannot read (`sourceProblem`).
	if (/^[a-z][a-z0-9+.-]+:/i.test(trimmed) && !/^file:/i.test(trimmed)) {
		return trimmed;
	}
	if (/^[^\s/:@]+@[^\s/:]+:/.test(trimmed)) {
		throw new SetupError(REFUSED_SCP);
	}
	if (trimmed.startsWith("file:")) {
		try {
			return fileURLToPath(trimmed);
		} catch {
			throw new SetupError(REFUSED_FILE_URL);
		}
	}
	if (trimmed === "~") {
		return home;
	}
	if (trimmed.startsWith("~/")) {
		return path.join(home, trimmed.slice(2));
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
		const redact = await redactorFor(input.sdk, installed.source);
		const source = redact(installed.source);
		for (const entry of installed.entries) {
			const within =
				installed.installedPath === undefined
					? path.basename(entry)
					: path.relative(installed.installedPath, entry);
			groups.push({
				label:
					installed.entries.length === 1
						? source
						: `${source} (${redact(within)})`,
				extensionPaths: [entry],
				redact,
			});
		}
	}
	for (const extension of input.extensions) {
		const resolved = path.resolve(input.cwd, extension);
		groups.push({ label: redactSecrets(resolved), extensionPaths: [resolved] });
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
				`${group.label === undefined ? "The model catalog" : `Extension ${group.label}`} failed to load: ${(group.redact ?? redactSecrets)(error instanceof Error ? error.message : String(error))}`,
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
			const paths = group.extensionPaths.map(group.redact ?? redactSecrets);
			const where =
				group.label === paths[0]
					? group.label
					: `${group.label} (${paths.join(", ")})`;
			problems.push(
				`Extension ${where} did not finish loading within ${seconds}; its models are not listed`,
			);
			continue;
		}
		for (const failure of loaded.extensionFailures) {
			problems.push(
				// A recorded source's own credential is hidden here too: the
				// path and the loader's message can both hold its folder name.
				`Extension ${(group.redact ?? redactSecrets)(failure.extension)} failed to load: ${(group.redact ?? redactSecrets)(failure.message)}`,
			);
		}
		const shownPaths = group.extensionPaths.map(group.redact ?? redactSecrets);
		if (
			shownPaths.some(
				(shown, index) => shown !== group.extensionPaths[index],
			) &&
			loaded.registeredProviders.length > 0
		) {
			problems.push(`Extension ${group.label}: ${UNCOPYABLE}`);
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
				// Loaded as given; printed redacted (a folder Pi named after a
				// source with a token in it keeps that token).
				extensionPaths: shownPaths,
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

/**
 * What an install stopped by Ctrl-C left. Pi's package manager gives no handle
 * on the git or npm it runs, so the bin exits as soon as the command returns
 * (see main.ts) and the package manager never gets to record the source; this
 * reads settings.json to say whether it already had.
 */
async function abortedInstall(
	sdk: SetupSdk,
	agentDir: string,
	source: string,
	shownSource: string,
): Promise<string> {
	let recorded = false;
	try {
		recorded = (await sdk.listExtensions({ agentDir })).some(
			(entry) => entry.source === source || entry.installedPath === source,
		);
	} catch {
		// Unreadable settings: say what the stop itself guarantees.
	}
	return recorded
		? `${shownSource} was already recorded in ${path.join(agentDir, "settings.json")} when the install stopped; review-panel extension list shows it, and review-panel extension remove undoes it.`
		: `${shownSource} was not recorded in ${path.join(agentDir, "settings.json")} when checked after the stop, and review-panel exits now so that its package manager does not go on; review-panel extension list shows the final state. A git clone or npm install it had started may be left under ${agentDir} (git/ or npm/); install the source again to finish it.`;
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
	const source = absoluteSource(input.source, input.cwd, input.home);
	const problem = sourceProblem(source, await input.sdk.parseSource(source));
	if (problem !== undefined) {
		throw new SetupError(problem);
	}
	const shownSource = redactSecrets(source);
	let installed: InstalledExtension;
	try {
		// Nothing starts once the run is aborted.
		input.signal?.throwIfAborted();
		installed = await redactedExtension(
			input.sdk,
			await untilAborted(
				input.sdk.installExtension({
					agentDir: input.agentDir.dir,
					source,
					progress: (line) => input.progress(redactSecrets(line)),
				}),
				input.signal,
			),
		);
	} catch (error) {
		if (input.signal?.aborted) {
			throw new SetupError(
				await abortedInstall(
					input.sdk,
					input.agentDir.dir,
					source,
					shownSource,
				),
			);
		}
		throw error;
	}
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
	const recorded = await untilAborted(
		input.sdk.listExtensions({ agentDir: input.agentDir.dir }),
		input.signal,
	);
	const extensions: InstalledExtension[] = [];
	for (const entry of recorded) {
		extensions.push(await redactedExtension(input.sdk, entry));
	}
	return { agentDir: input.agentDir.dir, extensions };
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
			if (extension.credentialHidden) {
				lines.push(`  ${UNCOPYABLE}`);
			}
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
	// source there is relative to the agent folder, not to the working folder,
	// and a source with a credential is printed redacted, so the printed form
	// names the recorded source it matches when it matches exactly one.
	let source: string;
	const printedAs: InstalledExtension[] = [];
	for (const entry of configured) {
		if (
			entry.source !== input.source &&
			(await redactorFor(input.sdk, entry.source))(entry.source) ===
				input.source
		) {
			printedAs.push(entry);
		}
	}
	if (configured.some((entry) => entry.source === input.source)) {
		source = input.source;
	} else if (printedAs.length === 1) {
		source = (printedAs[0] as InstalledExtension).source;
	} else if (printedAs.length > 1) {
		throw new SetupError(
			`${input.source} matches ${printedAs.length} installed sources that differ only in their credentials. Remove the one you mean from "packages" in ${path.join(input.agentDir.dir, "settings.json")}, and its folder under ${path.join(input.agentDir.dir, "git")}.`,
		);
	} else {
		source = absoluteSource(input.source, input.cwd, input.home);
	}
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
