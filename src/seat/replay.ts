import type { SeatProfile } from "./channel-profile.js";
import { runSeatForReplay, type SeatRunResult } from "./run-seat.js";
import type { SeatSpec } from "./sdk-session.js";

/**
 * Durable package-runner input for a seat. This is replayable through the
 * same SDK runner without shell reconstruction or inherited process
 * environment.
 */
export type SeatReplayInput = SeatSpec<SeatProfile>;

export function replaySeat(
	input: SeatReplayInput,
): Promise<SeatRunResult<SeatProfile>>;
export function replaySeat<T>(
	input: SeatReplayInput,
	runner: (spec: SeatReplayInput) => Promise<T>,
): Promise<T>;
export function replaySeat<T>(
	input: SeatReplayInput,
	runner?: (spec: SeatReplayInput) => Promise<T>,
): Promise<T | SeatRunResult<SeatProfile>> {
	const replay = {
		...input,
		...(input.extraExtensionPaths === undefined
			? {}
			: { extraExtensionPaths: [...input.extraExtensionPaths] }),
		...(input.expectedIds === undefined
			? {}
			: { expectedIds: [...input.expectedIds] }),
	};
	return runner === undefined ? runSeatForReplay(replay) : runner(replay);
}
