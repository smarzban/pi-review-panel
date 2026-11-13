// Builds the CLI into dist/ without bundling, keeping the source tree:
//
//   dist/src/...      the shared core from ../src (the Pi package's source)
//   dist/cli/src/...  this CLI
//   dist/prompts/     the package-owned prompts
//
// The core finds its prompts at `../../prompts` from its own module
// (src/config/roles.ts, src/config/audit-passes.ts). Keeping the tree makes
// that path land on dist/prompts, inside this package's tarball.
import { chmodSync, cpSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(cliDir);
const outDir = path.join(cliDir, "dist");

// The Pi tool envelope is the Pi package's entry point; it imports typebox,
// which the CLI neither needs nor depends on.
const EXCLUDED = new Set([
	path.join(repoDir, "src", "tool", "review-panel.ts"),
]);

function typescriptFiles(dir) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.join(entry.parentPath, entry.name))
		.filter((file) => !EXCLUDED.has(file));
}

rmSync(outDir, { recursive: true, force: true });

await build({
	entryPoints: [
		...typescriptFiles(path.join(repoDir, "src")),
		...typescriptFiles(path.join(cliDir, "src")),
	],
	outbase: repoDir,
	outdir: outDir,
	bundle: false,
	format: "esm",
	platform: "node",
	target: "node26",
	logLevel: "warning",
});

cpSync(path.join(repoDir, "prompts"), path.join(outDir, "prompts"), {
	recursive: true,
});
chmodSync(path.join(outDir, "cli", "src", "main.js"), 0o755);
