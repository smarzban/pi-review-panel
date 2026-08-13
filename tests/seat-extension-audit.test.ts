import { describe, expect, it } from "vitest";

import { createSubmitAuditTool } from "../src/seat/audit-channel.js";

describe("audit channel", () => {
	it("keeps the expected ids in its submission closure", async () => {
		const { tool, channel } = createSubmitAuditTool({
			expectedIds: ["run/finding"],
		});
		await tool.execute(
			"id",
			{
				rows: [
					{
						id: "run/finding",
						holds: true,
						rationale: "The dismiss was correct.",
					},
				],
			},
			undefined,
			undefined,
			{},
		);
		expect(channel.read()).toEqual([
			{ id: "run/finding", holds: true, rationale: "The dismiss was correct." },
		]);
	});
});
