import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertFixedResolved } from "../src/tool/closeout-from-run.js";
import { signVerifyRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

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
	sign = true,
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "verification.json"),
		`${JSON.stringify(body, null, 2)}\n`,
	);
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	if (sign) {
		signVerifyRecord(recordPath);
	}
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
				assertFixedResolved(
					repo,
					"verify-1",
					["F-1"],
					"review-1",
					TEST_RECORD_KEY,
				),
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
				assertFixedResolved(
					repo,
					"verify-1",
					["F-1"],
					"review-1",
					TEST_RECORD_KEY,
				),
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
				assertFixedResolved(
					repo,
					"verify-1",
					["F-1"],
					"review-1",
					TEST_RECORD_KEY,
				),
			).toThrow(/priorRunId/);
		});
	});

	it("refuses a verify run not signed by the owner's record key (T492)", () => {
		withRepo((repo) => {
			const body = {
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
			};
			writeVerify(repo, "verify-1", body, false);
			expect(() =>
				assertFixedResolved(
					repo,
					"verify-1",
					["F-1"],
					"review-1",
					TEST_RECORD_KEY,
				),
			).toThrow(
				/^comment refused: verify run "verify-1" is not signed by this owner's record key \(panel\.json is missing or not a regular file\); run a new review/,
			);
			writeVerify(repo, "verify-2", body);
			expect(() =>
				assertFixedResolved(
					repo,
					"verify-2",
					["F-1"],
					"review-1",
					Buffer.alloc(32, 8),
				),
			).toThrow(/not signed by this owner's record key/);
		});
	});
});
