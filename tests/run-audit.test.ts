// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runAudit } from "../src/run/run-audit.js";
import type { PlannedSeat } from "../src/run/types.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepository(): string {
	const repository = mkdtempSync(path.join(tmpdir(), "run-audit-"));
	git(repository, ["init", "-b", "main", "--quiet"]);
	git(repository, ["config", "user.email", "audit@example.test"]);
	git(repository, ["config", "user.name", "Audit Test"]);
	writeFileSync(path.join(repository, "committed.txt"), "committed\n");
	git(repository, ["add", "."]);
	git(repository, ["commit", "-m", "base", "--quiet"]);
	return repository;
}

const seats: PlannedSeat[] = ["code-health", "docs"].map((lens, index) => ({
	rosterId: `seat-${index}`,
	provider: "openai-codex",
	model: `gpt-5.6-${index}`,
	lens,
	lensPrompt: `Audit ${lens}.`,
}));

describe("runAudit", () => {
	it("pins one HEAD snapshot, runs findings-profile seats, and records an advisory backlog", async () => {
		const repository = makeRepository();
		const sdk = createSdkSeatFake();
		const revision = git(repository, ["rev-parse", "HEAD"]).trim();
		try {
			const result = await runAudit(
				{
					repoDir: repository,
					revision,
					seats,
					scopingNote: "Focus on source.",
				},
				{ sessionFactory: sdk.factory },
			);

			expect(result.outcomes).toHaveLength(2);
			expect(sdk.runs.map((run) => run.input.spec.profile?.kind)).toEqual([
				"repo-audit",
				"repo-audit",
			]);
			expect(sdk.runs[0]?.input.tools.map((tool) => tool.name)).toContain(
				"submit_findings",
			);
			expect(sdk.runs[0]?.input.tools.map((tool) => tool.name)).not.toContain(
				"submit_audit",
			);
			expect(sdk.runs[0]?.input.tools.map((tool) => tool.name)).not.toContain(
				"git_diff",
			);
			expect(sdk.runs[0]?.input.spec.profile?.tools).toEqual([
				"read",
				"grep",
				"find",
				"ls",
				"submit_findings",
			]);
			expect(sdk.runs[0]?.prompts[0]).not.toContain("Base ref:");
			expect(sdk.runs[0]?.prompts[0]).toContain(
				"Explore with read, grep, find, and ls.",
			);
			expect(sdk.runs[0]?.prompts[0]).not.toContain("Prefer git_diff");
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).toContain("# Repository audit");
			expect(report).toContain(`Snapshot OID: \`${revision}\``);
			expect(report).toContain("Not a merge decision.");
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});
});
