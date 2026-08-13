// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfinementGuard } from "../src/seat/seat-extension.js";

type Fixture = { root: string; worktree: string; outside: string };

function fixture(): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "sdk-seat-guard-"));
	const worktree = path.join(root, "worktree");
	const outside = path.join(root, "outside");
	mkdirSync(path.join(worktree, "nested"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(path.join(worktree, "nested", "inside.txt"), "inside\n");
	writeFileSync(path.join(outside, "outside.txt"), "outside\n");
	symlinkSync(outside, path.join(worktree, "escape"));
	symlinkSync(
		path.join(worktree, "nested"),
		path.join(worktree, "inside-link"),
	);
	// Pi normalizes Unicode spaces, then read retries these spelling variants
	// when the primary resolved path is absent.
	symlinkSync(outside, path.join(worktree, "normalized link"));
	symlinkSync(outside, path.join(worktree, "screenshot\u202fPM."));
	symlinkSync(outside, path.join(worktree, "cafe\u0301"));
	symlinkSync(outside, path.join(worktree, "escape\u2019"));
	symlinkSync(outside, path.join(worktree, "cafe\u0301\u2019s"));
	return { root, worktree, outside };
}

function removeFixture(value: Fixture): void {
	rmSync(value.root, { recursive: true, force: true });
}

function refusal() {
	return { block: true, reason: "path outside worktree" };
}

describe("SDK seat confinement", () => {
	it("vetoes absolute, traversal, symlink, and normalized escapes for every guarded tool", () => {
		const value = fixture();
		try {
			const guard = createConfinementGuard({ worktree: value.worktree });
			for (const [toolName, input] of [
				["read", { path: path.join(value.outside, "outside.txt") }],
				["read", { path: `@${path.join(value.outside, "outside.txt")}` }],
				["grep", { path: "../outside/outside.txt" }],
				["find", { path: "escape" }],
				["ls", { path: "escape/outside.txt" }],
				["git_diff", { path: "normalized\u00a0link/outside.txt" }],
			] as const) {
				expect(guard({ toolName, input })).toEqual(refusal());
			}
		} finally {
			removeFixture(value);
		}
	});

	it("confines the Pi read fallback target, but does not apply those fallbacks to other tools", () => {
		const value = fixture();
		try {
			const guard = createConfinementGuard({ worktree: value.worktree });
			for (const candidate of ["screenshot PM.", "café", "escape'", "café's"]) {
				expect(guard({ toolName: "read", input: { path: candidate } })).toEqual(
					refusal(),
				);
			}
			// These two spellings are distinct on the supported host volume, so
			// they prove Pi's AM/PM and curly-quote fallback order is guarded.
			expect(existsSync(path.join(value.worktree, "screenshot PM."))).toBe(
				false,
			);
			expect(existsSync(path.join(value.worktree, "escape'"))).toBe(false);
			expect(
				guard({ toolName: "grep", input: { path: "escape'" } }),
			).toBeUndefined();
		} finally {
			removeFixture(value);
		}
	});

	it("allows existing and future paths contained by the real worktree", () => {
		const value = fixture();
		try {
			const guard = createConfinementGuard({ worktree: value.worktree });
			for (const [toolName, input] of [
				["read", { path: "nested/inside.txt" }],
				["grep", { path: "inside-link/inside.txt" }],
				["find", { path: "future/nested/file" }],
				["ls", { path: "nested" }],
				["git_diff", { path: "inside-link/inside.txt" }],
				["git_diff", { base: "HEAD" }],
			] as const) {
				expect(guard({ toolName, input })).toBeUndefined();
			}
		} finally {
			removeFixture(value);
		}
	});
});
