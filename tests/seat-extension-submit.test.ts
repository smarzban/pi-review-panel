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
