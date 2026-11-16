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

describe("verification text is short enough to read", () => {
	const submit = (explanation: string, regressions: unknown[] = []) => {
		const { tool, channel } = createSubmitVerificationTool({
			expectedIds: ["run/finding"],
			cycle: 1,
		});
		return {
			channel,
			run: () =>
				tool.execute(
					"id",
					{
						items: [
							{
								id: "run/finding",
								disposition: "resolved",
								evidence: { file: "src/a.ts", explanation },
							},
						],
						regressions,
					},
					undefined,
					undefined,
					{},
				),
		};
	};

	it("refuses an explanation over 500 characters, naming the limit", async () => {
		const long = submit("x".repeat(501));
		await expect(long.run()).rejects.toThrow(/explanation.*500 characters/u);
		expect(long.channel.read()).toBeUndefined();
		const fits = submit("x".repeat(500));
		await fits.run();
		expect(fits.channel.read()?.items).toHaveLength(1);
	});

	it("refuses a regression title over 120 characters", async () => {
		const long = submit("ok", [
			{ file: "src/a.ts", line: 1, title: "t".repeat(121), evidence: "e" },
		]);
		await expect(long.run()).rejects.toThrow(/title.*120 characters/u);
	});
});
