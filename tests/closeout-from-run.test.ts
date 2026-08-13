// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertFixedResolved } from "../src/tool/closeout-from-run.js";

function withRepo(test: (repo: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "closeout-from-run-"));
	try {
		test(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeVerify(
	repo: string,
	runId: string,
	body: Record<string, unknown>,
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "verification.json"),
		`${JSON.stringify(body, null, 2)}\n`,
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
}

describe("assertFixedResolved", () => {
	it("accepts a verify run whose priorRunId matches the closed review", () => {
		withRepo((repo) => {
			writeVerify(repo, "verify-1", {
				priorRunId: "review-1",
				keptFindingIds: ["F-1"],
				outcomes: [
					{
						outcome: {
							kind: "voted",
							result: {
								items: [{ id: "F-1", disposition: "resolved" }],
							},
						},
					},
				],
			});
			expect(() =>
				assertFixedResolved(repo, "verify-1", ["F-1"], "review-1"),
			).not.toThrow();
		});
	});

	it("refuses a verify run bound to a different review", () => {
		withRepo((repo) => {
			writeVerify(repo, "verify-1", {
				priorRunId: "review-other",
				keptFindingIds: ["F-1"],
				outcomes: [
					{
						outcome: {
							kind: "voted",
							result: {
								items: [{ id: "F-1", disposition: "resolved" }],
							},
						},
					},
				],
			});
			expect(() =>
				assertFixedResolved(repo, "verify-1", ["F-1"], "review-1"),
			).toThrow(/priorRunId/);
		});
	});

	it("refuses a verify run that omitted priorRunId", () => {
		withRepo((repo) => {
			writeVerify(repo, "verify-1", {
				outcomes: [
					{
						outcome: {
							kind: "voted",
							result: {
								items: [{ id: "F-1", disposition: "resolved" }],
							},
						},
					},
				],
			});
			expect(() =>
				assertFixedResolved(repo, "verify-1", ["F-1"], "review-1"),
			).toThrow(/priorRunId/);
		});
	});
});
