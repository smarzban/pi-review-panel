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

type GhCall = { args: readonly string[]; input?: string };

function posterWith(script: (call: GhCall) => string): {
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
			if (is(call, "pr", "view")) {
				return "29";
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

		expect(run({ repository: "/repo", body: BODY })).toEqual({
			action: "created",
			commentId: 42,
			pr: 29,
			url: "https://github.com/smarzban/demo/issues/29#issuecomment-42",
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

		expect(run({ repository: "/repo", pr: "7", body: BODY })).toEqual({
			action: "updated",
			commentId: 9,
			pr: 7,
			url: "https://github.com/smarzban/demo/issues/7#issuecomment-9",
		});

		const patch = calls.find((call) => is(call, "--method", "PATCH"));
		expect(patch?.args).toContain("repos/smarzban/demo/issues/comments/9");
		expect(calls.some((call) => is(call, "--method", "POST"))).toBe(false);
	});

	it("refuses a body that is not the close-out card", () => {
		expect(() =>
			postCloseoutComment({
				repository: "/repo",
				body: "PR is ready for merge.",
				runGh: () => {
					throw new Error("gh must not run");
				},
			}),
		).toThrow(/## Review panel/);
	});
});
