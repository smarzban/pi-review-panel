import type { SeatIdentity } from "../seat/classify.js";
import type { Finding } from "../seat/schema.js";
import type { PlannedSeat, SeatOutcomeFacts, StampedFinding } from "./types.js";

/**
 * Unions the validated findings of voted seats only, stamping run-owned ids
 * F-1..F-n in seat-list order then row order. Pure and deterministic: it
 * unions and stamps, never ranks, dedupes, or judges.
 */
export function collectFindings(
	outcomes: SeatOutcomeFacts[],
): StampedFinding[] {
	const stamped: StampedFinding[] = [];

	for (const facts of outcomes) {
		if (facts.outcome.kind !== "voted") {
			continue;
		}
		for (const row of facts.outcome.findings) {
			stamped.push({
				id: `F-${stamped.length + 1}`,
				seat: identityOf(facts.seat),
				finding: copyFinding(row),
			});
		}
	}

	return stamped;
}

function identityOf(seat: PlannedSeat): SeatIdentity {
	return { provider: seat.provider, model: seat.model, lens: seat.lens };
}

/** Copies every validated schema field; a model-authored id never survives. */
function copyFinding(row: Finding): Finding {
	const copy = { ...row } as Record<string, unknown>;
	delete copy.id;
	return copy as Finding;
}
