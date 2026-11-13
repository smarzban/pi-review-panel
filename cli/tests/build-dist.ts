/**
 * Vitest global setup: rebuild dist/ before any test runs, so the built-bin
 * tests can never pass against a bin built from older sources.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export default function buildDist(): void {
	execFileSync(process.execPath, ["build.mjs"], {
		cwd: path.resolve(import.meta.dirname, ".."),
		stdio: "inherit",
	});
}
