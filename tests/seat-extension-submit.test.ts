import { describe, expect, it } from "vitest";

import { createSubmitFindingsTool } from "../src/seat/seat-extension.js";

describe("findings channel", () => {
	it("accepts one valid structured submission in memory", async () => {
		const { tool, channel } = createSubmitFindingsTool({});
		await tool.execute(
			"id",
			{
				findings: [
					{ file: "a.ts", line: 1, severity: "low", title: "T", evidence: "E" },
				],
			},
			undefined,
			undefined,
			{},
		);
		expect(channel.read()).toHaveLength(1);
		await expect(
			tool.execute("id", { findings: [] }, undefined, undefined, {}),
		).rejects.toThrow("already submitted");
	});
});

describe("findings are short enough to read", () => {
	const row = (title: string, evidence = "E") => ({
		file: "a.ts",
		line: 1,
		severity: "low",
		title,
		evidence,
	});

	it("refuses a title over 120 characters or evidence over 800, naming the limit, so the seat rewrites", async () => {
		const { tool, channel } = createSubmitFindingsTool({});
		await expect(
			tool.execute(
				"id",
				{ findings: [row("t".repeat(121))] },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/title.*120 characters/u);
		await expect(
			tool.execute(
				"id",
				{ findings: [row("T", "e".repeat(801))] },
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/evidence.*800 characters/u);
		// Nothing was recorded; the seat may submit again.
		expect(channel.read()).toBeUndefined();
		await tool.execute(
			"id",
			{ findings: [row("t".repeat(120), "e".repeat(800))] },
			undefined,
			undefined,
			{},
		);
		expect(channel.read()).toHaveLength(1);
	});

	it("tells the seat the limits in the tool description", () => {
		const { tool } = createSubmitFindingsTool({});
		expect(tool.description).toMatch(/120 characters/u);
		expect(tool.description).toMatch(/800 characters/u);
	});
});
