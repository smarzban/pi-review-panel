/**
 * Whether a process with this pid is running on this machine. The calling
 * process is always alive. `EPERM` means the pid exists under another user,
 * so it counts as alive: a reused pid errs toward keeping state, never toward
 * deleting something a live run still uses.
 */
export function isProcessAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EPERM"
		);
	}
}
