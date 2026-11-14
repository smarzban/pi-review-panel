import { execFileSync } from "node:child_process";

/** Only a full hex object id; never something git could read as an option. */
export function isOid(value: unknown): value is string {
	return (
		typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)
	);
}

/** True when `oid` names a commit this repository holds. */
export function commitResolves(repoDir: string, oid: string): boolean {
	try {
		execFileSync("git", ["cat-file", "-e", `${oid}^{commit}`], {
			cwd: repoDir,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}
