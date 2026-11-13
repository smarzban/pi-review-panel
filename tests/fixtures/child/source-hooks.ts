import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/experimental";

/**
 * Lets a plain `node` child process load this repository's TypeScript the
 * way Pi and vitest do: a relative `.js` import from a `.ts` file resolves to
 * the `.ts` file, and each `.ts` file is transformed (Node's own type
 * stripping refuses parameter properties). The transform is the one vitest
 * already installs (rolldown, through vite), declared as an exact devDependency.
 * Load it with `node --import <this file> <script.ts>`.
 */
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier.startsWith(".") &&
			specifier.endsWith(".js") &&
			context.parentURL?.endsWith(".ts")
		) {
			const candidate = new URL(
				`${specifier.slice(0, -".js".length)}.ts`,
				context.parentURL,
			);
			if (existsSync(fileURLToPath(candidate))) {
				return nextResolve(candidate.href, context);
			}
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (!url.startsWith("file:") || !url.endsWith(".ts")) {
			return nextLoad(url, context);
		}
		const file = fileURLToPath(url);
		const { code, errors } = transformSync(file, readFileSync(file, "utf8"), {
			lang: "ts",
		});
		if (errors.length > 0) {
			throw new Error(`${file}: ${errors[0]?.message}`);
		}
		return { format: "module", source: code, shortCircuit: true };
	},
});
