import { type RunReviewOptions, runReview } from "../../src/run/run-review.js";
import type { RunConfig } from "../../src/run/types.js";
import type {
	AuditProfile,
	VerificationProfile,
} from "../../src/seat/channel-profile.js";
import type {
	SdkSessionFactory,
	SeatRunResult,
} from "../../src/seat/run-seat.js";
import type {
	SdkSeatSession,
	SdkSeatSessionInput,
	SeatSpec,
} from "../../src/seat/sdk-session.js";

export const SDK_FINDING = {
	file: "src/example.ts",
	line: 1,
	severity: "low" as const,
	title: "SDK finding",
	evidence: "The injected SDK session submitted this finding.",
};

type FakeResponse =
	| { kind: "default" }
	| { kind: "findings"; findings?: unknown[]; afterNudge?: boolean }
	| { kind: "audit"; holds?: boolean; afterNudge?: boolean }
	| {
			kind: "verification";
			disposition?: "resolved" | "still present" | "inconclusive";
			afterNudge?: boolean;
	  }
	| { kind: "failure"; message?: string }
	| { kind: "silent" }
	| { kind: "pending" };

type SubmissionTool = {
	name: string;
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: unknown,
	) => Promise<unknown>;
};

export type FakeSdkRun = {
	input: SdkSeatSessionInput;
	prompts: string[];
	aborted: boolean;
	disposed: boolean;
};

function isSubmissionTool(value: unknown): value is SubmissionTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function responseForProfile(
	input: SdkSeatSessionInput,
	response: FakeResponse,
): Record<string, unknown> | undefined {
	const profile = input.spec.profile?.kind ?? "findings";
	if (
		response.kind === "silent" ||
		response.kind === "pending" ||
		response.kind === "failure"
	) {
		return undefined;
	}
	if (profile === "audit") {
		return {
			rows: (input.spec.expectedIds ?? []).map((id) => ({
				id,
				holds: response.kind === "audit" ? (response.holds ?? true) : true,
				rationale: "verified against the code",
			})),
		};
	}
	if (profile === "verification") {
		return {
			items: (input.spec.expectedIds ?? []).map((id) => {
				const disposition =
					response.kind === "verification"
						? (response.disposition ?? "resolved")
						: "resolved";
				return {
					id,
					disposition,
					...(disposition === "resolved"
						? {
								evidence: {
									file: "src/example.ts",
									explanation: "The injected SDK session checked this repair.",
								},
							}
						: {}),
				};
			}),
			regressions: [],
		};
	}
	return {
		findings:
			response.kind === "findings"
				? (response.findings ?? [SDK_FINDING])
				: [SDK_FINDING],
	};
}

function waitsForNudge(response: FakeResponse): boolean {
	return (
		(response.kind === "findings" ||
			response.kind === "audit" ||
			response.kind === "verification") &&
		response.afterNudge === true
	);
}

/**
 * An injected embedded-session fake. It invokes the real role-specific custom
 * tool, so submissions still cross the production validation boundary without
 * an executable, environment protocol, or compatibility backend.
 */
export function createSdkSeatFake(
	responses: FakeResponse[] = [{ kind: "default" }],
): { factory: SdkSessionFactory; runs: FakeSdkRun[] } {
	const runs: FakeSdkRun[] = [];
	let nextResponse = 0;
	const factory: SdkSessionFactory = async (input) => {
		const response = responses[Math.min(nextResponse, responses.length - 1)];
		nextResponse += 1;
		const run: FakeSdkRun = {
			input,
			prompts: [],
			aborted: false,
			disposed: false,
		};
		runs.push(run);
		let submitted = false;
		let releasePendingPrompt: (() => void) | undefined;
		const session: SdkSeatSession = {
			session: {
				async prompt(text) {
					run.prompts.push(text);
					if (run.aborted || response.kind === "silent") {
						return;
					}
					if (response.kind === "pending") {
						await new Promise<void>((resolve) => {
							releasePendingPrompt = resolve;
						});
						return;
					}
					if (response.kind === "failure") {
						throw new Error(
							response.message ?? "injected SDK provider failure",
						);
					}
					if (
						submitted ||
						(waitsForNudge(response) && run.prompts.length < 2)
					) {
						return;
					}
					const args = responseForProfile(input, response);
					const tool = input.tools.find(
						(value): value is SubmissionTool =>
							isSubmissionTool(value) && value.name.startsWith("submit_"),
					);
					if (args === undefined || tool === undefined) {
						return;
					}
					await tool.execute(
						"injected-sdk-seat",
						args,
						new AbortController().signal,
						() => undefined,
						{},
					);
					submitted = true;
				},
				async abort() {
					run.aborted = true;
					releasePendingPrompt?.();
				},
				dispose() {
					run.disposed = true;
				},
				getSessionStats() {
					return {
						tokens: {
							input: 3,
							output: 5,
							cacheRead: 7,
							cacheWrite: 11,
							total: 26,
						},
						cost: 0.02,
					};
				},
			},
		};
		return session;
	};
	return { factory, runs };
}

/** An advisory-seat seam with the same structured result shape as an SDK seat. */
export function createAdvisorySeatRunner(
	responses: FakeResponse[] = [{ kind: "default" }],
): (
	spec: SeatSpec<AuditProfile | VerificationProfile>,
) => Promise<SeatRunResult<AuditProfile | VerificationProfile>> {
	let nextResponse = 0;
	return async (spec) => {
		const response = responses[Math.min(nextResponse, responses.length - 1)];
		nextResponse += 1;
		const replay = {
			...spec,
			...(spec.expectedIds === undefined
				? {}
				: { expectedIds: [...spec.expectedIds] }),
		};
		const lifecycle = {
			startedAtMs: 1,
			settledAtMs: 2,
			durationMs: 1,
			attempts: 1 as const,
			aborted: false,
			tokens: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, total: 26 },
			cost: 0.02,
		};
		if (response.kind === "failure") {
			return {
				identity: {
					provider: spec.provider,
					model: spec.model,
					lens: spec.lens,
				},
				replay,
				lifecycle,
				outcome: {
					kind: "failure",
					class: "provider-error",
					reason: response.message ?? "injected SDK provider failure",
				},
			};
		}
		if (spec.profile?.kind === "verification") {
			return {
				identity: {
					provider: spec.provider,
					model: spec.model,
					lens: spec.lens,
				},
				replay,
				lifecycle,
				outcome: {
					kind: "verification",
					result: {
						items: (spec.expectedIds ?? []).map((id) => {
							const disposition =
								response.kind === "verification"
									? (response.disposition ?? "resolved")
									: "resolved";
							return {
								id,
								disposition,
								...(disposition === "resolved"
									? {
											evidence: {
												file: "src/example.ts",
												explanation:
													"The injected SDK session checked this repair.",
											},
										}
									: {}),
							};
						}),
						regressions: [],
					},
				},
			};
		}
		return {
			identity: { provider: spec.provider, model: spec.model, lens: spec.lens },
			replay,
			lifecycle,
			outcome: {
				kind: "audit",
				rows: (spec.expectedIds ?? []).map((id) => ({
					id,
					holds: response.kind === "audit" ? (response.holds ?? true) : true,
					rationale: "verified against the code",
				})),
			},
		};
	};
}

/** A run-review seam that still uses the production scheduler and record flow. */
export function createSdkReviewRunner(
	responses: FakeResponse[] = [{ kind: "default" }],
): (
	config: RunConfig,
	options?: RunReviewOptions,
) => ReturnType<typeof runReview> {
	return (config, options = {}) => {
		const fake = createSdkSeatFake(responses);
		return runReview(config, { ...options, sessionFactory: fake.factory });
	};
}

export type { FakeResponse };
