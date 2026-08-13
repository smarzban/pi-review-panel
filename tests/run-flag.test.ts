// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// @ts-expect-error The initial scaffold has no Node type declarations.
import { tmpdir } from "node:os";
// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CO_LOCATION_DRIFT_LINES,
	DISCARD_LEDGER_FILE,
	flagPersistence,
} from "../src/run/flag.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import type { StampedFinding } from "../src/run/types.js";

/** A throwaway root for synthetic prior records; never a real repo. */
function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "run-flag-"));
}

function removeFixture(fixture: string): void {
	if (fixture !== "") {
		rmSync(fixture, { recursive: true, force: true });
	}
}

/** A synthetic prior record directory, marked complete when asked (AC-31). */
function makeRecord(root: string, name: string, marked: boolean): string {
	const recordPath = path.join(root, name);
	mkdirSync(recordPath);
	if (marked) {
		writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	}
	return recordPath;
}

/** Writes the ledger at the record root, per the convention T-16 defines. */
function writeLedger(recordPath: string, content: string): void {
	writeFileSync(path.join(recordPath, DISCARD_LEDGER_FILE), content);
}

function stampedFinding(
	id: string,
	file: string,
	line: number,
): StampedFinding {
	return {
		id,
		seat: { provider: "stub-provider", model: "stub-model", lens: "stub-lens" },
		finding: {
			file,
			line,
			severity: "medium",
			title: "stub finding",
			evidence: "stub evidence",
		},
	};
}

describe("flagPersistence", () => {
	it("pins the drift window constant at 20 lines (ADR-0002)", () => {
		expect(CO_LOCATION_DRIFT_LINES).toBe(20);
	});

	it("flags a current finding exactly 20 lines below the prior discard (ADR-0002 inclusive edge)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 120)],
				[prior],
			);

			expect(result.flags).toEqual([
				{ findingId: "F-1", reason: "prior reason" },
			]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("flags a current finding exactly 20 lines above the prior discard (the other inclusive edge)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 80)],
				[prior],
			);

			expect(result.flags).toEqual([
				{ findingId: "F-1", reason: "prior reason" },
			]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("does not flag a finding 21 lines away in either direction (just outside the window)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[
					stampedFinding("F-1", "src/a.ts", 121),
					stampedFinding("F-2", "src/a.ts", 79),
				],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("does not flag across files even on the same line (ADR-0002 file identity)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/b.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("carries the newest matching discard's reason when two priors co-locate (newest-wins)", () => {
		const root = tempRoot();
		try {
			const older = makeRecord(root, "older", true);
			writeLedger(
				older,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "older reason" },
				]),
			);
			const newer = makeRecord(root, "newer", true);
			writeLedger(
				newer,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 105, reason: "newer reason" },
				]),
			);

			// Input contract: prior record paths arrive newest-first.
			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 110)],
				[newer, older],
			);

			expect(result.flags).toEqual([
				{ findingId: "F-1", reason: "newer reason" },
			]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("falls through to an older ledger when the newest does not co-locate", () => {
		const root = tempRoot();
		try {
			const older = makeRecord(root, "older", true);
			writeLedger(
				older,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "older reason" },
				]),
			);
			const newer = makeRecord(root, "newer", true);
			writeLedger(
				newer,
				JSON.stringify([
					{
						id: "F-9",
						file: "src/other.ts",
						line: 100,
						reason: "newer reason",
					},
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 110)],
				[newer, older],
			);

			expect(result.flags).toEqual([
				{ findingId: "F-1", reason: "older reason" },
			]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("ignores an unmarked record even when its ledger would match (AC-32)", () => {
		const root = tempRoot();
		try {
			const unmarked = makeRecord(root, "unmarked", false);
			writeLedger(
				unmarked,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[unmarked],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("does not consume a record reached through a symlinked record path (no follow)", () => {
		const root = tempRoot();
		try {
			// A fully valid completed record, but reached only through a link:
			// consumption must not follow the symlink out of the record tree.
			const real = makeRecord(root, "real", true);
			writeLedger(
				real,
				JSON.stringify([
					{
						id: "F-9",
						file: "src/a.ts",
						line: 100,
						reason: "external reason",
					},
				]),
			);
			const link = path.join(root, "link");
			symlinkSync(real, link);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[link],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("does not treat a symlinked COMPLETE marker as completion (no follow)", () => {
		const root = tempRoot();
		try {
			const markerTarget = path.join(root, "marker-target");
			writeFileSync(markerTarget, "");
			const prior = path.join(root, "prior");
			mkdirSync(prior);
			symlinkSync(markerTarget, path.join(prior, COMPLETE_MARKER));
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "prior reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("refuses a symlinked ledger: never read, never flags, surfaced as unreadable (AC-33)", () => {
		const root = tempRoot();
		try {
			// An external ledger whose rows WOULD co-locate and flag; the
			// completed record links to it instead of carrying its own.
			const externalLedger = path.join(root, "external-ledger.json");
			writeFileSync(
				externalLedger,
				JSON.stringify([
					{
						id: "F-9",
						file: "src/a.ts",
						line: 100,
						reason: "external reason",
					},
				]),
			);
			const prior = makeRecord(root, "prior", true);
			symlinkSync(externalLedger, path.join(prior, DISCARD_LEDGER_FILE));

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([
				{
					recordPath: prior,
					reason: "discard-ledger.json is a symlink and was not followed",
				},
			]);
		} finally {
			removeFixture(root);
		}
	});

	it("surfaces a notice for a corrupt ledger in a completed record (AC-33)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(prior, "{{{ this is not json");

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([
				{
					recordPath: prior,
					reason: "discard-ledger.json is not valid JSON",
				},
			]);
		} finally {
			removeFixture(root);
		}
	});

	it("surfaces a notice for a ledger that is not a JSON array of rows (AC-33)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify({
					id: "F-9",
					file: "src/a.ts",
					line: 100,
					reason: "prior reason",
				}),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([
				{
					recordPath: prior,
					reason: "discard-ledger.json is not a JSON array of discard rows",
				},
			]);
		} finally {
			removeFixture(root);
		}
	});

	it("surfaces a notice for a ledger of id-less rows, never silent consumption (AC-33)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(
				prior,
				JSON.stringify([
					{ id: "F-8", file: "src/a.ts", line: 100, reason: "valid row" },
					{ file: "src/a.ts", line: 101, reason: "row missing its id" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([
				{
					recordPath: prior,
					reason:
						"discard-ledger.json row 1 is not a valid discard row: id, file, line, and reason are required",
				},
			]);
		} finally {
			removeFixture(root);
		}
	});

	it("reads a missing ledger as no discards, without a notice (absence is a non-event)", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("reads an empty ledger as no discards, without a notice", () => {
		const root = tempRoot();
		try {
			const prior = makeRecord(root, "prior", true);
			writeLedger(prior, "[]");

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[prior],
			);

			expect(result.flags).toEqual([]);
			expect(result.notices).toEqual([]);
		} finally {
			removeFixture(root);
		}
	});

	it("produces no flags and no notices with no prior paths (AC-17)", () => {
		const result = flagPersistence(
			[stampedFinding("F-1", "src/a.ts", 100)],
			[],
		);

		expect(result).toEqual({ flags: [], notices: [] });
	});

	it("keeps flagging from healthy ledgers when another ledger is unreadable", () => {
		const root = tempRoot();
		try {
			const corrupt = makeRecord(root, "corrupt", true);
			writeLedger(corrupt, "{{{ this is not json");
			const good = makeRecord(root, "good", true);
			writeLedger(
				good,
				JSON.stringify([
					{ id: "F-9", file: "src/a.ts", line: 100, reason: "good reason" },
				]),
			);

			const result = flagPersistence(
				[stampedFinding("F-1", "src/a.ts", 100)],
				[corrupt, good],
			);

			expect(result.flags).toEqual([
				{ findingId: "F-1", reason: "good reason" },
			]);
			expect(result.notices).toEqual([
				{
					recordPath: corrupt,
					reason: "discard-ledger.json is not valid JSON",
				},
			]);
		} finally {
			removeFixture(root);
		}
	});
});
