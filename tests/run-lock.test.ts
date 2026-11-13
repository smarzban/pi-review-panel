import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Liveness is mocked so a test can act at the exact moment a process has
 * judged a lock stale: that is where a second process can slip in.
 */
const hook = vi.hoisted(() => ({
	onStaleJudged: undefined as (() => void) | undefined,
}));

vi.mock("../src/run/liveness.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/run/liveness.js")>();
	return {
		isProcessAlive: (pid: unknown) => {
			const alive = real.isProcessAlive(pid);
			const act = hook.onStaleJudged;
			if (!alive && act !== undefined) {
				hook.onStaleJudged = undefined;
				act();
			}
			return alive;
		},
	};
});

const { acquireRunLock, RUN_LOCK_FILE } = await import("../src/run/record.js");

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
});
