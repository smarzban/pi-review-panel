import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Copy-paste example. Models truncated "/absolute/path" to "/". */
export const REPOSITORY_EXAMPLE = "/Users/you/the-repo";

const REPOSITORY_PLACEHOLDERS = new Set([
	"/",
	"/absolute/path",
	"/absolute/path/to/repository",
	REPOSITORY_EXAMPLE,
]);

function refusePlaceholderRepository(repository: string): void {
	const trimmed = repository.trim();
	const resolved = path.resolve(trimmed);
	if (REPOSITORY_PLACEHOLDERS.has(trimmed) || resolved === "/") {
		throw new Error(
			`repository must be the real repo directory, not "${trimmed}". Pass an absolute path such as ${REPOSITORY_EXAMPLE}.`,
		);
	}
}

export function isPlaceholderRepository(repository: unknown): boolean {
	if (repository === undefined || repository === null) {
		return true;
	}
	if (typeof repository !== "string") {
		return false;
	}
	const trimmed = repository.trim();
	if (trimmed === "") {
		return true;
	}
	return REPOSITORY_PLACEHOLDERS.has(trimmed) || path.resolve(trimmed) === "/";
}

/** Use an explicit repo path, or the git top-level of cwd when the model omitted or faked it. */
export function resolveReviewRepository(
	repository: unknown,
	fallbackCwd: string,
): string {
	if (!isPlaceholderRepository(repository) && typeof repository === "string") {
		return canonicalizeRepository(repository);
	}
	try {
		return canonicalizeRepository(fallbackCwd);
	} catch {
		const shown =
			typeof repository === "string" && repository.trim() !== ""
				? `"${repository.trim()}"`
				: "omitted";
		throw new Error(
			`repository ${shown} is not a Git repository (cwd: "${fallbackCwd}"). Pass the absolute path to the repo, or run from inside it.`,
		);
	}
}

/** Refuse a resolved path that is the filesystem root (including a Git top-level of /). */
export function rejectFilesystemRoot(
	resolved: string,
	labeled: string,
): string {
	if (resolved === "/") {
		throw new Error(
			`repository must be the real repo directory, not "${labeled}". Pass an absolute path such as ${REPOSITORY_EXAMPLE}.`,
		);
	}
	return resolved;
}

export function canonicalizeRepository(repository: unknown): string {
	if (
		typeof repository !== "string" ||
		repository.trim() === "" ||
		!path.isAbsolute(repository)
	) {
		throw new Error("repository must be a non-empty absolute path");
	}
	refusePlaceholderRepository(repository);
	let real: string;
	try {
		real = realpathSync(repository);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`repository "${repository}" cannot be resolved: ${cause}`);
	}
	rejectFilesystemRoot(real, repository);
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: real,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return rejectFilesystemRoot(realpathSync(root), repository);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("real repo directory")
		) {
			throw error;
		}
		throw new Error(`repository "${repository}" is not a Git repository`);
	}
}
