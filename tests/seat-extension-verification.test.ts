import { describe, expect, it } from "vitest";

import { createSubmitVerificationTool } from "../src/seat/verification-channel.js";

describe("verification channel", () => {
	it("stamps a validated closure-owned verification result", async () => {
		const { tool, channel } = createSubmitVerificationTool({
			expectedIds: ["run/finding"],
			cycle: 2,
		});
		await tool.execute(
			"id",
			{
				items: [
					{
						id: "run/finding",
						disposition: "resolved",
						evidence: {
							file: "src/a.ts",
							explanation: "The repair is present.",
						},
					},
				],
				regressions: [],
			},
			undefined,
			undefined,
			{},
		);
		expect(channel.read()?.items).toHaveLength(1);
	});
});
