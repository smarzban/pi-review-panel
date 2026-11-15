import { describe, expect, it } from "vitest";
import { createSubmissionChannel } from "../src/seat/channel-file.js";
import {
	SEAT_PROFILES,
	type SeatProfile,
} from "../src/seat/channel-profile.js";
import {
	type ClassifyInput,
	classifyOutcome,
	MAX_FAILURE_REASON_LENGTH,
} from "../src/seat/classify.js";

const replay = {
	provider: "openai-codex",
	model: "gpt-5.6-terra",
	lens: "security",
	lensPrompt: "Review.",
	baseRef: "base",
	worktree: "/snapshot",
};

function input(
	overrides: Partial<ClassifyInput<SeatProfile>> = {},
): ClassifyInput<SeatProfile> {
	return {
		identity: {
			provider: replay.provider,
			model: replay.model,
			lens: replay.lens,
		},
		replay,
		lifecycle: {
			startedAtMs: 1,
			settledAtMs: 2,
			durationMs: 1,
			attempts: 1,
			aborted: false,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		channel: createSubmissionChannel<unknown>(),
		nudgeFired: false,
		...overrides,
	};
}

describe("SDK result classification", () => {
	it("keeps a valid structured submission that won the budget race", () => {
		const channel = createSubmissionChannel<unknown>();
		channel.submit([]);
		const submittedThenAborted = classifyOutcome(
			input({
				channel,
				lifecycle: { ...input().lifecycle, aborted: true },
				error: new Error("the budget abort also reached the SDK"),
			}),
		);
		expect(submittedThenAborted.outcome).toEqual({
			kind: "findings",
			findings: [],
		});

		const provider = classifyOutcome(
			input({ error: new Error("provider failed") }),
		);
		expect(provider.outcome).toEqual({
			kind: "failure",
			class: "provider-error",
			reason: "seat SDK session failed: provider failed",
		});
	});

	it("classifies channel read failure before no-submit and bounds its reason", () => {
		const channel = {
			submit: (_value: unknown) => undefined,
			read: () => {
				throw new Error("x".repeat(MAX_FAILURE_REASON_LENGTH + 100));
			},
			hasSubmitted: () => false,
		};
		const outcome = classifyOutcome(input({ channel }));
		expect(outcome.outcome).toMatchObject({
			kind: "failure",
			class: "channel-error",
		});
		if (outcome.outcome.kind === "failure") {
			expect(outcome.outcome.reason.length).toBe(MAX_FAILURE_REASON_LENGTH);
		}
	});

	it("names the role channel for no-submit and marks only nudge recovery", () => {
		const grouping = classifyOutcome(
			input({ profile: SEAT_PROFILES.grouping, nudgeFired: true }),
		);
		const verification = classifyOutcome(
			input({ profile: SEAT_PROFILES.verification, nudgeFired: true }),
		);
		for (const outcome of [grouping, verification]) {
			expect(outcome.outcome).toMatchObject({
				kind: "failure",
				class: "no-submit",
			});
			expect(outcome).not.toHaveProperty("recovered");
		}
		if (grouping.outcome.kind === "failure") {
			expect(grouping.outcome.reason).toContain("groups after no-submit retry");
		}
		if (verification.outcome.kind === "failure") {
			expect(verification.outcome.reason).toContain(
				"verification results after no-submit retry",
			);
		}

		const findings = createSubmissionChannel<unknown>();
		findings.submit([]);
		const recovered = classifyOutcome(
			input({ channel: findings, nudgeFired: true }),
		);
		expect(recovered).toMatchObject({
			recovered: true,
			outcome: { kind: "findings", findings: [] },
		});
	});

	it("preserves the profile-specific trusted closure result and copies identity", () => {
		const groupingChannel = createSubmissionChannel<unknown>();
		const groups = [["F-1", "F-2"], ["F-3"]];
		groupingChannel.submit(groups);
		const grouping = classifyOutcome(
			input({ profile: SEAT_PROFILES.grouping, channel: groupingChannel }),
		);
		expect(grouping.outcome).toEqual({ kind: "grouping", groups });
		expect(grouping.identity).toEqual(input().identity);
		expect(grouping.identity).not.toBe(input().identity);

		const verificationChannel = createSubmissionChannel<unknown>();
		const verificationResult = { items: [], regressions: [] };
		verificationChannel.submit(verificationResult);
		const verification = classifyOutcome(
			input({
				profile: SEAT_PROFILES.verification,
				channel: verificationChannel,
			}),
		);
		expect(verification.outcome).toEqual({
			kind: "verification",
			result: verificationResult,
		});
		expect(verification.identity).toEqual(input().identity);
		expect(verification.identity).not.toBe(input().identity);
	});
});
