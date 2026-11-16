import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";
import { DEFAULT_SEAT_PROFILE, type SeatProfile } from "./channel-profile.js";
import {
	createSubmitGroupsTool,
	type SubmitGroupsTool,
} from "./grouping-channel.js";
import type { Finding } from "./schema.js";
import { validateFindings } from "./schema.js";
import { EVIDENCE_MAX, TITLE_MAX, textLimitErrors } from "./text-limits.js";
import {
	createSubmitVerificationTool,
	type SubmitVerificationTool,
} from "./verification-channel.js";
import type { VerificationResult } from "./verification-schema.js";

type SubmitFindingsArguments = {
	findings: unknown;
};

type GitDiffArguments = {
	base: string;
	path?: string;
	nameOnly?: boolean;
};

type ToolCallEvent = {
	toolName: string;
	input: Record<string, unknown>;
};

type ToolCallDecision = {
	block: true;
	reason: string;
};

type ConfinementGuard = (event: ToolCallEvent) => ToolCallDecision | undefined;

type GitDiffTool = {
	name: "git_diff";
	label: string;
	description: string;
	parameters: {
		type: "object";
		required: ["base"];
		properties: {
			base: { type: "string"; description: string };
			path: { type: "string"; description: string };
			nameOnly: { type: "boolean"; description: string };
		};
	};
	execute: (
		toolCallId: string,
		params: GitDiffArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ToolResult>;
};

type SubmitFindingsTool = {
	name: "submit_findings";
	label: string;
	description: string;
	parameters: {
		type: "object";
		required: ["findings"];
		properties: {
			findings: {
				type: "array";
				items: Record<string, never>;
			};
		};
	};
	execute: (
		toolCallId: string,
		params: SubmitFindingsArguments,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	) => Promise<ToolResult>;
};

/**
 * The pi and TypeBox packages are peer-only and not resolvable in this package's
 * development install. These local declarations mirror defineTool and the
 * TypeBox Object/Array/Unknown output needed by this extension.
 */
function defineTool<T extends GitDiffTool | SubmitFindingsTool>(tool: T): T {
	return tool;
}

const MAX_DIFF_BYTES = 50 * 1024;
const MAX_DIFF_LINES = 2_000;
const CONFINEMENT_REFUSAL = "path outside worktree";
const GUARDED_TOOLS = new Set(["read", "grep", "find", "ls", "git_diff"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The platform, path rules and filesystem the guard resolves against. Pi reads
 * `process.platform` at call time and uses the platform's `node:path`; tests
 * inject `win32` rules to model a Windows host on any CI runner.
 */
export type GuardHost = {
	platform: NodeJS.Platform;
	path: typeof path.win32;
	homedir: () => string;
	existsSync: (value: string) => boolean;
	realpathSync: (value: string) => string;
};

const NODE_HOST: GuardHost = {
	get platform() {
		return process.platform;
	},
	path,
	homedir,
	existsSync,
	realpathSync: (value) => realpathSync(value),
};

/**
 * Mirrors Pi's normalizeWindowsShellPath (pi-coding-agent 1.5.2,
 * dist/utils/paths.js lines 90-99): a Git Bash / MSYS `/c/...`, WSL
 * `/mnt/c/...` or Cygwin `/cygdrive/c/...` drive path becomes `C:\...`.
 * A path not starting with one `/`, or holding any backslash, is left alone.
 */
function normalizeWindowsShellPath(filePath: string): string {
	if (
		!filePath.startsWith("/") ||
		filePath.startsWith("//") ||
		filePath.includes("\\")
	) {
		return filePath;
	}
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) {
		return filePath;
	}
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1]?.toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * Mirrors Pi's normalizePath (pi-coding-agent 1.5.2, dist/utils/paths.js
 * lines 100-123) in its order: Unicode-space fold and `@` strip (tool paths
 * only), then the Windows shell-path rewrite on win32 only, then `~`
 * expansion, then `file://` decode.
 */
function normalizePathLikePi(
	input: string,
	toolPath: boolean,
	host: GuardHost,
): string {
	let normalized = input;
	if (toolPath) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
		if (normalized.startsWith("@")) {
			normalized = normalized.slice(1);
		}
	}
	if (host.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}
	if (normalized === "~") {
		return host.homedir();
	}
	if (
		normalized.startsWith("~/") ||
		(host.platform === "win32" && normalized.startsWith("~\\"))
	) {
		return host.path.join(host.homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized, { windows: host.platform === "win32" });
	}
	return normalized;
}

/**
 * Mirrors Pi's resolveToCwd (dist/core/tools/path-utils.js lines 42-44), which
 * is resolvePath (dist/utils/paths.js lines 124-128): the tool path and the
 * session cwd (the worktree) are both normalized before resolution.
 */
function resolvePathLikePi(
	input: string,
	worktree: string,
	host: GuardHost,
): string {
	const normalized = normalizePathLikePi(input, true, host);
	return host.path.isAbsolute(normalized)
		? host.path.resolve(normalized)
		: host.path.resolve(normalizePathLikePi(worktree, false, host), normalized);
}

/**
 * Pi retries a missing read path with spelling variants applied to the whole
 * resolved path (AM/PM narrow space, NFD, curly quote), selecting the first
 * variant that exists on disk (dist/core/tools/path-utils.js resolveReadPath).
 * The guard must model that same ordered resolution: a whole-path variant that
 * does not exist is never read by pi, so including it would false-positive when
 * the variant rewrites the worktree prefix; the same variant when it DOES exist
 * is a real read pi can perform outside the worktree, so it must be confined.
 */
function resolveReadPathCandidates(
	input: string,
	worktree: string,
	host: GuardHost,
): string[] {
	const resolved = resolvePathLikePi(input, worktree, host);

	// Pi's resolveReadPath (dist/core/tools/path-utils.js) returns the FIRST
	// candidate that exists on disk, short-circuiting through: resolved,
	// AM/PM variant, NFD variant, curly-quote variant, NFD+curly variant,
	// falling back to resolved when none exist. The guard must confine only
	// the single path pi will actually read, not every variant that happens
	// to exist alongside it.
	if (host.existsSync(resolved)) {
		return [resolved];
	}

	const amPmVariant = resolved.replace(/ (AM|PM)\./gi, "\u202f$1.");
	if (amPmVariant !== resolved && host.existsSync(amPmVariant)) {
		return [amPmVariant];
	}

	const nfdVariant = resolved.normalize("NFD");
	if (nfdVariant !== resolved && host.existsSync(nfdVariant)) {
		return [nfdVariant];
	}

	const curlyVariant = resolved.replace(/'/g, "\u2019");
	if (curlyVariant !== resolved && host.existsSync(curlyVariant)) {
		return [curlyVariant];
	}

	const nfdCurlyVariant = nfdVariant.replace(/'/g, "\u2019");
	if (nfdCurlyVariant !== resolved && host.existsSync(nfdCurlyVariant)) {
		return [nfdCurlyVariant];
	}

	return [resolved];
}

function canonicalPath(value: string, host: GuardHost): string {
	const resolved = host.path.resolve(value);
	let ancestor = resolved;

	while (!host.existsSync(ancestor)) {
		const parent = host.path.dirname(ancestor);
		if (parent === ancestor) {
			break;
		}
		ancestor = parent;
	}

	return host.path.resolve(
		host.realpathSync(ancestor),
		host.path.relative(ancestor, resolved),
	);
}

function isContainedBy(
	parent: string,
	candidate: string,
	host: GuardHost,
): boolean {
	const relative = host.path.relative(parent, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			relative.startsWith(`..${host.path.sep}`) === false &&
			host.path.isAbsolute(relative) === false)
	);
}

/** Returns a class-only veto for allowlisted calls whose path escapes worktree. */
export function createConfinementGuard({
	worktree,
	host = NODE_HOST,
}: {
	worktree: string;
	host?: GuardHost;
}): ConfinementGuard {
	return (event) => {
		if (GUARDED_TOOLS.has(event.toolName) === false) {
			return undefined;
		}
		const argumentsToInspect = Object.values(event.input).filter(
			(value): value is string => typeof value === "string",
		);

		try {
			// Pi reads relative to the worktree as it normalizes it, so confine to that.
			const canonicalWorktree = canonicalPath(
				normalizePathLikePi(worktree, false, host),
				host,
			);
			for (const candidate of argumentsToInspect) {
				const pathCandidates =
					event.toolName === "read"
						? resolveReadPathCandidates(candidate, worktree, host)
						: [resolvePathLikePi(candidate, worktree, host)];
				for (const pathCandidate of pathCandidates) {
					if (
						isContainedBy(
							canonicalWorktree,
							canonicalPath(pathCandidate, host),
							host,
						) === false
					) {
						return { block: true, reason: CONFINEMENT_REFUSAL };
					}
				}
			}
			return undefined;
		} catch {
			// A resolution failure is unsafe to allow, and must not terminate the run.
		}

		return { block: true, reason: CONFINEMENT_REFUSAL };
	};
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isOptionShaped(value: string): boolean {
	return value.startsWith("-");
}

function verifyBaseRevision(base: string, worktree: string): void {
	try {
		execFileSync(
			"git",
			["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
			{
				cwd: worktree,
				encoding: "utf8",
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
	} catch {
		throw new Error("git diff failed: unknown base ref");
	}
}

function capturedDiffOutput(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOBUFS" &&
		"stdout" in error &&
		typeof error.stdout === "string"
	) {
		return error.stdout;
	}
	return undefined;
}

function truncateDiff(output: string): string {
	let bytes = 0;
	let lines = 0;
	let limit: "50 KB" | "2,000 lines" | undefined;

	for (const character of output) {
		const characterBytes = utf8ByteLength(character);
		if (bytes + characterBytes > MAX_DIFF_BYTES) {
			limit = "50 KB";
			break;
		}
		if (character === "\n" && lines + 1 > MAX_DIFF_LINES) {
			limit = "2,000 lines";
			break;
		}
		bytes += characterBytes;
		if (character === "\n") {
			lines += 1;
		}
	}

	if (limit === undefined) {
		return output;
	}

	const marker = ` [TRUNCATED: ${limit} limit reached]`;
	const markerBytes = utf8ByteLength(marker);
	let prefix = "";
	bytes = 0;
	lines = 0;

	for (const character of output) {
		const characterBytes = utf8ByteLength(character);
		if (bytes + characterBytes + markerBytes > MAX_DIFF_BYTES) {
			break;
		}
		if (character === "\n" && lines + 1 > MAX_DIFF_LINES) {
			break;
		}
		prefix += character;
		bytes += characterBytes;
		if (character === "\n") {
			lines += 1;
		}
	}

	return `${prefix}${marker}`;
}

function validationErrorMessage(
	errors: Array<{
		row: number;
		field: string;
		message: string;
	}>,
): string {
	return errors
		.map(({ row, field, message }) => `row ${row}: ${field} ${message}`)
		.join("\n");
}

export function createGitDiffTool({
	worktree,
}: {
	worktree: string;
}): GitDiffTool {
	return defineTool({
		name: "git_diff",
		label: "Git diff",
		description:
			"Show the diff from a base ref to HEAD (base...HEAD). Optionally restrict to one path, or list changed file names only.",
		parameters: {
			type: "object",
			required: ["base"],
			properties: {
				base: { type: "string", description: "Base git ref" },
				path: { type: "string", description: "Restrict the diff to this path" },
				nameOnly: {
					type: "boolean",
					description: "List changed file names only",
				},
			},
		},
		async execute(
			_toolCallId,
			{ base, path: restrictedPath, nameOnly },
			_signal,
			_onUpdate,
			_context,
		) {
			if (isOptionShaped(base)) {
				throw new Error("git diff failed: invalid base ref");
			}
			verifyBaseRevision(base, worktree);

			const args = ["diff", "--no-ext-diff", "--no-textconv"];
			if (nameOnly) {
				args.push("--name-only");
			}
			args.push(`${base}...HEAD`, "--");
			if (restrictedPath) {
				args.push(restrictedPath);
			}

			try {
				const output = execFileSync("git", args, {
					cwd: worktree,
					encoding: "utf8",
					maxBuffer: MAX_DIFF_BYTES + 1024,
					stdio: ["ignore", "pipe", "pipe"],
				});
				return {
					content: [
						{ type: "text", text: truncateDiff(output || "(empty diff)") },
					],
				};
			} catch (error) {
				const capturedOutput = capturedDiffOutput(error);
				if (capturedOutput !== undefined) {
					return {
						content: [{ type: "text", text: truncateDiff(capturedOutput) }],
					};
				}
				throw new Error("git diff failed: unknown base ref");
			}
		},
	});
}

export function createSubmitFindingsTool({
	channel = createSubmissionChannel<Finding[]>(),
}: {
	channel?: SubmissionChannel<Finding[]>;
}): { tool: SubmitFindingsTool; channel: SubmissionChannel<Finding[]> } {
	const tool = defineTool({
		name: "submit_findings",
		label: "Submit findings",
		description: `Submit the complete findings array after reviewing. Each finding has file, line, severity (high, medium or low), title (the problem, at most ${TITLE_MAX} characters) and evidence (what goes wrong first, at most ${EVIDENCE_MAX} characters). This can be called once.`,
		parameters: {
			type: "object",
			required: ["findings"],
			properties: {
				findings: { type: "array", items: {} },
			},
		},
		async execute(_toolCallId, { findings }, _signal, _onUpdate, _context) {
			const validation = validateFindings(findings);
			if (!validation.ok) {
				throw new Error(validationErrorMessage(validation.errors));
			}
			const tooLong = textLimitErrors(validation.findings, "findings");
			if (tooLong.length > 0) {
				throw new Error(tooLong.join("; "));
			}

			channel.submit(validation.findings);

			const count = validation.findings.length;
			return {
				content: [
					{
						type: "text",
						text: `Submitted ${count} finding${count === 1 ? "." : "s."}`,
					},
				],
			};
		},
	});
	return { tool, channel };
}

export type SeatTool =
	| GitDiffTool
	| SubmitFindingsTool
	| SubmitVerificationTool
	| SubmitGroupsTool;

export type SeatToolset = {
	tools: SeatTool[];
	channel:
		| SubmissionChannel<Finding[]>
		| SubmissionChannel<VerificationResult>
		| SubmissionChannel<string[][]>;
};

/**
 * Builds one seat-local read-only toolset. Expected ids and cycle are caller
 * authority, passed directly into the closure rather than materialized in an
 * artifact or environment variable.
 */
export function createSeatTools({
	worktree,
	profile = DEFAULT_SEAT_PROFILE,
	expectedIds = [],
	cycle,
	undoableIds = [],
}: {
	worktree: string;
	profile?: SeatProfile;
	expectedIds?: readonly string[];
	cycle?: number;
	undoableIds?: readonly string[];
}): SeatToolset {
	const readOnly = createGitDiffTool({ worktree });
	if (profile.kind === "verification") {
		if (cycle === undefined) {
			throw new Error("verification seats require a positive cycle");
		}
		const { tool, channel } = createSubmitVerificationTool({
			expectedIds,
			cycle,
			undoableIds,
		});
		return { tools: [readOnly, tool], channel };
	}
	if (profile.kind === "grouping") {
		const { tool, channel } = createSubmitGroupsTool({ expectedIds });
		return { tools: [readOnly, tool], channel };
	}
	const { tool, channel } = createSubmitFindingsTool({});
	return { tools: [readOnly, tool], channel };
}
