import { execFileSync } from "node:child_process";

export const CLOSEOUT_HEADING = "## Review panel";

export type GhRunner = (
	args: readonly string[],
	options?: { cwd?: string; input?: string },
) => string;

/** The PR's comments as gh listed them, and where they are. */
export type CommentListing = {
	comments: readonly unknown[];
	repo: string;
	pr: number;
	author: string;
};

export type PostCloseoutInput = {
	repository: string;
	/** The head commit the card is about: the verify's, or else the review's. */
	headOid: string;
	/** The card as posted when there is no `render`. */
	body: string;
	/**
	 * Builds the card from the PR's comment listing (to link earlier rounds),
	 * replacing `body`. It must not throw for a listing it cannot use.
	 */
	render?: (listing: CommentListing) => string;
	pr?: number | string;
	runGh?: GhRunner;
};

export type PostCloseoutResult = {
	action: "created" | "updated";
	commentId: number;
	pr: number;
	url: string;
	/** The body that was posted. */
	body?: string;
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

/** Splits text into its top-level JSON values, or undefined if it is not one. */
function splitJsonValues(text: string): string[] | undefined {
	const values: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] as string;
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			if (depth === 0) {
				// A listing is arrays; a bare top-level string is malformed.
				return undefined;
			}
			inString = true;
		} else if (char === "[" || char === "{") {
			if (depth === 0) {
				start = index;
			}
			depth += 1;
		} else if (char === "]" || char === "}") {
			depth -= 1;
			if (depth < 0) {
				return undefined;
			}
			if (depth === 0) {
				values.push(text.slice(start, index + 1));
			}
		} else if (depth === 0 && !/\s/.test(char)) {
			return undefined;
		}
	}
	return depth === 0 && !inString ? values : undefined;
}

/**
 * The rows of a `gh api --paginate` listing. gh prints each page as its own
 * JSON array, one after another; `--slurp` wraps them in one outer array.
 * Both, and a single page, come back as one flat list. Anything else is
 * undefined.
 */
export function parseJsonPages(raw: string): unknown[] | undefined {
	const text = trimOutput(raw);
	if (text === "") {
		return [];
	}
	const pages = splitJsonValues(text);
	if (pages === undefined) {
		return undefined;
	}
	const rows: unknown[] = [];
	for (const page of pages) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(page);
		} catch {
			return undefined;
		}
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		const slurped =
			parsed.length > 0 && parsed.every((row) => Array.isArray(row));
		rows.push(...(slurped ? (parsed as unknown[][]).flat() : parsed));
	}
	return rows;
}

function parseComments(raw: string): IssueComment[] {
	const rows = parseJsonPages(raw);
	if (rows === undefined) {
		throw new Error("comment refused: gh comment list was not an array");
	}
	return rows as IssueComment[];
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

type PullRow = { number?: unknown; state?: unknown; head?: { sha?: unknown } };

function parsePulls(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("comment refused: gh gave no JSON for the pull request");
	}
}

/**
 * A named PR must be an open pull request at the card's head, as for a
 * round (`checkNamedPr` in round-post.ts): the card is about that commit.
 */
function namedPr(
	call: (args: readonly string[]) => string,
	repo: string,
	pr: number,
	headOid: string,
): number {
	let raw: string;
	try {
		raw = call(["api", `repos/${repo}/pulls/${pr}`]);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		if (/HTTP 404|Not Found/.test(cause)) {
			throw new Error(`comment refused: #${pr} is not a pull request here`);
		}
		throw error;
	}
	const row = parsePulls(raw) as PullRow | null;
	if (row?.state !== "open") {
		throw new Error(`comment refused: PR #${pr} is not open`);
	}
	if (row.head?.sha !== headOid) {
		throw new Error(
			`comment refused: PR #${pr}'s head is not the head this card is about; run verify at the PR's head, then comment with that verify`,
		);
	}
	return pr;
}

/** With no PR named: the one open pull request whose head is the card's head. */
function openPrAtHead(
	call: (args: readonly string[]) => string,
	repo: string,
	headOid: string,
): number {
	let raw: string;
	try {
		raw = call(["api", `repos/${repo}/commits/${headOid}/pulls`]);
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		if (/HTTP 422|No commit found/.test(cause)) {
			throw new Error(
				"comment refused: no open PR has this head; GitHub does not have this commit",
			);
		}
		throw error;
	}
	const pulls = parsePulls(raw);
	const open = (Array.isArray(pulls) ? (pulls as PullRow[]) : [])
		.filter(
			(row) =>
				row !== null &&
				typeof row === "object" &&
				row.state === "open" &&
				row.head?.sha === headOid &&
				Number.isInteger(row.number),
		)
		.map((row) => row.number as number);
	if (open.length === 0) {
		throw new Error(
			"comment refused: no open PR has this head; pass --pr to name one, or if the PR has moved on, run verify at its head first",
		);
	}
	if (open.length > 1) {
		throw new Error(
			`comment refused: ${open.length} open PRs have this head: ${open.map((n) => `#${n}`).join(", ")}; pass --pr to choose one`,
		);
	}
	return open[0] as number;
}

/**
 * The PR the card would post to, or a refusal saying why there is none: the
 * one `pr` names (open, with the card's head as its head), or with none named
 * the one open PR at that head. `comment` asks before it spends a seat.
 */
export function findCloseoutPr(
	input: Pick<PostCloseoutInput, "repository" | "headOid" | "pr" | "runGh">,
): number {
	const runGh = input.runGh ?? defaultRunGh;
	const call = (args: readonly string[]): string =>
		runGh(args, { cwd: input.repository });
	return resolvePr(call, input.headOid, input.pr).pr;
}

/** The repository, and the PR at the card's head (see {@link findCloseoutPr}). */
function resolvePr(
	call: (args: readonly string[]) => string,
	headOid: string,
	pr: number | string | undefined,
): { repo: string; pr: number } {
	const repo = trimOutput(
		call(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
	);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
		throw new Error("comment refused: could not resolve GitHub repository");
	}
	return {
		repo,
		pr:
			pr === undefined
				? openPrAtHead(call, repo, headOid)
				: namedPr(call, repo, parsePositiveInt(pr, "pr"), headOid),
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

	const { repo, pr } = resolvePr(call, input.headOid, input.pr);
	const author = trimOutput(call(["api", "user", "--jq", ".login"]));
	if (author === "") {
		throw new Error("comment refused: could not resolve the GitHub author");
	}

	const comments = parseComments(
		call([
			"api",
			`repos/${repo}/issues/${pr}/comments?per_page=100`,
			"--paginate",
		]),
	);
	const existing = comments.find(
		(comment) =>
			comment.user?.login === author && hasCloseoutHeading(comment.body),
	);

	const body =
		input.render === undefined
			? input.body
			: input.render({ comments, repo, pr, author });
	if (!body.trimStart().startsWith(CLOSEOUT_HEADING)) {
		throw new Error(
			`comment refused: body must start with ${CLOSEOUT_HEADING}`,
		);
	}
	const payload = JSON.stringify({ body });
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
			body,
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
		body,
	};
}
