// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	COMPLETE_MARKER,
	complete,
	digestBaseRef,
	PANEL_FILE,
	reserve,
	sanitizeBaseRef,
	writeExecution,
	writePanel,
} from "../src/run/record.js";
import type {
	PanelRecordInput,
	PlannedSeat,
	SeatOutcomeFacts,
} from "../src/run/types.js";

/** A throwaway "repo" directory; never the developer's real repo. */
function tempRepo(): string {
	return mkdtempSync(path.join(tmpdir(), "run-record-repo-"));
}

/** A fixed clock so run-ids are deterministic. */
function at(iso: string): () => Date {
	return () => new Date(iso);
}

function removeFixture(fixture: string): void {
	if (fixture !== "") {
		rmSync(fixture, { recursive: true, force: true });
	}
}

describe("sanitizeBaseRef", () => {
	it("lowercases and maps unsafe characters to -", () => {
		expect(sanitizeBaseRef("refs/heads/x")).toBe("refs-heads-x");
		expect(sanitizeBaseRef("origin/main")).toBe("origin-main");
		expect(sanitizeBaseRef("Main")).toBe("main");
		expect(sanitizeBaseRef("feature/branch")).toBe("feature-branch");
		expect(sanitizeBaseRef("v1.2")).toBe("v1.2");
		expect(sanitizeBaseRef("featüre")).toBe("feat-re");
		expect(sanitizeBaseRef("hello world")).toBe("hello-world");
	});

	it("collapses runs of - produced by mapping", () => {
		expect(sanitizeBaseRef("feature//double--sep")).toBe("feature-double-sep");
		expect(sanitizeBaseRef("///")).toBe("-");
		expect(sanitizeBaseRef("a///b")).toBe("a-b");
	});

	it("truncates to the practical length limit instead of refusing", () => {
		const long = "a".repeat(70);
		const result = sanitizeBaseRef(long);
		expect(result.length).toBe(40);
		expect(result).toBe("a".repeat(40));
	});

	it("preserves trailing - so refs like release- are accepted", () => {
		expect(sanitizeBaseRef("release-")).toBe("release-");
		expect(sanitizeBaseRef("-leading-dash")).toBe("-leading-dash");
	});
});

describe("digestBaseRef", () => {
	it("is deterministic", () => {
		expect(digestBaseRef("main")).toBe(digestBaseRef("main"));
		expect(digestBaseRef("origin/main")).toBe(digestBaseRef("origin/main"));
	});

	it("produces different digests for case-only variants", () => {
		expect(digestBaseRef("Main")).not.toBe(digestBaseRef("main"));
	});

	it("produces different digests for slash vs dash variants", () => {
		expect(digestBaseRef("origin/main")).not.toBe(digestBaseRef("origin-main"));
	});

	it("returns a fixed-length lowercase hex string", () => {
		const digest = digestBaseRef("main");
		expect(digest.length).toBe(16);
		expect(digest).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("reserve", () => {
	it("reserves a fresh record with a timestamp-readable-digest run id", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const expectedDigest = digestBaseRef("main");

			expect(record.runId).toBe(
				`2026-08-04T12-34-56-789Z-main-${expectedDigest}`,
			);
			expect(record.recordPath).toBe(
				path.join(repo, ".review-panel", "runs", record.runId),
			);
			expect(record.reportPath).toBe(path.join(record.recordPath, "report.md"));
			expect(record.findingsPath).toBe(
				path.join(record.recordPath, "findings.json"),
			);
			expect(record.panelPath).toBe(path.join(record.recordPath, PANEL_FILE));
			expect(PANEL_FILE).toBe("panel.json");
			expect(statSync(record.recordPath).isDirectory()).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("derives the id from the wall clock when no clock is injected", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main");

			expect(record.runId).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-main-[0-9a-f]{16}$/,
			);
			expect(statSync(record.recordPath).isDirectory()).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("orders run ids newest-last under plain lexicographic comparison (the T-18 seam)", () => {
		const repo = tempRepo();
		try {
			const september = reserve(repo, "main", {
				now: at("2026-09-01T00:00:00.000Z"),
			});
			const october = reserve(repo, "main", {
				now: at("2026-10-01T00:00:00.000Z"),
			});
			const lastMoment = reserve(repo, "main", {
				now: at("2026-12-31T23:59:59.999Z"),
			});
			const nextYear = reserve(repo, "main", {
				now: at("2027-01-01T00:00:00.000Z"),
			});

			expect(september.runId < october.runId).toBe(true);
			expect(october.runId < lastMoment.runId).toBe(true);
			expect(lastMoment.runId < nextYear.runId).toBe(true);

			const shuffled = [
				lastMoment.runId,
				september.runId,
				nextYear.runId,
				october.runId,
			];
			expect([...shuffled].sort()).toEqual([
				september.runId,
				october.runId,
				lastMoment.runId,
				nextYear.runId,
			]);
		} finally {
			removeFixture(repo);
		}
	});

	it("refuses a pre-existing run-id directory and leaves it untouched", () => {
		const repo = tempRepo();
		const clock = at("2026-08-04T12:34:56.789Z");
		try {
			const first = reserve(repo, "main", { now: clock });
			rmSync(first.recordPath, { recursive: true, force: true });

			// The reviewed repo pre-seeds the exact run-id directory.
			mkdirSync(first.recordPath, { recursive: true });
			const sentinel = path.join(first.recordPath, "sentinel.txt");
			writeFileSync(sentinel, "pre-existing\n");
			const seededAt = new Date("2020-01-01T00:00:00.000Z");
			utimesSync(sentinel, seededAt, seededAt);
			const mtimeBefore = statSync(sentinel).mtimeMs;

			expect(() => reserve(repo, "main", { now: clock })).toThrow(
				/already exists/,
			);

			expect(readFileSync(sentinel, "utf8")).toBe("pre-existing\n");
			expect(statSync(sentinel).mtimeMs).toBe(mtimeBefore);
			expect(readdirSync(first.recordPath)).toEqual(["sentinel.txt"]);
		} finally {
			removeFixture(repo);
		}
	});

	it("reserves concurrent role records independently while retaining role attribution", () => {
		const repo = tempRepo();
		const clock = at("2026-08-04T12:34:56.789Z");
		try {
			const security = reserve(repo, "origin/main", {
				now: clock,
				role: "security",
			});
			const tests = reserve(repo, "origin/main", { now: clock, role: "tests" });

			expect(security.runId).not.toBe(tests.runId);
			expect(security.runId).toContain("-security-");
			expect(tests.runId).toContain("-tests-");
			expect(statSync(security.recordPath).isDirectory()).toBe(true);
			expect(statSync(tests.recordPath).isDirectory()).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("produces distinct run-ids for origin/main vs origin-main at the same instant", () => {
		const repo = tempRepo();
		try {
			const clock = at("2026-08-04T12:34:56.789Z");
			const slash = reserve(repo, "origin/main", { now: clock });
			const dash = reserve(repo, "origin-main", { now: clock });

			// The readable parts collide (both "origin-main") but the digests differ.
			expect(slash.runId).not.toBe(dash.runId);
			expect(slash.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-origin-main-[0-9a-f]{16}$/,
			);
			expect(dash.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-origin-main-[0-9a-f]{16}$/,
			);
		} finally {
			removeFixture(repo);
		}
	});

	it("produces distinct run-ids for case-only ref variants at the same instant", () => {
		const repo = tempRepo();
		try {
			const clock = at("2026-08-04T12:34:56.789Z");
			const upper = reserve(repo, "Main", { now: clock });
			const lower = reserve(repo, "main", { now: clock });

			// The readable parts collide (both "main") but the digests differ.
			expect(upper.runId).not.toBe(lower.runId);
			expect(upper.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-main-[0-9a-f]{16}$/,
			);
			expect(lower.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-main-[0-9a-f]{16}$/,
			);
		} finally {
			removeFixture(repo);
		}
	});

	it("accepts long refs by truncating the readable part", () => {
		const repo = tempRepo();
		try {
			const longRef = `feat/${"a".repeat(65)}`;
			const record = reserve(repo, longRef, {
				now: at("2026-08-04T12:34:56.789Z"),
			});

			expect(record.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-feat-a{35}-[0-9a-f]{16}$/,
			);
			expect(statSync(record.recordPath).isDirectory()).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("produces distinct run-ids for unicode ref variants at the same instant", () => {
		const repo = tempRepo();
		try {
			const clock = at("2026-08-04T12:34:56.789Z");
			const plain = reserve(repo, "featüre", { now: clock });
			const ascii = reserve(repo, "feat-re", { now: clock });

			// The readable parts collide (both "feat-re") but the digests differ.
			expect(sanitizeBaseRef("featüre")).toBe(sanitizeBaseRef("feat-re"));
			expect(plain.runId).not.toBe(ascii.runId);
			expect(plain.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-feat-re-[0-9a-f]{16}$/,
			);
			expect(ascii.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-feat-re-[0-9a-f]{16}$/,
			);
		} finally {
			removeFixture(repo);
		}
	});

	it("produces distinct run-ids for refs that differ only after the truncation point", () => {
		const repo = tempRepo();
		try {
			const clock = at("2026-08-04T12:34:56.789Z");
			// Both refs share the first 40 sanitized characters but differ after.
			const prefix = "a".repeat(40);
			const refA = `feat/${prefix}bbb`;
			const refB = `feat/${prefix}ccc`;

			// The readable parts collide (both truncated to the same 40 chars).
			expect(sanitizeBaseRef(refA)).toBe(sanitizeBaseRef(refB));

			const a = reserve(repo, refA, { now: clock });
			const b = reserve(repo, refB, { now: clock });

			// The digests of the original (untruncated) refs differ.
			expect(a.runId).not.toBe(b.runId);
			expect(a.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-feat-a{35}-[0-9a-f]{16}$/,
			);
			expect(b.runId).toMatch(
				/^2026-08-04T12-34-56-789Z-feat-a{35}-[0-9a-f]{16}$/,
			);
		} finally {
			removeFixture(repo);
		}
	});

	it("accepts refs with trailing dashes like release-", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "release-", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const expectedDigest = digestBaseRef("release-");

			expect(record.runId).toBe(
				`2026-08-04T12-34-56-789Z-release--${expectedDigest}`,
			);
			expect(statSync(record.recordPath).isDirectory()).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("pins the year to 4 digits (fixed-width) for year 9999", () => {
		const repo = tempRepo();
		try {
			const y2026 = reserve(repo, "main", {
				now: at("2026-01-01T00:00:00.000Z"),
			});
			const y9999 = reserve(repo, "main", {
				now: at("9999-12-31T23:59:59.999Z"),
			});

			// Same total length proves the year field is fixed-width.
			expect(y9999.runId.length).toBe(y2026.runId.length);
			expect(y9999.runId).toMatch(/^9999-/);
			expect(y2026.runId < y9999.runId).toBe(true);
		} finally {
			removeFixture(repo);
		}
	});

	it("refuses year 10000 which would break lexicographic sortability", () => {
		const repo = tempRepo();
		try {
			expect(() =>
				reserve(repo, "main", {
					now: at("+010000-01-01T00:00:00.000Z"),
				}),
			).toThrow(/outside the supported range/);
		} finally {
			removeFixture(repo);
		}
	});
});

describe("writePanel", () => {
	it("writes panel.json with exactly runId, baseRef, scopingNote, seats in that key order (AC-25)", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const input: PanelRecordInput = {
				runId: record.runId,
				baseRef: "origin/main",
				scopingNote: "Scope: only src/.",
				seats: [
					{
						rosterId: "roster-a",
						lens: "correctness",
						provider: "openai-codex",
						model: "gpt-5.3-codex",
						lensPrompt: "SHOULD NOT BE SERIALIZED",
					},
				],
			};

			writePanel(record, input);

			// The exact serialized bytes: pretty-printed (2-space indent) with a
			// trailing newline, matching the findings.json idiom.
			expect(readFileSync(record.panelPath, "utf8")).toBe(
				`{\n  "runId": "${record.runId}",\n  "baseRef": "origin/main",\n  "scopingNote": "Scope: only src/.",\n  "seats": [\n    {\n      "rosterId": "roster-a",\n      "lens": "correctness",\n      "provider": "openai-codex",\n      "model": "gpt-5.3-codex"\n    }\n  ]\n}\n`,
			);

			const parsed = JSON.parse(readFileSync(record.panelPath, "utf8"));
			expect(Object.keys(parsed)).toEqual([
				"runId",
				"baseRef",
				"scopingNote",
				"seats",
			]);
			expect(parsed).toEqual({
				runId: record.runId,
				baseRef: "origin/main",
				scopingNote: "Scope: only src/.",
				seats: [
					{
						rosterId: "roster-a",
						lens: "correctness",
						provider: "openai-codex",
						model: "gpt-5.3-codex",
					},
				],
			});
			expect(readFileSync(record.panelPath, "utf8")).not.toContain(
				"SHOULD NOT BE SERIALIZED",
			);
		} finally {
			removeFixture(repo);
		}
	});

	it("omits the scopingNote key entirely when absent (AC-23)", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});

			writePanel(record, {
				runId: record.runId,
				baseRef: "origin/main",
				seats: [
					{
						rosterId: "roster-a",
						lens: "correctness",
						provider: "openai-codex",
						model: "gpt-5.3-codex",
						lensPrompt: "x",
					},
				],
			});

			const raw = readFileSync(record.panelPath, "utf8");
			const parsed = JSON.parse(raw);
			expect(Object.hasOwn(parsed, "scopingNote")).toBe(false);
			expect(raw).not.toContain("scopingNote");
			expect(Object.keys(parsed)).toEqual(["runId", "baseRef", "seats"]);
		} finally {
			removeFixture(repo);
		}
	});

	it("projects each seat to exactly rosterId, lens, provider, model, leaking no prompt or extension bytes (AC-26)", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const seats: PlannedSeat[] = [
				{
					rosterId: "roster-a",
					lens: "correctness",
					provider: "openai-codex",
					model: "gpt-5.3-codex",
					lensPrompt: "TOP-SECRET PROMPT",
					extraExtensionPaths: ["/abs/extension-a.ts", "/abs/extension-b.ts"],
				},
			];

			writePanel(record, {
				runId: record.runId,
				baseRef: "origin/main",
				seats,
			});

			const raw = readFileSync(record.panelPath, "utf8");
			expect(raw).not.toContain("TOP-SECRET PROMPT");
			expect(raw).not.toContain("lensPrompt");
			expect(raw).not.toContain("extraExtensionPaths");
			expect(raw).not.toContain("extension-a");
			expect(raw).not.toContain("extension-b");
			const parsed = JSON.parse(raw);
			expect(Object.keys(parsed.seats[0])).toEqual([
				"rosterId",
				"lens",
				"provider",
				"model",
			]);
		} finally {
			removeFixture(repo);
		}
	});

	it("serializes seats in the planned input order", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const seats: PlannedSeat[] = [
				{
					rosterId: "first",
					lens: "correctness",
					provider: "p1",
					model: "m1",
					lensPrompt: "x",
				},
				{
					rosterId: "second",
					lens: "security",
					provider: "p2",
					model: "m2",
					lensPrompt: "y",
				},
				{
					rosterId: "third",
					lens: "style",
					provider: "p3",
					model: "m3",
					lensPrompt: "z",
				},
			];

			writePanel(record, {
				runId: record.runId,
				baseRef: "origin/main",
				seats,
			});

			const parsed = JSON.parse(readFileSync(record.panelPath, "utf8"));
			expect(
				parsed.seats.map((row: { rosterId: string }) => row.rosterId),
			).toEqual(["first", "second", "third"]);
		} finally {
			removeFixture(repo);
		}
	});

	it("carries rosterId, lens, provider, and model byte-for-byte without trimming or normalizing", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const seats: PlannedSeat[] = [
				{
					rosterId: "  padded-id ",
					lens: "correctness",
					provider: "provider with spaces",
					model: "model/with/slashes",
					lensPrompt: "x",
				},
			];

			writePanel(record, {
				runId: record.runId,
				baseRef: "origin/main",
				seats,
			});

			const parsed = JSON.parse(readFileSync(record.panelPath, "utf8"));
			expect(parsed.seats[0]).toEqual({
				rosterId: "  padded-id ",
				lens: "correctness",
				provider: "provider with spaces",
				model: "model/with/slashes",
			});
		} finally {
			removeFixture(repo);
		}
	});
});

describe("execution record", () => {
	it("persists structured replay, lifecycle, lost coverage, and cancellation", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});
			const outcomes: SeatOutcomeFacts[] = [
				{
					seat: {
						rosterId: "terra",
						provider: "openai-codex",
						model: "gpt-5.6-terra",
						lens: "security",
						lensPrompt: "private role prompt",
					},
					replay: {
						provider: "openai-codex",
						model: "gpt-5.6-terra",
						lens: "security",
						lensPrompt: "private role prompt",
						baseRef: "base-oid",
						worktree: "/snapshot",
					},
					lifecycle: {
						startedAtMs: 1,
						settledAtMs: 2,
						durationMs: 1,
						attempts: 2,
						aborted: true,
						tokens: {
							input: 1,
							output: 2,
							cacheRead: 3,
							cacheWrite: 4,
							total: 10,
						},
						cost: 0.25,
					},
					outcome: { kind: "failed", class: "no-submit", reason: "silent" },
				},
			];
			writeExecution(record, { cancelled: true, outcomes });
			expect(JSON.parse(readFileSync(record.executionPath, "utf8"))).toEqual({
				cancelled: true,
				lostCoverage: ["openai-codex/gpt-5.6-terra/security"],
				outcomes,
			});
		} finally {
			removeFixture(repo);
		}
	});
});

describe("complete", () => {
	it("writes the COMPLETE marker at the record root", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});

			complete(record);

			expect(existsSync(path.join(record.recordPath, "COMPLETE"))).toBe(true);
			expect(COMPLETE_MARKER).toBe("COMPLETE");
		} finally {
			removeFixture(repo);
		}
	});

	it("leaves a reserved-but-incomplete record without a marker", () => {
		const repo = tempRepo();
		try {
			const record = reserve(repo, "main", {
				now: at("2026-08-04T12:34:56.789Z"),
			});

			expect(existsSync(path.join(record.recordPath, "COMPLETE"))).toBe(false);
		} finally {
			removeFixture(repo);
		}
	});

	it("refuses a symlinked .review-panel ancestor and creates nothing under it", () => {
		const repo = tempRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-record-outside-"));
		try {
			symlinkSync(outside, path.join(repo, ".review-panel"));

			expect(() =>
				reserve(repo, "main", { now: at("2026-08-04T12:34:56.789Z") }),
			).toThrow(/symlink/);

			// Nothing was created inside the redirected target.
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			removeFixture(repo);
			removeFixture(outside);
		}
	});

	it("refuses a symlinked .review-panel/runs ancestor", () => {
		const repo = tempRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-record-runs-out-"));
		try {
			mkdirSync(path.join(repo, ".review-panel"));
			symlinkSync(outside, path.join(repo, ".review-panel", "runs"));

			expect(() =>
				reserve(repo, "main", { now: at("2026-08-04T12:34:56.789Z") }),
			).toThrow(/symlink/);
			expect(readdirSync(outside)).toEqual([]);
		} finally {
			removeFixture(repo);
			removeFixture(outside);
		}
	});
});
