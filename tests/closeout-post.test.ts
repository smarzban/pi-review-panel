import { describe, expect, it } from "vitest";

import { postCloseoutComment } from "../src/tool/closeout-post.js";

const BODY = [
	"## Review panel",
	"",
	"0 findings submitted · 0 fixed · 0 dismissed · 0 left as low/advisory",
	"Seats: terra (holistic)",
	"Lost: none",
	"`main` (`a1b2c3d`) → `HEAD` (`e4f5a6b`)",
].join("\n");

const HEAD = "e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3";

/** The PR row GitHub gives for an open pull request at HEAD. */
function openPr(number: number): string {
	return JSON.stringify({ number, state: "open", head: { sha: HEAD } });
}

type GhCall = { args: readonly string[]; input?: string };

function posterWith(
	script: (call: GhCall) => string,
	/** Set to let the script answer `pulls/<n>` itself. */
	prRows?: "scripted",
): {
	calls: GhCall[];
	run: typeof postCloseoutComment;
} {
	const calls: GhCall[] = [];
	return {
		calls,
		run: (input) =>
			postCloseoutComment({
				...input,
				runGh: (args, options) => {
					const call = { args, input: options?.input };
					calls.push(call);
					const named = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(
						args[1] ?? "",
					);
					if (named !== null && prRows === undefined) {
						return openPr(Number(named[1]));
					}
					return script(call);
				},
			}),
	};
}

function is(call: GhCall, ...tokens: string[]): boolean {
	return tokens.every((token) =>
		call.args.some((arg) => arg === token || arg.includes(token)),
	);
}

describe("postCloseoutComment", () => {
	it("creates a comment when none matches the author and heading", () => {
		const { calls, run } = posterWith((call) => {
			if (is(call, `commits/${HEAD}/pulls`)) {
				return `[${openPr(29)}]`;
			}
			if (is(call, "repo", "view")) {
				return "smarzban/demo";
			}
			if (is(call, "user")) {
				return "saeed";
			}
			if (is(call, "issues/29/comments") && !is(call, "--method")) {
				return JSON.stringify([
					{
						id: 11,
						user: { login: "other" },
						body: "## Review panel\n\nnot ours",
						html_url: "https://example.test/11",
					},
				]);
			}
			if (is(call, "--method", "POST")) {
				return JSON.stringify({
					id: 42,
					html_url:
						"https://github.com/smarzban/demo/issues/29#issuecomment-42",
				});
			}
			throw new Error(`unexpected gh ${call.args.join(" ")}`);
		});

		expect(run({ repository: "/repo", headOid: HEAD, body: BODY })).toEqual({
			action: "created",
			commentId: 42,
			pr: 29,
			url: "https://github.com/smarzban/demo/issues/29#issuecomment-42",
			body: BODY,
		});

		const create = calls.find((call) => is(call, "--method", "POST"));
		expect(create?.args).toContain("repos/smarzban/demo/issues/29/comments");
		expect(JSON.parse(create?.input ?? "{}")).toEqual({ body: BODY });
		expect(calls.some((call) => is(call, "--method", "PATCH"))).toBe(false);
	});

	it("updates the existing author comment with heading ## Review panel", () => {
		const { calls, run } = posterWith((call) => {
			if (is(call, "repo", "view")) {
				return "smarzban/demo";
			}
			if (is(call, "user")) {
				return "saeed";
			}
			if (is(call, "issues/7/comments") && !is(call, "--method")) {
				return JSON.stringify([
					{
						id: 8,
						user: { login: "saeed" },
						body: "unrelated note",
						html_url: "https://example.test/8",
					},
					{
						id: 9,
						user: { login: "saeed" },
						body: "## Review panel\n\nolder card",
						html_url: "https://example.test/9",
					},
					{
						id: 10,
						user: { login: "saeed" },
						body: "## Review panel\n\nnewer card",
						html_url: "https://example.test/10",
					},
				]);
			}
			if (is(call, "--method", "PATCH")) {
				return JSON.stringify({
					id: 9,
					html_url: "https://github.com/smarzban/demo/issues/7#issuecomment-9",
				});
			}
			throw new Error(`unexpected gh ${call.args.join(" ")}`);
		});

		expect(
			run({ repository: "/repo", headOid: HEAD, pr: "7", body: BODY }),
		).toEqual({
			action: "updated",
			commentId: 9,
			pr: 7,
			url: "https://github.com/smarzban/demo/issues/7#issuecomment-9",
			body: BODY,
		});

		const patch = calls.find((call) => is(call, "--method", "PATCH"));
		expect(patch?.args).toContain("repos/smarzban/demo/issues/comments/9");
		expect(calls.some((call) => is(call, "--method", "POST"))).toBe(false);
	});

	it("refuses a body that is not the close-out card", () => {
		expect(() =>
			postCloseoutComment({
				repository: "/repo",
				headOid: HEAD,
				body: "PR is ready for merge.",
				runGh: () => {
					throw new Error("gh must not run");
				},
			}),
		).toThrow(/## Review panel/);
	});
});

describe("postCloseoutComment reads every page of comments", () => {
	it("updates its card when it is on the second page gh prints", () => {
		const filler = Array.from({ length: 30 }, (_, index) => ({
			id: 100 + index,
			user: { login: "other" },
			body: "hi",
		}));
		const ours = { id: 7, user: { login: "saeed" }, body: BODY };
		const { calls, run } = posterWith((call) => {
			if (is(call, "repo", "view")) {
				return "smarzban/demo";
			}
			if (is(call, "user")) {
				return "saeed";
			}
			if (is(call, "issues/29/comments") && !is(call, "--method")) {
				return `${JSON.stringify(filler)}\n${JSON.stringify([ours])}\n`;
			}
			if (is(call, "--method", "PATCH")) {
				return JSON.stringify({ id: 7, html_url: "https://example.test/7" });
			}
			throw new Error(`unexpected gh ${call.args.join(" ")}`);
		});
		expect(
			run({ repository: "/repo", headOid: HEAD, body: BODY, pr: 29 }).action,
		).toBe("updated");
		expect(calls.some((call) => is(call, "--method", "POST"))).toBe(false);
	});

	it("posts what render builds from the comment listing (T505)", () => {
		const listed = [
			{ id: 5, user: { login: "saeed" }, body: "## Review panel · review" },
		];
		const { calls, run } = posterWith((call) => {
			if (is(call, "repo", "view")) {
				return "smarzban/demo";
			}
			if (is(call, "user")) {
				return "saeed";
			}
			if (is(call, "issues/7/comments") && !is(call, "--method")) {
				return JSON.stringify(listed);
			}
			if (is(call, "--method", "POST")) {
				return JSON.stringify({ id: 6, html_url: "u" });
			}
			throw new Error(`unexpected ${call.args.join(" ")}`);
		});
		const seen: unknown[] = [];
		const result = run({
			repository: "/repo",
			headOid: HEAD,
			pr: 7,
			body: BODY,
			render: (listing) => {
				seen.push(listing);
				return `${BODY}\nlinked`;
			},
		});
		expect(seen).toEqual([
			{ comments: listed, repo: "smarzban/demo", pr: 7, author: "saeed" },
		]);
		const create = calls.find((call) => is(call, "--method", "POST"));
		expect(JSON.parse(create?.input ?? "{}")).toEqual({
			body: `${BODY}\nlinked`,
		});
		expect(result.body).toBe(`${BODY}\nlinked`);
		expect(() =>
			run({
				repository: "/repo",
				headOid: HEAD,
				pr: 7,
				body: BODY,
				render: () => "## Something else",
			}),
		).toThrow(/body must start with ## Review panel/);
	});

	const base = (call: GhCall): string | undefined => {
		if (is(call, "repo", "view")) return "smarzban/demo";
		if (is(call, "user")) return "saeed";
		return undefined;
	};

	it.each([
		[
			"a closed pull request",
			{ number: 7, state: "closed", head: { sha: HEAD } },
			"PR #7 is not open",
		],
		[
			"a pull request at another head",
			{ number: 7, state: "open", head: { sha: "0".repeat(40) } },
			"PR #7's head is not the head this card is about",
		],
	] as const)(
		"refuses %s named with pr, before any comment call",
		(_name, row, message) => {
			const { calls, run } = posterWith((call) => {
				const fixed = base(call);
				if (fixed !== undefined) return fixed;
				if (is(call, "pulls/7")) return JSON.stringify(row);
				throw new Error(`unexpected gh ${call.args.join(" ")}`);
			}, "scripted");

			expect(() =>
				run({ repository: "/repo", headOid: HEAD, body: BODY, pr: 7 }),
			).toThrow(`comment refused: ${message}`);
			expect(calls.some((call) => is(call, "issues/"))).toBe(false);
		},
	);

	it("refuses a number that is not a pull request", () => {
		const { run } = posterWith((call) => {
			const fixed = base(call);
			if (fixed !== undefined) return fixed;
			if (is(call, "pulls/7")) throw new Error("gh: Not Found (HTTP 404)");
			throw new Error(`unexpected gh ${call.args.join(" ")}`);
		}, "scripted");

		expect(() =>
			run({ repository: "/repo", headOid: HEAD, body: BODY, pr: 7 }),
		).toThrow("comment refused: #7 is not a pull request here");
	});

	it.each([
		[
			"no open pull request",
			[],
			"no open PR has this head; pass --pr to name one",
		],
		[
			"two open pull requests",
			[
				{ number: 3, state: "open", head: { sha: HEAD } },
				{ number: 9, state: "open", head: { sha: HEAD } },
				{ number: 4, state: "closed", head: { sha: HEAD } },
			],
			"2 open PRs have this head: #3, #9; pass --pr to choose one",
		],
	] as const)(
		"without pr, refuses when %s has the head",
		(_name, rows, message) => {
			const { calls, run } = posterWith((call) => {
				const fixed = base(call);
				if (fixed !== undefined) return fixed;
				if (is(call, `commits/${HEAD}/pulls`)) return JSON.stringify(rows);
				throw new Error(`unexpected gh ${call.args.join(" ")}`);
			});

			expect(() =>
				run({ repository: "/repo", headOid: HEAD, body: BODY }),
			).toThrow(`comment refused: ${message}`);
			expect(calls.some((call) => is(call, "pr", "view"))).toBe(false);
		},
	);
});
