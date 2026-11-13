import { readdirSync } from "node:fs";
import path from "node:path";

import { runReview } from "../../src/run/run-review.js";
import type { PlannedSeat } from "../../src/run/types.js";
import { TEST_RECORD_KEY } from "./record-key.js";
import { createSdkSeatFake } from "./sdk-seat-fake.js";

/** Planned seats `seat-0`, `seat-1`, … with one lens each. */
export function plannedSeats(lenses: string[]): PlannedSeat[] {
	return lenses.map((lens, index) => ({
		rosterId: `seat-${index}`,
		provider: "openai-codex",
		model: `gpt-5.6-${index}`,
		lens,
		lensPrompt: `Review through ${lens}.`,
	}));
}

/**
 * Writes a real review record signed with `TEST_RECORD_KEY`, interrupted after
 * its first seat settled, and returns its run id.
 */
export async function interruptedReviewRecord(
	repoDir: string,
	seats: PlannedSeat[],
): Promise<string> {
	const controller = new AbortController();
	const fake = createSdkSeatFake([
		{ kind: "default" },
		...seats.slice(1).map(() => ({ kind: "pending" as const })),
	]);
	await runReview(
		{ repoDir, baseRef: "HEAD~1", seats },
		{
			abortSignal: controller.signal,
			recordKey: TEST_RECORD_KEY,
			sessionFactory: fake.factory,
			onProgress: (event) => {
				if (event.kind === "seat-finished") {
					controller.abort();
				}
			},
		},
	).then(
		() => {
			throw new Error("the review was meant to be interrupted");
		},
		(error: unknown) => {
			if (!/cancel/i.test(String(error))) {
				throw error;
			}
		},
	);
	return readdirSync(path.join(repoDir, ".review-panel", "runs"))[0] as string;
}
