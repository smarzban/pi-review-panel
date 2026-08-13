import type { AuditRow } from "./audit-schema.js";
import type { SubmissionChannel } from "./channel-file.js";
import {
	DEFAULT_SEAT_PROFILE,
	type FindingsProfile,
	type SeatProfile,
} from "./channel-profile.js";
import type { SeatReplayInput } from "./replay.js";
import type { Finding } from "./schema.js";
import type { VerificationResult } from "./verification-schema.js";

export const MAX_FAILURE_REASON_LENGTH = 2_048;

export type SeatIdentity = { provider: string; model: string; lens: string };

export type FailureClass =
	| "spawn-failure"
	| "killed"
	| "provider-error"
	| "channel-error"
	| "no-submit";

export type SeatLifecycle = {
	startedAtMs: number;
	settledAtMs: number;
	durationMs: number;
	attempts: 1 | 2;
	aborted: boolean;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
};

export type ChannelOutcome<P extends SeatProfile> = P extends { kind: "audit" }
	? { kind: "audit"; rows: AuditRow[] }
	: P extends { kind: "verification" }
		? { kind: "verification"; result: VerificationResult }
		: { kind: "findings"; findings: Finding[] };

export type SeatResult<P extends SeatProfile = FindingsProfile> = {
	identity: SeatIdentity;
	replay: SeatReplayInput;
	lifecycle: SeatLifecycle;
	recovered?: true;
	outcome:
		| ChannelOutcome<P>
		| { kind: "failure"; class: FailureClass; reason: string };
};

export type ClassifyInput<P extends SeatProfile = FindingsProfile> = {
	identity: SeatIdentity;
	replay: SeatReplayInput;
	lifecycle: SeatLifecycle;
	profile?: P;
	channel: SubmissionChannel<unknown>;
	nudgeFired: boolean;
	error?: unknown;
};

function reason(prefix: string, detail?: unknown): string {
	const text =
		detail instanceof Error
			? detail.message
			: typeof detail === "string"
				? detail
				: "";
	return (text.length === 0 ? prefix : `${prefix}: ${text}`).slice(
		0,
		MAX_FAILURE_REASON_LENGTH,
	);
}

function failure<P extends SeatProfile>(
	input: ClassifyInput<P>,
	failureClass: FailureClass,
	message: string,
): SeatResult<P> {
	return {
		identity: { ...input.identity },
		replay: input.replay,
		lifecycle: input.lifecycle,
		outcome: { kind: "failure", class: failureClass, reason: message },
	};
}

/**
 * Classifies the closure-owned structured result after the SDK session
 * settles. The channel is not a model-provided filename or a host stream.
 */
export function classifyOutcome<P extends SeatProfile = FindingsProfile>(
	input: ClassifyInput<P>,
): SeatResult<P> {
	const profile = input.profile ?? (DEFAULT_SEAT_PROFILE as P);
	let value: unknown;
	try {
		// A completed channel submission wins a simultaneous budget abort: the
		// SDK may observe cancellation after its structured result is stored.
		value = input.channel.read();
	} catch (error) {
		if (input.lifecycle.aborted) {
			return failure(input, "killed", "seat SDK session was aborted");
		}
		return failure(
			input,
			"channel-error",
			reason("seat channel could not be read", error),
		);
	}
	if (value === undefined) {
		if (input.lifecycle.aborted) {
			return failure(input, "killed", "seat SDK session was aborted");
		}
		if (input.error !== undefined) {
			return failure(
				input,
				"provider-error",
				reason("seat SDK session failed", input.error),
			);
		}
		const subject =
			profile.kind === "audit"
				? "audit results"
				: profile.kind === "verification"
					? "verification results"
					: "findings";
		return failure(
			input,
			"no-submit",
			input.nudgeFired
				? `seat SDK session ended without submitting ${subject} after no-submit retry`
				: `seat SDK session ended without submitting ${subject}`,
		);
	}
	if (profile.kind === "audit") {
		return {
			identity: { ...input.identity },
			replay: input.replay,
			lifecycle: input.lifecycle,
			...(input.nudgeFired ? { recovered: true as const } : {}),
			outcome: { kind: "audit", rows: value as AuditRow[] },
		} as SeatResult<P>;
	}
	if (profile.kind === "verification") {
		return {
			identity: { ...input.identity },
			replay: input.replay,
			lifecycle: input.lifecycle,
			...(input.nudgeFired ? { recovered: true as const } : {}),
			outcome: { kind: "verification", result: value as VerificationResult },
		} as SeatResult<P>;
	}
	return {
		identity: { ...input.identity },
		replay: input.replay,
		lifecycle: input.lifecycle,
		...(input.nudgeFired ? { recovered: true as const } : {}),
		outcome: { kind: "findings", findings: value as Finding[] },
	} as SeatResult<P>;
}
