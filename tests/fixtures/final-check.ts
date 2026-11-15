import type { ActionDependencies } from "../../src/actions/actions.js";
import type { Config } from "../../src/config/schema.js";
import type { RunVerifyResult } from "../../src/run/run-verify.js";

const CONFIG: Config = {
	roster: [{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" }],
	defaults: { seats: ["terra"] },
};

/**
 * `comment` runs the final check before its card whenever a round resolved
 * an id. Tests about the card itself, whose planted records name heads that
 * are not commits, answer it here: one seat voted, found nothing, and no
 * record is written, so the card shows the chain as the test wrote it.
 */
export function unrecordedFinalCheck(): Pick<
	ActionDependencies,
	"diagnose" | "loadConfig" | "runVerify"
> {
	return {
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => CONFIG,
		runVerify: async (input) => {
			if (input.final !== true) {
				throw new Error("only the final check runs here");
			}
			return {
				recordPath: "unrecorded",
				priorRunId: input.priorRunId,
				priorHeadOid: "a".repeat(40),
				headOid: input.headRevision,
				kept: [],
				final: true,
				outcomes: [],
			} satisfies RunVerifyResult;
		},
	};
}
