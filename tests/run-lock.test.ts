import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Liveness is mocked so a test can act at the exact moment a process has
 * judged a lock stale: that is where a second process can slip in.
 */
const hook = vi.hoisted(() => ({
	onStaleJudged: undefined as (() => void) | undefined,
	/** Stale judgements to let pass before `onStaleJudged` fires. */
	skip: 0,
}));

vi.mock("../src/run/liveness.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/run/liveness.js")>();
	return {
		isProcessAlive: (pid: unknown) => {
			const alive = real.isProcessAlive(pid);
			const act = hook.onStaleJudged;
			if (!alive && act !== undefined) {
				if (hook.skip > 0) {
					hook.skip -= 1;
					return alive;
				}
				hook.onStaleJudged = undefined;
				act();
			}
			return alive;
		},
	};
});

/**
 * Every write and link `record.ts` makes, by target path, so a test can see
 * how the lock comes into being. Everything passes through to the real fs.
 */
const fsLog = vi.hoisted(() => ({
	writes: [] as string[],
	links: [] as Array<{ target: string; body: string }>,
	/** When set, every link fails with this code, as on a filesystem without hard links. */
	linkErrorCode: undefined as string | undefined,
	/** When set, a write to this path fails with ENOSPC after it was opened. */
	failWriteTo: undefined as string | undefined,
	/** When set, closing this path fails with EIO (a deferred network write error). */
	failCloseOf: undefined as string | undefined,
	/** When set, each write to this path writes at most one byte. */
	shortWritesTo: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return {
		...real,
		writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
			fsLog.writes.push(String(args[0]));
			return real.writeFileSync(...args);
		},
		writeSync: (...args: Parameters<typeof real.writeSync>) => {
			const target = fsLog.failWriteTo;
			if (
				target !== undefined &&
				real.fstatSync(args[0]).ino ===
					real.statSync(target, { throwIfNoEntry: false })?.ino
			) {
				throw Object.assign(
					new Error("ENOSPC: no space left on device, write"),
					{
						code: "ENOSPC",
					},
				);
			}
			const short = fsLog.shortWritesTo;
			if (
				short !== undefined &&
				typeof args[1] !== "string" &&
				real.fstatSync(args[0]).ino ===
					real.statSync(short, { throwIfNoEntry: false })?.ino
			) {
				const buffer = args[1] as Buffer;
				const offset = typeof args[2] === "number" ? args[2] : 0;
				return real.writeSync(args[0], buffer, offset, 1);
			}
			return (real.writeSync as (...a: unknown[]) => number)(...args);
		},
		closeSync: (fd: number) => {
			const target = fsLog.failCloseOf;
			if (
				target !== undefined &&
				real.fstatSync(fd).ino ===
					real.statSync(target, { throwIfNoEntry: false })?.ino
			) {
				real.closeSync(fd);
				throw Object.assign(new Error("EIO: i/o error, close"), {
					code: "EIO",
				});
			}
			return real.closeSync(fd);
		},
		openSync: (...args: Parameters<typeof real.openSync>) => {
			const flags = args[1];
			const access = real.constants.O_WRONLY | real.constants.O_RDWR;
			const writing =
				typeof flags === "number" ? (flags & access) !== 0 : flags !== "r";
			if (flags !== undefined && writing) {
				fsLog.writes.push(String(args[0]));
			}
			return real.openSync(...args);
		},
		linkSync: (existing: string, target: string) => {
			if (fsLog.linkErrorCode !== undefined) {
				throw Object.assign(
					new Error(`${fsLog.linkErrorCode}: link not supported`),
					{ code: fsLog.linkErrorCode },
				);
			}
			fsLog.links.push({
				target: String(target),
				body: real.readFileSync(existing, "utf8"),
			});
			return real.linkSync(existing, target);
		},
	};
});

const { acquireRunLock, RUN_LOCK_FILE, RUN_LOCK_TAKEOVER_FILE } = await import(
	"../src/run/record.js"
);

function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	if (pid === undefined) {
		throw new Error("could not spawn a short-lived child");
	}
	return pid;
}

function sleeper(): ChildProcess & { pid: number } {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		stdio: "ignore",
	});
	if (child.pid === undefined) {
		throw new Error("could not spawn a sleeper");
	}
	return child as ChildProcess & { pid: number };
}

describe("stale run-lock takeover", () => {
	afterEach(() => {
		hook.onStaleJudged = undefined;
		hook.skip = 0;
	});

	it("lets only one of two takeovers that both judged the lock stale win", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid() })}\n`);
			// The second process runs its whole takeover at the moment the first
			// has judged the lock stale twice (before and after taking the
			// takeover file) and has not yet removed it.
			let second: { release?: () => void; error?: unknown } | undefined;
			hook.skip = 1;
			hook.onStaleJudged = () => {
				try {
					second = { release: acquireRunLock(record) };
				} catch (error) {
					second = { error };
				}
			};
			let first: { release?: () => void; error?: unknown };
			try {
				first = { release: acquireRunLock(record) };
			} catch (error) {
				first = { error };
			}

			const winners = [first, second].filter(
				(entry) => entry?.release !== undefined,
			);
			expect(winners).toHaveLength(1);
			expect(first.release).toBeDefined();
			expect(String(second?.error)).toMatch(/is being taken over/);
			// The winner's lock is the one on disk, and only it can release it.
			first.release?.();
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("refuses while another process holds the takeover file, and leaves the lock alone", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			const staleLock = `${JSON.stringify({ pid: deadPid() })}\n`;
			writeFileSync(lockPath, staleLock);
			const takeoverPath = path.join(record, RUN_LOCK_TAKEOVER_FILE);
			writeFileSync(takeoverPath, `${JSON.stringify({ pid: process.pid })}\n`);

			expect(() => acquireRunLock(record)).toThrow(
				/lock is being taken over by another process; if no review_panel run is active, delete .*run\.lock\.takeover and try again/,
			);
			expect(readFileSync(lockPath, "utf8")).toBe(staleLock);
			expect(existsSync(takeoverPath)).toBe(true);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("never deletes a lock another process took after this one judged the old lock stale", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		const other = sleeper();
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid() })}\n`);
			const othersLock = `${JSON.stringify({ pid: other.pid })}\n`;
			// The other process wins the takeover right after this one read the
			// dead holder.
			hook.onStaleJudged = () => {
				rmSync(lockPath);
				writeFileSync(lockPath, othersLock, { flag: "wx" });
			};

			expect(() => acquireRunLock(record)).toThrow(
				new RegExp(`still in progress \\(pid ${other.pid}\\)`),
			);
			expect(readFileSync(lockPath, "utf8")).toBe(othersLock);
		} finally {
			other.kill();
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("takes over a lock left by a dead process and releases it", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid() })}\n`);
			const release = acquireRunLock(record);
			expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
			release();
			expect(() => readFileSync(lockPath)).toThrow();
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it.each([
		["empty", ""],
		["partial", '{"pid":'],
	])(
		"refuses a lock whose body is %s as being written, and leaves it alone",
		(_name, body) => {
			const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
			try {
				const lockPath = path.join(record, RUN_LOCK_FILE);
				writeFileSync(lockPath, body);

				expect(() => acquireRunLock(record)).toThrow(
					/lock .*run\.lock is being written by another process, or was left unfinished by one that crashed; if no review_panel run is active, delete it and try again/,
				);
				expect(readFileSync(lockPath, "utf8")).toBe(body);
				expect(existsSync(path.join(record, RUN_LOCK_TAKEOVER_FILE))).toBe(
					false,
				);
			} finally {
				rmSync(record, { recursive: true, force: true });
			}
		},
	);
});

describe("publishing the run lock", () => {
	it("links a finished lock into place: it is never written in place, so no reader sees it empty", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			fsLog.writes.length = 0;
			fsLog.links.length = 0;

			const release = acquireRunLock(record);

			expect(fsLog.writes).not.toContain(lockPath);
			const published = fsLog.links.filter((link) => link.target === lockPath);
			expect(published).toHaveLength(1);
			expect(JSON.parse(published[0]?.body ?? "").pid).toBe(process.pid);
			expect(readFileSync(lockPath, "utf8")).toBe(published[0]?.body);
			// The temp file the lock was linked from is gone.
			expect(readdirSync(record)).toEqual([RUN_LOCK_FILE]);
			release();
			expect(readdirSync(record)).toEqual([]);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});
});

describe("the run lock on a filesystem without hard links", () => {
	afterEach(() => {
		fsLog.linkErrorCode = undefined;
		fsLog.failWriteTo = undefined;
		fsLog.failCloseOf = undefined;
		fsLog.shortWritesTo = undefined;
	});

	it("leaves no lock behind when closing the in-place lock fails", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			fsLog.linkErrorCode = "ENOTSUP";
			fsLog.failCloseOf = lockPath;

			expect(() => acquireRunLock(record)).toThrow(/EIO/);
			expect(readdirSync(record)).toEqual([]);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("keeps the original write error when the close after it also fails", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			fsLog.linkErrorCode = "ENOTSUP";
			fsLog.failWriteTo = lockPath;
			fsLog.failCloseOf = lockPath;

			expect(() => acquireRunLock(record)).toThrow(/ENOSPC/);
			expect(readdirSync(record)).toEqual([]);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("writes the whole in-place lock even when each write is short", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			fsLog.linkErrorCode = "ENOTSUP";
			fsLog.shortWritesTo = lockPath;

			const release = acquireRunLock(record);

			expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
			release();
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("leaves no lock behind when the in-place write fails", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			fsLog.linkErrorCode = "ENOTSUP";
			fsLog.failWriteTo = lockPath;

			expect(() => acquireRunLock(record)).toThrow(/ENOSPC/);
			expect(readdirSync(record)).toEqual([]);

			// Once space is back, the next run takes the lock.
			fsLog.failWriteTo = undefined;
			const release = acquireRunLock(record);
			release();
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it.each(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"])(
		"falls back to an exclusive write when link fails with %s",
		(code) => {
			const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
			try {
				const lockPath = path.join(record, RUN_LOCK_FILE);
				fsLog.linkErrorCode = code;

				const release = acquireRunLock(record);

				expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(
					process.pid,
				);
				expect(readdirSync(record)).toEqual([RUN_LOCK_FILE]);
				// A second taker is still refused while the lock is held.
				expect(() => acquireRunLock(record)).toThrow(/still in progress/);
				release();
				expect(readdirSync(record)).toEqual([]);
			} finally {
				rmSync(record, { recursive: true, force: true });
			}
		},
	);

	it("takes over a stale lock through the fallback too", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			const lockPath = path.join(record, RUN_LOCK_FILE);
			writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid() })}\n`);
			fsLog.linkErrorCode = "ENOTSUP";

			const release = acquireRunLock(record);

			expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
			expect(readdirSync(record)).toEqual([RUN_LOCK_FILE]);
			release();
			expect(readdirSync(record)).toEqual([]);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});

	it("still surfaces a link error that is not about missing hard-link support", () => {
		const record = mkdtempSync(path.join(tmpdir(), "run-lock-"));
		try {
			fsLog.linkErrorCode = "EIO";
			expect(() => acquireRunLock(record)).toThrow(/EIO/);
			expect(readdirSync(record)).toEqual([]);
		} finally {
			rmSync(record, { recursive: true, force: true });
		}
	});
});
