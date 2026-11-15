import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("the test suite never reaches GitHub", () => {
	it("resolves gh to the fake that always fails", () => {
		let failure: unknown;
		try {
			execFileSync("gh", ["api", "user"], { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			failure = error;
		}
		expect(String((failure as { stderr?: unknown })?.stderr)).toContain(
			"fake gh: tests never reach GitHub",
		);
	});
});
