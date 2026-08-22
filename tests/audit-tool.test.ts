// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { execFileSync } from "node:child_process";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config/schema.js";
import type { RunAuditInput, RunAuditResult } from "../src/run/run-audit.js";
import { createReviewPanelTool } from "../src/tool/review-panel.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repository(): string {
	const root = mkdtempSync(path.join(tmpdir(), "audit-tool-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "audit@example.test"]);
	git(repo, ["config", "user.name", "Audit Test"]);
	writeFileSync(path.join(repo, "committed.txt"), "committed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	return repo;
}

const config: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "claude", provider: "anthropic", model: "claude-opus-5" },
		{ id: "glm", provider: "ollama", model: "glm-5.2" },
	],
	defaults: { seats: ["terra", "claude", "glm"] },
};

describe("review_panel audit", () => {
	it("pins HEAD and presents submitted findings as an advisory backlog", async () => {
		const repo = repository();
		let seen: RunAuditInput | undefined;
		const tool = createReviewPanelTool({
			env: {},
			home: "/tmp/audit-tool-home",
			diagnose: async () => ({ ready: true, rows: [] }),
			loadConfig: () => config,
			runAudit: async (input) => {
				seen = input;
				return {
					recordPath: path.join(repo, ".review-panel", "runs", "audit-1"),
					outcomes: input.seats.map((seat, index) => ({
						seat,
						outcome: {
							kind: "voted" as const,
							findings:
								index === 0
									? [
											{
												file: "src/tool.ts",
												line: 3,
												severity: "medium" as const,
												title: "[area: tool] [effort: quick] missing guard",
												evidence: "A caller reaches the unguarded operation.",
											},
										]
									: [],
						},
					})) as RunAuditResult["outcomes"],
				} as RunAuditResult;
			},
		});
		try {
			const response = await tool.execute(
				"tool-call",
				{ action: "audit", repository: repo, passes: ["security"] },
				undefined,
				undefined,
				{},
			);
			const head = git(repo, ["rev-parse", "HEAD"]).trim();
			expect(seen?.repoDir).toBe(realpathSync(repo));
			expect(seen?.revision).toBe(head);
			expect(seen?.seats.map((seat) => [seat.lens, seat.rosterId])).toEqual([
				["security", "terra"],
				["security", "claude"],
			]);
			expect(response.content[0]?.text).toContain("# Repository audit");
			expect(response.content[0]?.text).toContain("2/2 voted · 1 finding");
			expect(response.content[0]?.text).toContain("Areas: src");
			expect(response.content[0]?.text).toContain("Not a merge decision.");
			expect(response.content[0]?.text).not.toMatch(
				/verdict|healthy|pass\/fail/i,
			);
		} finally {
			rmSync(path.dirname(repo), { recursive: true, force: true });
		}
	});
});
