import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkRecordKey,
	loadRecordKey,
	planMac,
	RECORD_KEY_FILE,
	recordKeyPath,
	seatMac,
} from "../src/run/record-key.js";
import { testPlanMac, testSeatMac } from "./fixtures/record-key.js";

// Every test works in a temporary config folder; none touches the owner's
// real ~/.pi-review-panel/.
let root: string;
let configDir: string;
let repoDir: string;
let keyPath: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "record-key-"));
	configDir = path.join(root, "config");
	repoDir = path.join(root, "repo");
	// 0700 explicitly: a bare mkdirSync under a permissive umask would make a
	// group-writable folder, which diagnose warns about.
	mkdirSync(configDir, { mode: 0o700 });
	chmodSync(configDir, 0o700);
	mkdirSync(repoDir);
	keyPath = recordKeyPath(path.join(configDir, "config.json"));
});

afterEach(() => {
	vi.restoreAllMocks();
	chmodSync(configDir, 0o700);
	rmSync(root, { recursive: true, force: true });
});

const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("the owner's record key", () => {
	it("lives beside the owner config", () => {
		expect(keyPath).toBe(path.join(configDir, RECORD_KEY_FILE));
		expect(RECORD_KEY_FILE).toBe("record-key");
	});

	it.skipIf(process.platform === "win32")(
		"is created on first use as 32 random bytes with mode 0600, then reused",
		() => {
			const key = loadRecordKey(keyPath, { create: true, repoDir });
			expect(key).toHaveLength(32);
			const stats = lstatSync(keyPath);
			expect(stats.isFile()).toBe(true);
			expect(stats.mode & 0o777).toBe(0o600);
			expect(readFileSync(keyPath).equals(key)).toBe(true);
			expect(
				loadRecordKey(keyPath, { create: true, repoDir }).equals(key),
			).toBe(true);
			expect(
				loadRecordKey(keyPath, { create: false, repoDir }).equals(key),
			).toBe(true);
		},
	);

	it("is never created when the caller only reads it", () => {
		expect(() => loadRecordKey(keyPath, { create: false, repoDir })).toThrow(
			/there is no record key at .*record-key/,
		);
		expect(() => lstatSync(keyPath)).toThrow();
	});

	it("refuses a key that is a symlink", () => {
		const elsewhere = path.join(root, "elsewhere");
		writeFileSync(elsewhere, Buffer.alloc(32, 1), { mode: 0o600 });
		symlinkSync(elsewhere, keyPath);
		expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
			/is a symlink and is refused/,
		);
	});

	it("refuses a key that is a dangling symlink, and creates nothing through it", () => {
		const target = path.join(root, "target");
		symlinkSync(target, keyPath);
		expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
			/symlink/,
		);
		expect(() => lstatSync(target)).toThrow();
	});

	it("refuses a key that is not a regular file", () => {
		mkdirSync(keyPath);
		expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
			/not a regular file/,
		);
	});

	it.skipIf(process.platform === "win32")(
		"refuses a key readable by group or other users",
		() => {
			writeFileSync(keyPath, Buffer.alloc(32, 1));
			chmodSync(keyPath, 0o644);
			expect(() => loadRecordKey(keyPath, { create: false, repoDir })).toThrow(
				/readable by group or other users/,
			);
		},
	);

	it("refuses a key that is not 32 bytes, such as one left empty", () => {
		writeFileSync(keyPath, "", { mode: 0o600 });
		expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
			/is not 32 bytes/,
		);
	});

	it("refuses a key inside the reviewed repository", () => {
		const inside = recordKeyPath(path.join(repoDir, "config.json"));
		expect(() => loadRecordKey(inside, { create: true, repoDir })).toThrow(
			/inside the reviewed repository/,
		);
		expect(() => lstatSync(inside)).toThrow();
		// Also through a symlinked folder that resolves into the repository.
		const linked = path.join(root, "linked");
		symlinkSync(repoDir, linked);
		expect(() =>
			loadRecordKey(recordKeyPath(path.join(linked, "config.json")), {
				create: true,
				repoDir,
			}),
		).toThrow(/inside the reviewed repository/);
		expect(statSync(repoDir).isDirectory()).toBe(true);
	});
});

describe("the record key's owner and folder", () => {
	it.skipIf(!posix)("refuses a key file another user owns", () => {
		loadRecordKey(keyPath, { create: true, repoDir });
		const me = process.getuid?.() ?? 0;
		vi.spyOn(process, "getuid").mockReturnValue(me + 1);
		expect(() => loadRecordKey(keyPath, { create: false, repoDir })).toThrow(
			/is not owned by you and is refused/,
		);
	});

	it.skipIf(!posix)(
		"skips the owner check where process.getuid does not exist",
		() => {
			const key = loadRecordKey(keyPath, { create: true, repoDir });
			const original = Object.getOwnPropertyDescriptor(process, "getuid");
			Object.defineProperty(process, "getuid", {
				value: undefined,
				configurable: true,
			});
			try {
				expect(
					loadRecordKey(keyPath, { create: false, repoDir }).equals(key),
				).toBe(true);
			} finally {
				if (original === undefined) {
					Reflect.deleteProperty(process, "getuid");
				} else {
					Object.defineProperty(process, "getuid", original);
				}
			}
		},
	);

	it.skipIf(!posix)(
		"refuses a key folder other users can write, with or without a key in it",
		() => {
			for (const mode of [0o707, 0o757, 0o777, 0o1777]) {
				chmodSync(configDir, mode);
				expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
					/record-key is refused: its folder .* is writable by other users/,
				);
			}
			expect(readdirSync(configDir)).toEqual([]);
			chmodSync(configDir, 0o700);
			loadRecordKey(keyPath, { create: true, repoDir });
			chmodSync(configDir, 0o777);
			expect(() => loadRecordKey(keyPath, { create: false, repoDir })).toThrow(
				/is writable by other users/,
			);
		},
	);

	it.skipIf(!posix)(
		"accepts a group-writable key folder (the umask 002 default), creating and reading the key",
		() => {
			for (const mode of [0o775, 0o770]) {
				rmSync(keyPath, { force: true });
				chmodSync(configDir, mode);
				const created = loadRecordKey(keyPath, { create: true, repoDir });
				expect(
					loadRecordKey(keyPath, { create: false, repoDir }).equals(created),
				).toBe(true);
			}
		},
	);

	it.skipIf(!posix)(
		"suggests chmod go-w only for a folder you own that is not sticky",
		() => {
			const fixFor = (): string | undefined => {
				try {
					loadRecordKey(keyPath, { create: true, repoDir });
				} catch (error) {
					return (error as { fix?: string }).fix;
				}
				return undefined;
			};
			chmodSync(configDir, 0o777);
			expect(fixFor()).toMatch(new RegExp(`chmod go-w ${configDir}`));
			// A sticky shared folder such as /tmp: chmod would break it for
			// everyone, so move the config instead.
			chmodSync(configDir, 0o1777);
			const sticky = fixFor();
			expect(sticky).not.toMatch(/chmod/);
			expect(sticky).toMatch(/PI_REVIEW_PANEL_CONFIG/);
			// A folder another user owns: chmod would fail anyway.
			chmodSync(configDir, 0o777);
			const me = process.getuid?.() ?? 0;
			vi.spyOn(process, "getuid").mockReturnValue(me + 1);
			const foreign = fixFor();
			expect(foreign).not.toMatch(/chmod/);
			expect(foreign).toMatch(/PI_REVIEW_PANEL_CONFIG/);
			expect(readdirSync(configDir)).toEqual([]);
		},
	);

	it("accepts a key folder that is a symlink to a safe folder", () => {
		const linked = path.join(root, "linked-config");
		symlinkSync(configDir, linked);
		const key = loadRecordKey(path.join(linked, RECORD_KEY_FILE), {
			create: true,
			repoDir,
		});
		expect(readFileSync(keyPath).equals(key)).toBe(true);
	});
});

describe("the record key creation race", () => {
	it("gives two creators one key: the loser reads the winner's bytes", () => {
		let other: Buffer | undefined;
		const mine = loadRecordKey(keyPath, {
			create: true,
			repoDir,
			// The second creator runs in full between the first one's temp
			// write and its link, so the first one's link meets EEXIST.
			beforeLink: () => {
				other = loadRecordKey(keyPath, { create: true, repoDir });
			},
		});
		expect(other).toBeDefined();
		expect(mine.equals(other as Buffer)).toBe(true);
		expect(readFileSync(keyPath).equals(mine)).toBe(true);
		expect(readdirSync(configDir)).toEqual([RECORD_KEY_FILE]);
	});
});

describe("checking the record key without writing (diagnose)", () => {
	function listing(): string[] {
		return readdirSync(configDir).sort();
	}

	it("passes a writable 0700 folder with no key yet, and creates nothing", () => {
		writeFileSync(path.join(configDir, "config.json"), "{}", { mode: 0o600 });
		expect(checkRecordKey(keyPath, { repoDir })).toBeUndefined();
		expect(listing()).toEqual(["config.json"]);
	});

	it("passes a valid key and leaves it untouched", () => {
		const key = loadRecordKey(keyPath, { create: true, repoDir });
		const before = statSync(keyPath);
		expect(checkRecordKey(keyPath, { repoDir })).toBeUndefined();
		expect(listing()).toEqual([RECORD_KEY_FILE]);
		expect(readFileSync(keyPath).equals(key)).toBe(true);
		expect(statSync(keyPath).mtimeMs).toBe(before.mtimeMs);
	});

	it("says nothing when the config folder does not exist: the configuration row covers that", () => {
		const missing = path.join(root, "missing", RECORD_KEY_FILE);
		expect(checkRecordKey(missing, { repoDir })).toBeUndefined();
		expect(() => lstatSync(path.dirname(missing))).toThrow();
	});

	it.skipIf(!posix || isRoot)(
		"reports a read-only folder with no key, and how to fix it",
		() => {
			chmodSync(configDir, 0o555);
			const problem = checkRecordKey(keyPath, { repoDir });
			expect(problem?.cause).toMatch(
				/record key .*record-key cannot be created: its folder .* is not writable/,
			);
			expect(problem?.fix).toMatch(/chmod u\+w/);
			expect(problem?.fix).toMatch(/PI_REVIEW_PANEL_CONFIG/);
			expect(listing()).toEqual([]);
			// The same folder refuses a review's create, for the same cause.
			expect(() => loadRecordKey(keyPath, { create: true, repoDir })).toThrow(
				/could not be created/,
			);
		},
	);

	it.skipIf(!posix)("reports each unusable key with its cause and fix", () => {
		const cases: Array<{
			plant: () => void;
			cause: RegExp;
			fix: RegExp;
		}> = [
			{
				plant: () => {
					const elsewhere = path.join(root, "elsewhere");
					writeFileSync(elsewhere, Buffer.alloc(32, 1), { mode: 0o600 });
					symlinkSync(elsewhere, keyPath);
				},
				cause: /is a symlink and is refused/,
				fix: /regular file/,
			},
			{
				plant: () => {
					writeFileSync(keyPath, Buffer.alloc(32, 1));
					chmodSync(keyPath, 0o644);
				},
				cause: /readable by group or other users/,
				fix: /chmod 600/,
			},
			{
				plant: () => writeFileSync(keyPath, "short", { mode: 0o600 }),
				cause: /is not 32 bytes/,
				fix: /Delete/,
			},
			{
				plant: () => mkdirSync(keyPath),
				cause: /not a regular file/,
				fix: /Remove/,
			},
			{
				plant: () => {
					chmodSync(configDir, 0o777);
				},
				cause: /is writable by other users/,
				fix: /chmod go-w/,
			},
		];
		for (const { plant, cause, fix } of cases) {
			rmSync(keyPath, { recursive: true, force: true });
			chmodSync(configDir, 0o700);
			plant();
			const before = listing();
			const problem = checkRecordKey(keyPath, { repoDir });
			expect(problem?.cause).toMatch(cause);
			expect(problem?.cause).toContain(keyPath);
			expect(problem?.fix).toMatch(fix);
			expect(listing()).toEqual(before);
		}
	});

	it.skipIf(!posix)(
		"warns, without blocking, about a group-writable folder, with or without a key",
		() => {
			chmodSync(configDir, 0o775);
			const empty = checkRecordKey(keyPath, { repoDir });
			expect(empty?.warning).toBe(true);
			expect(empty?.cause).toMatch(
				/record key .*record-key: its folder .* is writable by its group/,
			);
			expect(empty?.fix).toMatch(new RegExp(`chmod g-w ${configDir}`));
			expect(listing()).toEqual([]);
			chmodSync(configDir, 0o700);
			loadRecordKey(keyPath, { create: true, repoDir });
			chmodSync(configDir, 0o775);
			expect(checkRecordKey(keyPath, { repoDir })?.warning).toBe(true);
			expect(listing()).toEqual([RECORD_KEY_FILE]);
		},
	);

	it.skipIf(!posix)(
		"reports a blocking key problem, not the warning, in a group-writable folder",
		() => {
			writeFileSync(keyPath, Buffer.alloc(32, 1));
			chmodSync(keyPath, 0o644);
			chmodSync(configDir, 0o775);
			const problem = checkRecordKey(keyPath, { repoDir });
			expect(problem?.warning).toBeUndefined();
			expect(problem?.cause).toMatch(/readable by group or other users/);
		},
	);

	it.skipIf(!posix)("gives no warning for a folder only you can write", () => {
		for (const mode of [0o700, 0o755]) {
			chmodSync(configDir, mode);
			expect(checkRecordKey(keyPath, { repoDir })).toBeUndefined();
		}
	});

	it.skipIf(!posix)("reports a key another user owns", () => {
		loadRecordKey(keyPath, { create: true, repoDir });
		const me = process.getuid?.() ?? 0;
		vi.spyOn(process, "getuid").mockReturnValue(me + 1);
		const problem = checkRecordKey(keyPath, { repoDir });
		expect(problem?.cause).toMatch(/is not owned by you/);
		expect(problem?.fix).toMatch(/chown|Delete/);
	});

	it("reports a key inside the reviewed repository", () => {
		const inside = recordKeyPath(path.join(repoDir, "config.json"));
		const problem = checkRecordKey(inside, { repoDir });
		expect(problem?.cause).toMatch(/inside the reviewed repository/);
		expect(problem?.fix).toMatch(/PI_REVIEW_PANEL_CONFIG/);
		expect(() => lstatSync(inside)).toThrow();
	});
});

describe("record MACs", () => {
	const key = Buffer.alloc(32, 3);

	it("match the documented format", () => {
		const plan = planMac(key, "run-a", "{}\n");
		expect(plan).toBe(testPlanMac("run-a", "{}\n", key));
		expect(seatMac(key, "run-a", plan, 2, "{}\n")).toBe(
			testSeatMac("run-a", plan, 2, "{}\n", key),
		);
	});

	it("bind the run id, the plan and the seat index", () => {
		const plan = planMac(key, "run-a", "{}\n");
		expect(planMac(key, "run-b", "{}\n")).not.toBe(plan);
		const seat = seatMac(key, "run-a", plan, 0, "{}\n");
		expect(seatMac(key, "run-b", plan, 0, "{}\n")).not.toBe(seat);
		expect(
			seatMac(key, "run-a", planMac(key, "run-a", "[]\n"), 0, "{}\n"),
		).not.toBe(seat);
		expect(seatMac(key, "run-a", plan, 1, "{}\n")).not.toBe(seat);
		expect(seatMac(Buffer.alloc(32, 4), "run-a", plan, 0, "{}\n")).not.toBe(
			seat,
		);
	});
});
