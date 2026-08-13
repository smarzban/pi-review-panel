// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { readFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { fileURLToPath } from "node:url";

/**
 * The package-owned prompt roles, in catalog order: the holistic baseline,
 * the generic-correctness lens, the ten specialist extras, and the
 * fix-verification check. The list is fixed: the registry accepts no config,
 * repository, or caller input.
 */
export const SHIPPED_ROLES = [
	"holistic",
	"correctness",
	"security",
	"tests",
	"contracts",
	"privacy",
	"migrations",
	"subtle-correctness",
	"simplification",
	"performance",
	"infrastructure",
	"specification-conformance",
	"fix-verification",
] as const;

export type PromptRole = (typeof SHIPPED_ROLES)[number];

/** One of the three role kinds: baseline review, specialist review lens, or advisory check. */
export type RoleKind = "holistic" | "specialist" | "check";

/**
 * The exact kind of every shipped role (AC-1). The registry derives kinds
 * from this code-side table alone, so a role-kind mismatch is impossible by
 * construction: any catalog drift is refused by the paired tests instead of
 * ever reaching a seat.
 */
export const ROLE_KINDS: Readonly<Record<PromptRole, RoleKind>> = {
	holistic: "holistic",
	correctness: "specialist",
	security: "specialist",
	tests: "specialist",
	contracts: "specialist",
	privacy: "specialist",
	migrations: "specialist",
	"subtle-correctness": "specialist",
	simplification: "specialist",
	performance: "specialist",
	infrastructure: "specialist",
	"specification-conformance": "specialist",
	"fix-verification": "check",
};

/**
 * The ten conditional specialist triggers (AC-5). Generic correctness is
 * deliberately absent: it may be explicitly selected without appearing in the
 * mandatory ten-trigger checklist, and its absence never makes that checklist
 * incomplete (AC-8).
 */
export const SPECIALIST_TRIGGERS = [
	"security",
	"tests",
	"contracts",
	"privacy",
	"migrations",
	"subtle-correctness",
	"simplification",
	"performance",
	"infrastructure",
	"specification-conformance",
] as const;

export type SpecialistTrigger = (typeof SPECIALIST_TRIGGERS)[number];

/** One resolved role: its kind plus the unchanged package-owned prompt bytes. */
export type RoleEntry = {
	kind: RoleKind;
	prompt: string;
};

/**
 * prompts/ directory resolved from this module's own location
 * (src/config/roles.ts -> package root is ../../ -> prompts/), never from
 * process.cwd(): the module may run from an arbitrary cwd.
 */
const PROMPTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"prompts",
);

/**
 * The package-owned role prompt table. Each shipped file is read unchanged
 * (no normalization, no trailing-newline stripping or adding: the files
 * carry no trailing newline) into a Map keyed by the exact role name. A Map
 * is prototype-safe: a hostile role name such as "constructor" or "__proto__"
 * cannot resolve through the prototype chain. A missing, duplicate, or
 * unreadable resource refuses before any seat starts. The caller may supply a
 * promptsDir only as a test seam; production always uses the package area.
 */
export function loadRoleTable(options?: {
	promptsDir?: string;
}): Map<string, RoleEntry> {
	const promptsDir = options?.promptsDir ?? PROMPTS_DIR;
	const table = new Map<string, RoleEntry>();
	for (const role of SHIPPED_ROLES) {
		const promptPath = path.join(promptsDir, `${role}.md`);
		let bytes: string;
		try {
			bytes = readFileSync(promptPath, "utf8");
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Prompt role registry refused: could not read shipped prompt "${promptPath}": ${cause}`,
			);
		}
		table.set(role, { kind: ROLE_KINDS[role], prompt: bytes });
	}
	return table;
}
