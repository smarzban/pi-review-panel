// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";

export const CLOSEOUT_HEADING = "## Review panel";

export type GhRunner = (
	args: readonly string[],
	options?: { cwd?: string; input?: string },
) => string;

export type PostCloseoutInput = {
	repository: string;
	body: string;
	pr?: number | string;
	runGh?: GhRunner;
};

export type PostCloseoutResult = {
	action: "created" | "updated";
	commentId: number;
	pr: number;
	url: string;
};

type IssueComment = {
	id: number;
	html_url?: string;
	body?: string;
	user?: { login?: string };
};

function defaultRunGh(
	args: readonly string[],
	options?: { cwd?: string; input?: string },
): string {
	try {
		return execFileSync("gh", [...args], {
			encoding: "utf8",
			cwd: options?.cwd,
			input: options?.input,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`comment refused: gh failed: ${cause}`);
	}
}

function trimOutput(raw: string): string {
	return raw.replace(/^\uFEFF/, "").trim();
}

function parsePositiveInt(raw: unknown, label: string): number {
	const value =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? Number.parseInt(raw.trim(), 10)
				: Number.NaN;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`comment refused: ${label} must be a positive integer`);
	}
	return value;
}

function parseComments(raw: string): IssueComment[] {
	const trimmed = trimOutput(raw);
	if (trimmed === "") {
		return [];
	}
	const parsed: unknown = JSON.parse(trimmed);
	if (!Array.isArray(parsed)) {
		throw new Error("comment refused: gh comment list was not an array");
	}
	return parsed as IssueComment[];
}

function hasCloseoutHeading(body: string | undefined): boolean {
	if (body === undefined) {
		return false;
	}
	return body.split(/\r?\n/).some((line) => line.trim() === CLOSEOUT_HEADING);
}

function parseCreated(raw: string): { id: number; url: string } {
	const parsed: unknown = JSON.parse(trimOutput(raw));
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!("id" in parsed) ||
		typeof (parsed as { id: unknown }).id !== "number"
	) {
		throw new Error("comment refused: gh did not return a comment id");
	}
	const record = parsed as { id: number; html_url?: unknown };
	return {
		id: record.id,
		url: typeof record.html_url === "string" ? record.html_url : "",
	};
}

/** Find-or-update the one owner comment whose body has heading `## Review panel`. */
export function postCloseoutComment(
	input: PostCloseoutInput,
): PostCloseoutResult {
	if (!input.body.trimStart().startsWith(CLOSEOUT_HEADING)) {
		throw new Error(
			`comment refused: body must start with ${CLOSEOUT_HEADING}`,
		);
	}

	const runGh = input.runGh ?? defaultRunGh;
	const cwd = input.repository;
	const call = (args: readonly string[], stdin?: string): string =>
		runGh(args, stdin === undefined ? { cwd } : { cwd, input: stdin });

	const pr =
		input.pr === undefined
			? parsePositiveInt(
					call(["pr", "view", "--json", "number", "--jq", ".number"]),
					"pr",
				)
			: parsePositiveInt(input.pr, "pr");
	const repo = trimOutput(
		call(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
	);
	if (!repo.includes("/")) {
		throw new Error("comment refused: could not resolve GitHub repository");
	}
	const author = trimOutput(call(["api", "user", "--jq", ".login"]));
	if (author === "") {
		throw new Error("comment refused: could not resolve the GitHub author");
	}

	const comments = parseComments(
		call(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]),
	);
	const existing = comments.find(
		(comment) =>
			comment.user?.login === author && hasCloseoutHeading(comment.body),
	);

	const payload = JSON.stringify({ body: input.body });
	if (existing !== undefined) {
		const updated = parseCreated(
			call(
				[
					"api",
					"--method",
					"PATCH",
					`repos/${repo}/issues/comments/${existing.id}`,
					"--input",
					"-",
				],
				payload,
			),
		);
		return {
			action: "updated",
			commentId: updated.id,
			pr,
			url: updated.url,
		};
	}

	const created = parseCreated(
		call(
			[
				"api",
				"--method",
				"POST",
				`repos/${repo}/issues/${pr}/comments`,
				"--input",
				"-",
			],
			payload,
		),
	);
	return {
		action: "created",
		commentId: created.id,
		pr,
		url: created.url,
	};
}
