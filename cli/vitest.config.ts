import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// The built-bin tests run dist/, so every run rebuilds it first.
		globalSetup: ["tests/build-dist.ts"],
		testTimeout: 60_000,
	},
});
