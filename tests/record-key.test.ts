import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
	mkdirSync(configDir);
	mkdirSync(repoDir);
	keyPath = recordKeyPath(path.join(configDir, "config.json"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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
