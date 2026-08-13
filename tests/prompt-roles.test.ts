// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	loadRoleTable,
	type PromptRole,
	ROLE_KINDS,
	SHIPPED_ROLES,
	SPECIALIST_TRIGGERS,
} from "../src/config/roles.js";

/**
 * The shipped prompt roles with their exact kinds, pinned verbatim.
 */
const EXPECTED_ROLES: Array<{
	name: PromptRole;
	kind: "holistic" | "specialist" | "check";
}> = [
	{ name: "holistic", kind: "holistic" },
	{ name: "correctness", kind: "specialist" },
	{ name: "security", kind: "specialist" },
	{ name: "tests", kind: "specialist" },
	{ name: "contracts", kind: "specialist" },
	{ name: "privacy", kind: "specialist" },
	{ name: "migrations", kind: "specialist" },
	{ name: "subtle-correctness", kind: "specialist" },
	{ name: "simplification", kind: "specialist" },
	{ name: "performance", kind: "specialist" },
	{ name: "infrastructure", kind: "specialist" },
	{ name: "specification-conformance", kind: "specialist" },
	{ name: "fix-verification", kind: "check" },
];

/** The domain keyword each prompt must stay within (semantic oracle, AC-2). */
const ROLE_KEYWORDS: Record<PromptRole, string> = {
	holistic: "holistic",
	correctness: "correctness",
	security: "security",
	tests: "tests",
	contracts: "contracts",
	privacy: "privacy",
	migrations: "migrations",
	"subtle-correctness": "subtle correctness",
	simplification: "simplification",
	performance: "performance",
	infrastructure: "infrastructure",
	"specification-conformance": "specification",
	"fix-verification": "fix",
};

/**
 * Language a package-owned role prompt must never carry (AC-2): no verdict,
 * no quorum or agreement arithmetic, no approval, and no merge-gating
 * instruction. "merge-relevant" in the holistic scope is not a gate, so the
 * pattern requires the gate/gating word after the separator.
 */
const FORBIDDEN =
	/\b(verdict|quorum|approve|approval|agreement|recommend|merge\s*[- ]?(gate|gating))\b/i;

describe("prompt role registry", () => {
	it("enumerates the shipped role names in order", () => {
		expect([...SHIPPED_ROLES]).toEqual(EXPECTED_ROLES.map(({ name }) => name));
	});

	it("assigns each role exactly one kind and admits no extra kinds (AC-1)", () => {
		expect(Object.keys(ROLE_KINDS).sort()).toEqual([...SHIPPED_ROLES].sort());
		for (const { name, kind } of EXPECTED_ROLES) {
			expect(ROLE_KINDS[name]).toBe(kind);
		}
	});

	it("keeps generic correctness out of the ten specialist triggers (AC-8)", () => {
		expect([...SPECIALIST_TRIGGERS]).toEqual([
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
		]);
		expect(SPECIALIST_TRIGGERS).not.toContain("correctness");
	});

	it("loads every shipped role prompt byte-identical with its kind (AC-1)", () => {
		const table = loadRoleTable();
		expect(table).toBeInstanceOf(Map);
		expect([...table.keys()].sort()).toEqual([...SHIPPED_ROLES].sort());
		for (const { name, kind } of EXPECTED_ROLES) {
			const entry = table.get(name);
			expect(entry, `${name} entry present`).toBeDefined();
			if (entry === undefined) {
				continue;
			}
			expect(entry.kind).toBe(kind);
			const bytes = readFileSync(
				fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url)),
				"utf8",
			);
			expect(entry.prompt, `${name}.md bytes unchanged`).toBe(bytes);
			expect(bytes.endsWith("\n"), `${name}.md has no trailing newline`).toBe(
				false,
			);
			expect(bytes.endsWith("\r"), `${name}.md has no trailing CR`).toBe(false);
		}
	});

	it("does not resolve prototype-chain hostile role names", () => {
		const table = loadRoleTable();
		expect(table.get("constructor")).toBeUndefined();
		expect(table.get("__proto__")).toBeUndefined();
		expect(table.has("constructor")).toBe(false);
		expect(table.has("__proto__")).toBe(false);
	});

	it("refuses a missing or unreadable role resource before any seat (AC-1)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "prompt-roles-"));
		try {
			let error: unknown;
			try {
				loadRoleTable({ promptsDir: dir });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Prompt role registry refused",
			);
			expect((error as Error).message).toContain("holistic.md");

			// A single missing file among otherwise present ones also refuses.
			writeFileSync(path.join(dir, "holistic.md"), "holistic");
			writeFileSync(path.join(dir, "correctness.md"), "correctness");
			error = undefined;
			try {
				loadRoleTable({ promptsDir: dir });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("security.md");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps every role prompt within its responsibility and advisory (AC-2)", () => {
		const table = loadRoleTable();
		for (const { name } of EXPECTED_ROLES) {
			const entry = table.get(name);
			expect(entry, `${name} entry present`).toBeDefined();
			if (entry === undefined) {
				continue;
			}
			expect(
				entry.prompt,
				`${name} covers its accepted responsibility`,
			).toContain(ROLE_KEYWORDS[name]);
			expect(entry.prompt, `${name} stays verdict-free`).not.toMatch(FORBIDDEN);
		}
	});

	it("requires a named failure and an actual consumer on every review prompt", () => {
		const table = loadRoleTable();
		for (const { name, kind } of EXPECTED_ROLES) {
			if (kind === "check") {
				continue;
			}
			const entry = table.get(name);
			expect(entry, `${name} entry present`).toBeDefined();
			if (entry === undefined) {
				continue;
			}
			expect(entry.prompt, `${name} names a failure`).toContain(
				"concrete failure scenario",
			);
			expect(entry.prompt, `${name} names a consumer`).toContain(
				"actual consumer",
			);
		}
	});

	it("keeps contracts on public wire schemas and off app config", () => {
		const entry = loadRoleTable().get("contracts");
		expect(entry).toBeDefined();
		expect(entry?.prompt).toContain("OpenAPI, proto, GraphQL");
		expect(entry?.prompt).toContain("unpublished library");
		expect(entry?.prompt).toContain("Stay in this lens");
	});

	it("asks the tests lens to map production handoffs to a deleting-wiring test", () => {
		const entry = loadRoleTable().get("tests");
		expect(entry).toBeDefined();
		expect(entry?.prompt).toContain("production handoff");
		expect(entry?.prompt).toContain(
			"fail if that wiring were deleted or swapped for the default",
		);
	});

	it("keeps each specialist inside its lane", () => {
		const table = loadRoleTable();
		for (const { name, kind } of EXPECTED_ROLES) {
			if (kind !== "specialist") {
				continue;
			}
			const entry = table.get(name);
			expect(entry, `${name} entry present`).toBeDefined();
			expect(entry?.prompt, `${name} stays in lane`).toContain(
				"Stay in this lens",
			);
		}
	});
});
