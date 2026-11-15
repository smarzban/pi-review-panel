// Builds the `review-panel` command into dist/ without bundling, keeping the
// source tree:
//
//   dist/src/...      every module under src/, the CLI in dist/src/cli/
//   dist/prompts/     the package-owned prompts
//
// The core finds its prompts at `../../prompts` from its own module
// (src/config/roles.ts). Keeping the tree makes
// that path land on dist/prompts, inside the package's tarball. dist/ is never
// committed: `npm pack` and `npm publish` build it (the `prepack` script).
import { chmodSync, cpSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(repoDir, "dist");

function typescriptFiles(dir) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => path.join(entry.parentPath, entry.name));
}

rmSync(outDir, { recursive: true, force: true });

await build({
	entryPoints: typescriptFiles(path.join(repoDir, "src")),
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
chmodSync(path.join(outDir, "src", "cli", "main.js"), 0o755);
