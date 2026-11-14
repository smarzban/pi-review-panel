import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** A `gh` that always fails stands first on PATH, so no test can reach GitHub. */
const FAKE_GH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"tests",
	"fixtures",
	"fake-gh",
);

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// The built-bin tests run dist/, so every run rebuilds it first.
		globalSetup: ["tests/build-dist.ts"],
		testTimeout: 60_000,
		env: { PATH: `${FAKE_GH}${path.delimiter}${process.env.PATH ?? ""}` },
	},
});
