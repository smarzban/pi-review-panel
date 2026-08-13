// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPriorRecords } from "../src/run/prior-records.js";
import { COMPLETE_MARKER } from "../src/run/record.js";

/** Throwaway roots for synthetic prior-record trees; never a real repo. */
function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "run-prior-records-"));
}

function removeFixture(fixture: string): void {
	if (fixture !== "") {
		rmSync(fixture, { recursive: true, force: true });
	}
}

function makeRunRecord(repoDir: string, name: string, marked: boolean): string {
	const recordPath = path.join(repoDir, ".review-panel", "runs", name);
	mkdirSync(recordPath, { recursive: true });
	if (marked) {
		writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	}
	return recordPath;
}

describe("discoverPriorRecords", () => {
	it("returns no prior records when the .review-panel tree is absent", () => {
		const repoDir = tempRoot();
		try {
			expect(discoverPriorRecords(repoDir)).toEqual([]);
		} finally {
			removeFixture(repoDir);
		}
	});

	it("discovers completed run records newest-first and skips unmarked ones", () => {
		const repoDir = tempRoot();
		try {
			const older = makeRunRecord(
				repoDir,
				"2026-01-01T00-00-00-000Z-main-aaaa",
				true,
			);
			const newer = makeRunRecord(
				repoDir,
				"2026-01-02T00-00-00-000Z-main-bbbb",
				true,
			);
			makeRunRecord(repoDir, "2026-01-03T00-00-00-000Z-main-cccc", false);

			expect(discoverPriorRecords(repoDir)).toEqual([
				{ kind: "run", path: newer },
				{ kind: "run", path: older },
			]);
		} finally {
			removeFixture(repoDir);
		}
	});

	it("never discovers symlinked run entries (no follow)", () => {
		const repoDir = tempRoot();
		try {
			const externalRun = path.join(repoDir, "external-run");
			mkdirSync(externalRun);
			writeFileSync(path.join(externalRun, COMPLETE_MARKER), "");

			mkdirSync(path.join(repoDir, ".review-panel", "runs"), {
				recursive: true,
			});
			symlinkSync(
				externalRun,
				path.join(repoDir, ".review-panel", "runs", "linked-run"),
			);

			expect(discoverPriorRecords(repoDir)).toEqual([]);
		} finally {
			removeFixture(repoDir);
		}
	});

	it("does not treat a symlinked completion marker as completion (no follow)", () => {
		const repoDir = tempRoot();
		try {
			const markerTarget = path.join(repoDir, "marker-target");
			writeFileSync(markerTarget, "");

			const run = path.join(
				repoDir,
				".review-panel",
				"runs",
				"2026-01-01T00-00-00-000Z-main-aaaa",
			);
			mkdirSync(run, { recursive: true });
			symlinkSync(markerTarget, path.join(run, COMPLETE_MARKER));

			expect(discoverPriorRecords(repoDir)).toEqual([]);
		} finally {
			removeFixture(repoDir);
		}
	});

	it("never discovers records behind a symlinked .review-panel ancestor (no follow)", () => {
		const repoDir = tempRoot();
		try {
			const external = path.join(repoDir, "external-state");
			mkdirSync(
				path.join(external, "runs", "2026-01-01T00-00-00-000Z-x-aaaa"),
				{
					recursive: true,
				},
			);
			writeFileSync(
				path.join(
					external,
					"runs",
					"2026-01-01T00-00-00-000Z-x-aaaa",
					COMPLETE_MARKER,
				),
				"",
			);
			symlinkSync(external, path.join(repoDir, ".review-panel"));

			expect(discoverPriorRecords(repoDir)).toEqual([]);
		} finally {
			removeFixture(repoDir);
		}
	});

	it("never discovers records behind a symlinked runs ancestor (no follow)", () => {
		const repoDir = tempRoot();
		try {
			const externalRuns = path.join(repoDir, "external-runs");
			mkdirSync(path.join(externalRuns, "2026-01-01T00-00-00-000Z-x-aaaa"), {
				recursive: true,
			});
			writeFileSync(
				path.join(
					externalRuns,
					"2026-01-01T00-00-00-000Z-x-aaaa",
					COMPLETE_MARKER,
				),
				"",
			);

			mkdirSync(path.join(repoDir, ".review-panel"), { recursive: true });
			symlinkSync(externalRuns, path.join(repoDir, ".review-panel", "runs"));

			expect(discoverPriorRecords(repoDir)).toEqual([]);
		} finally {
			removeFixture(repoDir);
		}
	});
});
