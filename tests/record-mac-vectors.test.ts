import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadPriorRun } from "../src/run/prior-run.js";
import { recordMac } from "../src/run/record-key.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * Known answers for `record.mac` (review R-3). Each value was computed outside
 * this package, with Python's `hmac` over the documented input and checked
 * with `openssl dgst -sha256 -mac HMAC`, so a change to what the MAC binds
 * (tag, run id, kind, plan MAC, file names, file hashes, order) fails here.
 */
const RUN_ID = "2026-01-01T00-00-00-000Z-main-0123456789abcdef";
const PLAN_MAC = "c".repeat(64);
const FILES: Array<[string, string]> = [
	["plan.json", "{}\n"],
	["panel.json", "panel"],
	["meta.json", "meta"],
	["findings.json", "[]"],
	["execution.json", "exec"],
];

describe("record.mac known-answer vectors (review R-3)", () => {
	it("matches the independently computed MAC", () => {
		expect(recordMac(TEST_RECORD_KEY, RUN_ID, "review", PLAN_MAC, FILES)).toBe(
			"9a7e928283f8597c6f57a89b9f0e3ef463ef0d1853bf157b56e69922c878f942",
		);
	});

	it("binds the record kind", () => {
		expect(recordMac(TEST_RECORD_KEY, RUN_ID, "verify", PLAN_MAC, FILES)).toBe(
			"5993a1add8ee3902b60f1d577f42dc91e8004fa8b49abaf82b8575d36ec68e77",
		);
	});

	it("binds the plan MAC", () => {
		expect(
			recordMac(TEST_RECORD_KEY, RUN_ID, "review", "d".repeat(64), FILES),
		).toBe("e0e3f85a2e88ead0446cf9b5e8ab8ade4ffe4644c9e8a29c83be58bb1621c76f");
	});

	it("binds the run id", () => {
		expect(
			recordMac(TEST_RECORD_KEY, `${RUN_ID}x`, "review", PLAN_MAC, FILES),
		).toBe("244702083ccb3e991517ba016965d2132697f956d4c2d462ae7210c0f42e6841");
	});
});

function withRepo(test: (repo: string) => void): void {
	const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "record-mac-")));
	try {
		execFileSync("git", ["init", "-b", "main", "--quiet"], { cwd: repo });
		test(repo);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/** A complete review record, then signed in full with the owner's key. */
function signedRecord(
	repo: string,
	runId: string,
	options: { planKind?: string; metaRunId?: string } = {},
): void {
	const recordPath = path.join(repo, ".review-panel", "runs", runId);
	mkdirSync(recordPath, { recursive: true });
	const meta = {
		runId: options.metaRunId ?? runId,
		baseRef: "main",
		baseOid: "a".repeat(40),
		headOid: "b".repeat(40),
	};
	writeFileSync(
		path.join(recordPath, "plan.json"),
		JSON.stringify({
			version: 1,
			kind: options.planKind ?? "review",
			runId,
			baseRef: "main",
			baseOid: meta.baseOid,
			headOid: meta.headOid,
			seats: [],
		}),
	);
	writeFileSync(path.join(recordPath, "meta.json"), JSON.stringify(meta));
	writeFileSync(path.join(recordPath, "findings.json"), "[]");
	writeFileSync(path.join(recordPath, "COMPLETE"), "");
	signReviewRecord(recordPath);
}

describe("checks inside a fully signed record (review R-3)", () => {
	it("refuses a signed record whose plan is not a review plan", () => {
		withRepo((repo) => {
			signedRecord(repo, "audit-1", { planKind: "audit" });
			expect(() => loadPriorRun(repo, "audit-1", TEST_RECORD_KEY)).toThrow(
				/^Verify refused: prior run "audit-1" is not signed by this owner's record key \(plan\.json is not a review plan\)/,
			);
		});
	});

	it("refuses a signed record whose meta.json names another run", () => {
		withRepo((repo) => {
			signedRecord(repo, "run-1", { metaRunId: "run-2" });
			expect(() => loadPriorRun(repo, "run-1", TEST_RECORD_KEY)).toThrow(
				/^Verify refused: prior run "run-1" meta\.json is invalid/,
			);
		});
	});
});
