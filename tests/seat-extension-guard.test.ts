import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createConfinementGuard,
	type GuardHost,
} from "../src/seat/seat-extension.js";

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

/**
 * A Windows host on any CI runner: `path.win32` rules, a fake volume, and a
 * process cwd on drive D:, so a drive-less absolute path resolves onto D: as it
 * does for a seat whose worktree is `D:\\a\\repo`.
 */
function windowsHost(platform: NodeJS.Platform = "win32"): GuardHost {
	const existing = new Set(
		[
			"A:\\",
			"A:\\repo",
			"A:\\repo\\x",
			"C:\\",
			"D:\\",
			"D:\\a",
			"D:\\a\\repo",
			"D:\\a\\repo\\x",
		].map((value) => value.toLowerCase()),
	);
	const exists = (value: string) => existing.has(value.toLowerCase());
	return {
		platform,
		path: path.win32,
		homedir: () => "C:\\Users\\seat",
		existsSync: exists,
		realpathSync: (value) => {
			if (exists(value) === false) {
				throw new Error(`ENOENT: ${value}`);
			}
			return value;
		},
	};
}

describe("SDK seat confinement on a Windows host", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function windowsGuard(worktree = "D:\\a\\repo", platform?: NodeJS.Platform) {
		vi.spyOn(process, "cwd").mockReturnValue("D:\\a\\repo");
		return createConfinementGuard({ worktree, host: windowsHost(platform) });
	}

	it("allows native paths inside the worktree and refuses another drive", () => {
		const guard = windowsGuard();
		for (const toolName of ["read", "grep", "find", "ls", "git_diff"]) {
			for (const value of ["x", "D:\\a\\repo\\x", "d:\\A\\Repo\\x"]) {
				expect(guard({ toolName, input: { path: value } })).toBeUndefined();
			}
			expect(guard({ toolName, input: { path: "A:\\repo\\x" } })).toEqual(
				refusal(),
			);
		}
	});

	it("refuses MSYS, WSL and Cygwin drive paths that Pi reads from another drive", () => {
		// The first six pair each input with the worktree where its drive-less
		// reading would land (D: is the cwd drive), so only Pi's rewrite onto A:
		// makes it an escape. The last two are the WSL and Cygwin forms against
		// the D:\a\repo worktree itself.
		for (const [worktree, value] of [
			["D:\\a\\repo", "/a/repo/x"],
			["D:\\a\\repo", "/A/repo/x"],
			["D:\\a\\repo", "@/a/repo/x"],
			["D:\\mnt\\a\\repo", "/mnt/a/repo/x"],
			["D:\\cygdrive\\a\\repo", "/cygdrive/a/repo/x"],
			["D:\\a", "/a"],
			["D:\\a\\repo", "/mnt/a/repo/x"],
			["D:\\a\\repo", "/cygdrive/a/repo/x"],
		] as const) {
			const guard = windowsGuard(worktree);
			for (const toolName of ["read", "grep", "find", "ls", "git_diff"]) {
				expect(guard({ toolName, input: { path: value } })).toEqual(refusal());
			}
		}
	});

	it("allows MSYS, WSL and Cygwin drive paths that Pi reads inside the worktree", () => {
		const guard = windowsGuard();
		for (const toolName of ["read", "grep", "find", "ls", "git_diff"]) {
			for (const value of [
				"/d/a/repo/x",
				"/D/a/repo/x",
				"/mnt/d/a/repo/x",
				"/cygdrive/d/a/repo/x",
				"@/d/a/repo/x",
			]) {
				expect(guard({ toolName, input: { path: value } })).toBeUndefined();
			}
		}
	});

	it("resolves against the worktree as Pi normalizes it, shell form included", () => {
		const guard = windowsGuard("/d/a/repo");
		expect(
			guard({ toolName: "read", input: { path: "D:\\a\\repo\\x" } }),
		).toBeUndefined();
		expect(guard({ toolName: "read", input: { path: "x" } })).toBeUndefined();
		expect(guard({ toolName: "read", input: { path: "/a/repo/x" } })).toEqual(
			refusal(),
		);
	});

	it("rewrites shell paths only on win32, as Pi does", () => {
		// Same Windows path rules and D: cwd, but a non-win32 platform: Pi leaves
		// `/a/repo/x` alone, so it resolves onto D: inside the worktree.
		const guard = windowsGuard("D:\\a\\repo", "linux");
		expect(
			guard({ toolName: "read", input: { path: "/a/repo/x" } }),
		).toBeUndefined();
	});
});
