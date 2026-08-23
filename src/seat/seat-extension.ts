// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, realpathSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { homedir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { platform } from "node:process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { fileURLToPath } from "node:url";
import {
	createSubmitAuditTool,
	type SubmitAuditTool,
} from "./audit-channel.js";
import type { AuditRow } from "./audit-schema.js";
import {
	createSubmissionChannel,
	type SubmissionChannel,
	type ToolResult,
} from "./channel-file.js";
import { DEFAULT_SEAT_PROFILE, type SeatProfile } from "./channel-profile.js";
import type { Finding } from "./schema.js";
import { validateFindings } from "./schema.js";
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

/** Mirrors Pi's resolveToCwd normalization before the confinement check. */
function resolvePathLikePi(input: string, worktree: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (normalized === "~") {
		normalized = homedir();
	} else if (
		normalized.startsWith("~/") ||
		(platform === "win32" && normalized.startsWith("~\\"))
	) {
		normalized = path.join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		normalized = fileURLToPath(normalized);
	}
	return path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(worktree, normalized);
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
function resolveReadPathCandidates(input: string, worktree: string): string[] {
	const resolved = resolvePathLikePi(input, worktree);

	// Pi's resolveReadPath (dist/core/tools/path-utils.js) returns the FIRST
	// candidate that exists on disk, short-circuiting through: resolved,
	// AM/PM variant, NFD variant, curly-quote variant, NFD+curly variant,
	// falling back to resolved when none exist. The guard must confine only
	// the single path pi will actually read, not every variant that happens
	// to exist alongside it.
	if (existsSync(resolved)) {
		return [resolved];
	}

	const amPmVariant = resolved.replace(/ (AM|PM)\./gi, "\u202f$1.");
	if (amPmVariant !== resolved && existsSync(amPmVariant)) {
		return [amPmVariant];
	}

	const nfdVariant = resolved.normalize("NFD");
	if (nfdVariant !== resolved && existsSync(nfdVariant)) {
		return [nfdVariant];
	}

	const curlyVariant = resolved.replace(/'/g, "\u2019");
	if (curlyVariant !== resolved && existsSync(curlyVariant)) {
		return [curlyVariant];
	}

	const nfdCurlyVariant = nfdVariant.replace(/'/g, "\u2019");
	if (nfdCurlyVariant !== resolved && existsSync(nfdCurlyVariant)) {
		return [nfdCurlyVariant];
	}

	return [resolved];
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	let ancestor = resolved;

	while (!existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor) {
			break;
		}
		ancestor = parent;
	}

	return path.resolve(
		realpathSync(ancestor),
		path.relative(ancestor, resolved),
	);
}

function isContainedBy(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			relative.startsWith(`..${path.sep}`) === false &&
			path.isAbsolute(relative) === false)
	);
}

/** Returns a class-only veto for allowlisted calls whose path escapes worktree. */
export function createConfinementGuard({
	worktree,
}: {
	worktree: string;
}): ConfinementGuard {
	return (event) => {
		if (GUARDED_TOOLS.has(event.toolName) === false) {
			return undefined;
		}
		const argumentsToInspect = Object.values(event.input).filter(
			(value): value is string => typeof value === "string",
		);

		try {
			const canonicalWorktree = canonicalPath(worktree);
			for (const candidate of argumentsToInspect) {
				const pathCandidates =
					event.toolName === "read"
						? resolveReadPathCandidates(candidate, worktree)
						: [resolvePathLikePi(candidate, worktree)];
				for (const pathCandidate of pathCandidates) {
					if (
						isContainedBy(canonicalWorktree, canonicalPath(pathCandidate)) ===
						false
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
		description:
			"Submit the complete findings array after reviewing. This can be called once.",
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
	| SubmitAuditTool
	| SubmitVerificationTool;

export type SeatToolset = {
	tools: SeatTool[];
	channel:
		| SubmissionChannel<Finding[]>
		| SubmissionChannel<AuditRow[]>
		| SubmissionChannel<VerificationResult>;
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
}: {
	worktree: string;
	profile?: SeatProfile;
	expectedIds?: readonly string[];
	cycle?: number;
}): SeatToolset {
	const readOnly = createGitDiffTool({ worktree });
	if (profile.kind === "audit") {
		const { tool, channel } = createSubmitAuditTool({ expectedIds });
		return { tools: [readOnly, tool], channel };
	}
	if (profile.kind === "verification") {
		if (cycle === undefined) {
			throw new Error("verification seats require a positive cycle");
		}
		const { tool, channel } = createSubmitVerificationTool({
			expectedIds,
			cycle,
		});
		return { tools: [readOnly, tool], channel };
	}
	const { tool, channel } = createSubmitFindingsTool({});
	if (profile.kind === "repo-audit") {
		return { tools: [tool], channel };
	}
	return { tools: [readOnly, tool], channel };
}
