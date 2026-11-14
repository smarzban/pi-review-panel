import { describe, expect, it } from "vitest";

import type { SubmissionChannel } from "../src/seat/channel-file.js";
import { SEAT_PROFILES } from "../src/seat/channel-profile.js";
import { classifyOutcome } from "../src/seat/classify.js";
import { createSubmitGroupsTool } from "../src/seat/grouping-channel.js";
import { validateGroups } from "../src/seat/grouping-schema.js";
import { createSeatTools } from "../src/seat/seat-extension.js";

const IDS = ["F-1", "F-2", "F-3"];

describe("validateGroups", () => {
	it("accepts a partition of the expected ids, groups of one included", () => {
		expect(
			validateGroups(
				[{ findingIds: ["F-1", "F-3"] }, { findingIds: ["F-2"] }],
				IDS,
			),
		).toEqual({ ok: true, groups: [["F-1", "F-3"], ["F-2"]] });
	});

	it("refuses an unknown, a missing and a repeated id, naming each", () => {
		const unknown = validateGroups(
			[{ findingIds: ["F-1", "F-9"] }, { findingIds: ["F-2", "F-3"] }],
			IDS,
		);
		expect(unknown.ok).toBe(false);
		expect(JSON.stringify(unknown)).toContain("F-9 is not a submitted finding");

		const missing = validateGroups([{ findingIds: ["F-1", "F-2"] }], IDS);
		expect(missing.ok).toBe(false);
		expect(JSON.stringify(missing)).toContain("F-3 is in no group");

		const repeated = validateGroups(
			[{ findingIds: ["F-1", "F-2"] }, { findingIds: ["F-2", "F-3"] }],
			IDS,
		);
		expect(repeated.ok).toBe(false);
		expect(JSON.stringify(repeated)).toContain("F-2 is in more than one group");
	});

	it("refuses a malformed envelope: not an array, an empty group, an unknown field", () => {
		expect(validateGroups("F-1", IDS).ok).toBe(false);
		expect(validateGroups([{ findingIds: [] }], IDS).ok).toBe(false);
		expect(
			validateGroups(
				[{ findingIds: ["F-1", "F-2", "F-3"], severity: "high" }],
				IDS,
			).ok,
		).toBe(false);
		expect(validateGroups([["F-1", "F-2", "F-3"]], IDS).ok).toBe(false);
	});
});

describe("submit_groups", () => {
	it("refuses an invalid submission by throwing, so the seat can submit again", async () => {
		const { tool, channel } = createSubmitGroupsTool({ expectedIds: IDS });
		await expect(
			tool.execute(
				"id",
				{ groups: [{ findingIds: ["F-1"] }] },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/F-2 is in no group/);
		expect(channel.hasSubmitted()).toBe(false);
		const ok = await tool.execute(
			"id",
			{ groups: [{ findingIds: ["F-1", "F-2"] }, { findingIds: ["F-3"] }] },
			undefined,
			undefined,
			{},
		);
		expect(ok.content[0]?.text).toBe("Submitted 2 groups.");
		expect(channel.read()).toEqual([["F-1", "F-2"], ["F-3"]]);
	});

	it("is the only submit tool of a grouping seat, beside the read-only diff", () => {
		const toolset = createSeatTools({
			worktree: process.cwd(),
			profile: SEAT_PROFILES.grouping,
			expectedIds: IDS,
		});
		expect(toolset.tools.map((tool) => tool.name)).toEqual([
			"git_diff",
			"submit_groups",
		]);
		expect(SEAT_PROFILES.grouping.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"git_diff",
			"submit_groups",
		]);
	});

	it("classifies a submitted grouping, and a missing one as no-submit", () => {
		const base = {
			identity: { provider: "p", model: "m", lens: "grouping" },
			replay: {
				provider: "p",
				model: "m",
				lens: "grouping",
				lensPrompt: "",
				worktree: "",
			},
			lifecycle: {
				startedAtMs: 0,
				settledAtMs: 1,
				durationMs: 1,
				attempts: 1 as const,
				aborted: false,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			},
			profile: SEAT_PROFILES.grouping,
			nudgeFired: false,
		};
		const { channel } = createSubmitGroupsTool({ expectedIds: IDS });
		expect(
			classifyOutcome({
				...base,
				channel: channel as SubmissionChannel<unknown>,
			}).outcome,
		).toEqual({
			kind: "failure",
			class: "no-submit",
			reason: "seat SDK session ended without submitting groups",
		});
		channel.submit([["F-1", "F-2", "F-3"]]);
		expect(
			classifyOutcome({
				...base,
				channel: channel as SubmissionChannel<unknown>,
			}).outcome,
		).toEqual({
			kind: "grouping",
			groups: [["F-1", "F-2", "F-3"]],
		});
	});
});
