import { describe, expect, it, vi } from "vitest";

const { runSeatForReplay } = vi.hoisted(() => ({
	runSeatForReplay: vi.fn(async (spec: unknown) => ({ spec })),
}));

vi.mock("../src/seat/run-seat.js", () => ({ runSeatForReplay }));

import { replaySeat } from "../src/seat/replay.js";

describe("structured seat replay", () => {
	it("invokes the package runner contract by default without shell reconstruction", async () => {
		const replay = {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "correctness",
			lensPrompt: "Review this change.",
			baseRef: "base-oid",
			scopingNote: "Focus on changed paths.",
			worktree: "/snapshot",
			extraExtensionPaths: ["/outside/provider.ts"],
		};

		await replaySeat(replay);

		expect(runSeatForReplay).toHaveBeenCalledTimes(1);
		expect(runSeatForReplay).toHaveBeenCalledWith(replay);
	});
});
