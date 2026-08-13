import { describe, expect, it } from "vitest";

import { collectFindings } from "../src/run/collect.js";
import type { PlannedSeat, SeatOutcomeFacts } from "../src/run/types.js";
import type { Finding } from "../src/seat/schema.js";

const firstSeat: PlannedSeat = {
	rosterId: "roster-correctness",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "correctness",
	lensPrompt: "You review through a correctness lens.",
};
const secondSeat: PlannedSeat = {
	...firstSeat,
	rosterId: "roster-security",
	lens: "security",
};
const thirdSeat: PlannedSeat = {
	...firstSeat,
	rosterId: "roster-tests",
	lens: "tests",
};
const findings: Finding[] = [
	{
		file: "src/run/collect.ts",
		line: 12,
		severity: "high",
		title: "Off-by-one in loop bound",
		evidence: "for (let i = 0; i <= rows.length; i++)",
	},
	{
		file: "src/run/render.ts",
		line: 40,
		endLine: 44,
		severity: "low",
		title: "Unreachable branch",
		evidence: "the else arm cannot fire",
	},
];

function facts(
	seat: PlannedSeat,
	outcome: SeatOutcomeFacts["outcome"],
): SeatOutcomeFacts {
	return {
		seat,
		replay: {
			provider: seat.provider,
			model: seat.model,
			lens: seat.lens,
			lensPrompt: seat.lensPrompt,
			baseRef: "base",
			worktree: "/snapshot",
		},
		lifecycle: {
			startedAtMs: 1,
			settledAtMs: 2,
			durationMs: 1,
			attempts: 1,
			aborted: false,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		outcome,
	};
}

function threeSeatOutcomes(): SeatOutcomeFacts[] {
	return [
		facts(firstSeat, { kind: "voted", findings }),
		facts(secondSeat, { kind: "voted", findings: [] }),
		facts(thirdSeat, {
			kind: "failed",
			class: "no-submit",
			reason:
				"seat SDK session ended without submitting findings after no-submit retry",
		}),
	];
}

describe("collectFindings", () => {
	it("unions only voted findings and attributes each stamp", () => {
		const stamped = collectFindings(threeSeatOutcomes());
		expect(stamped).toHaveLength(2);
		expect(stamped.map((entry) => entry.finding)).toEqual(findings);
		expect(stamped.map((entry) => entry.seat.lens)).toEqual([
			"correctness",
			"correctness",
		]);
	});

	it("stamps unique ids in seat-list then finding order", () => {
		const outcomes = [
			facts(secondSeat, { kind: "voted", findings: [findings[0]] }),
			facts(thirdSeat, {
				kind: "failed",
				class: "provider-error",
				reason: "SDK unavailable",
			}),
			facts(firstSeat, { kind: "voted", findings }),
		];
		const stamped = collectFindings(outcomes);
		expect(stamped.map((entry) => entry.id)).toEqual(["F-1", "F-2", "F-3"]);
		expect(stamped.map((entry) => entry.seat.lens)).toEqual([
			"security",
			"correctness",
			"correctness",
		]);
	});

	it("does not mutate structured outcomes, including an empty vote", () => {
		const outcomes = threeSeatOutcomes();
		const before = structuredClone(outcomes);
		expect(
			collectFindings(outcomes).some((entry) => entry.seat.lens === "security"),
		).toBe(false);
		expect(outcomes).toEqual(before);
	});

	it("replaces a model-provided id with the run-local stamp", () => {
		const smuggled = { ...findings[0], id: "model-chosen-id" } as Finding;
		const stamped = collectFindings([
			facts(firstSeat, { kind: "voted", findings: [smuggled] }),
		]);
		expect(stamped[0]?.id).toBe("F-1");
		expect(stamped[0]?.finding).toEqual(findings[0]);
	});
});
