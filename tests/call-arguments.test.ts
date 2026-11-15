import { describe, expect, it, vi } from "vitest";

import {
	CallArgumentError,
	callAction,
	realActions,
} from "../src/actions/call.js";

/**
 * A badly shaped argument is a usage error (exit 2 in the CLI) for every
 * action. Review used to check `seats`, `lenses` and `scopingNote` only
 * after the panel was ready, so the same mistake exited 1 there.
 */
describe("review refuses a badly shaped argument before it runs, as verify does", () => {
	const bad: Array<[string, Record<string, unknown>]> = [
		["an empty scoping note", { scopingNote: "" }],
		["an empty seat list", { seats: [] }],
		["a lens that is not a string", { lenses: [3] }],
	];

	it.each(bad)("%s", async (_name, extra) => {
		const actions = Object.fromEntries(
			Object.keys(realActions).map((name) => [name, vi.fn()]),
		) as unknown as typeof realActions;
		const call = callAction(
			{ action: "review", base: "main", head: "HEAD", ...extra },
			{
				cwd: "/nonexistent-repo",
				repoDir: "/nonexistent-repo",
				context: {},
				actions,
			},
		);
		await expect(call).rejects.toBeInstanceOf(CallArgumentError);
		expect(actions.review).not.toHaveBeenCalled();
	});
});
