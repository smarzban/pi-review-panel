import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package-owned menu for advisory whole-repository audits. */
export const AUDIT_PASSES = [
	"code-health",
	"docs",
	"tests",
	"security",
	"over-engineering",
	"observability",
	"operability",
	"ux",
] as const;

export type AuditPass = (typeof AUDIT_PASSES)[number];

/** Baseline passes for an unscoped periodic sweep. Situational passes are opt-in. */
export const AUDIT_DEFAULT_PASSES = [
	"code-health",
	"over-engineering",
	"tests",
	"security",
] as const satisfies readonly AuditPass[];

const PROMPTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"prompts",
);

/** Reads the package-owned prompt bytes for every audit menu entry. */
export function loadAuditPassTable(options?: {
	promptsDir?: string;
}): Map<string, string> {
	const promptsDir = options?.promptsDir ?? PROMPTS_DIR;
	const table = new Map<string, string>();
	for (const pass of AUDIT_PASSES) {
		const promptPath = path.join(promptsDir, `audit-${pass}.md`);
		try {
			table.set(pass, readFileSync(promptPath, "utf8"));
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Audit pass registry refused: could not read shipped prompt "${promptPath}": ${cause}`,
			);
		}
	}
	return table;
}
