// biome-ignore format: This import must remain one line for the ts-expect-error directive.
// @ts-expect-error The initial scaffold has no Node type declarations.
import { performance } from "node:perf_hooks";
import {
	type AuditProfile,
	DEFAULT_SEAT_PROFILE,
	type FindingsProfile,
	type FindingsSeatProfile,
	type SeatProfile,
	type VerificationProfile,
} from "./channel-profile.js";
import {
	classifyOutcome,
	type SeatLifecycle,
	type SeatResult,
} from "./classify.js";
import { assembleSeatPrompt } from "./prompt.js";
import {
	createSdkSeatSession,
	type SdkSeatSession,
	type SdkSeatSessionInput,
	type SeatSpec,
} from "./sdk-session.js";
import { createConfinementGuard, createSeatTools } from "./seat-extension.js";

export type SdkSessionFactory = (
	input: SdkSeatSessionInput,
) => Promise<SdkSeatSession>;

export type LiveSeatSnapshot = {
	attempts: 1 | 2;
	tokens?: number;
	cost?: number;
	lastTool?: string;
};

/** Scheduler-owned box. runSeat writes `current` once the session exists. */
export type LiveSeatProbe = {
	current?: () => LiveSeatSnapshot;
};

export type RunSeatOptions = {
	/** Aborts the active SDK request without a subprocess signal ladder. */
	abortSignal?: AbortSignal;
	/** Injectable SDK construction seam used by tests and host adapters. */
	sessionFactory?: SdkSessionFactory;
	/** Legacy monotonic clock seam, retained for callers that inject scheduler time. */
	now?: () => number;
	/** Monotonic deadline clock, shared explicitly with the scheduler. */
	deadlineNow?: () => number;
	/** Epoch wall clock used only for persisted timestamps. */
	wallNow?: () => number;
	/** Absolute monotonic deadline for this seat, owned by the scheduler. */
	deadlineMs?: number;
	/** In-flight stats for host progress. Absent when the caller does not poll. */
	live?: LiveSeatProbe;
};

export type SeatRunResult<P extends SeatProfile = FindingsProfile> =
	SeatResult<P>;

function profileFor(spec: SeatSpec<SeatProfile>): SeatProfile {
	return spec.profile ?? DEFAULT_SEAT_PROFILE;
}

function identityFor(spec: SeatSpec<SeatProfile>) {
	return { provider: spec.provider, model: spec.model, lens: spec.lens };
}

function emptyLifecycle(
	startedAtMs: number,
	settledAtMs: number,
	durationMs: number,
	aborted: boolean,
): SeatLifecycle {
	return {
		startedAtMs,
		settledAtMs,
		durationMs,
		attempts: 1,
		aborted,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};
}

function lifecycleFor(
	session: SdkSeatSession | undefined,
	startedAtMs: number,
	settledAtMs: number,
	durationMs: number,
	attempts: 1 | 2,
	aborted: boolean,
): SeatLifecycle {
	let stats:
		| ReturnType<SdkSeatSession["session"]["getSessionStats"]>
		| undefined;
	try {
		stats = session?.session.getSessionStats();
	} catch {
		// Stats are reporting data. A failed read never changes the seat result.
	}
	return {
		...emptyLifecycle(startedAtMs, settledAtMs, durationMs, aborted),
		attempts,
		...(stats === undefined ? {} : { tokens: stats.tokens, cost: stats.cost }),
	};
}

async function runSeatInternal(
	spec: SeatSpec<SeatProfile>,
	options: RunSeatOptions,
): Promise<SeatRunResult<SeatProfile>> {
	const deadlineNow =
		options.deadlineNow ?? options.now ?? (() => performance.now());
	const wallNow = options.wallNow ?? Date.now;
	const startedAtMs = wallNow();
	const startedAtMonotonicMs = deadlineNow();
	const profile = profileFor(spec);
	const toolset = createSeatTools({
		worktree: spec.worktree,
		profile,
		expectedIds: spec.expectedIds,
		cycle: spec.cycle,
	});
	const replay = {
		...spec,
		...(spec.extraExtensionPaths === undefined
			? {}
			: { extraExtensionPaths: [...spec.extraExtensionPaths] }),
		...(spec.expectedIds === undefined
			? {}
			: { expectedIds: [...spec.expectedIds] }),
	};
	let session: SdkSeatSession | undefined;
	let aborted = options.abortSignal?.aborted === true;
	let attempts: 1 | 2 = 1;
	let lastTool: string | undefined;
	let nudgeFired = false;
	let error: unknown;
	let abortListener: (() => void) | undefined;
	let abortSettlement: Promise<void> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let constructionCancelled = false;
	const cleanedLateSessions = new WeakSet<SdkSeatSession>();
	let resolveConstructionCancellation: (() => void) | undefined;
	const constructionCancellation = new Promise<void>((resolve) => {
		resolveConstructionCancellation = resolve;
	});
	const abortSession = (): void => {
		if (session === undefined || abortSettlement !== undefined) return;
		aborted = true;
		abortSettlement = Promise.resolve(session.session.abort()).catch(
			(cause) => {
				// Abort rejection is a factual SDK failure. Retain it for classification
				// and, critically, observe it before dispose so it cannot leak as an
				// unhandled rejection.
				if (error === undefined) error = cause;
			},
		);
	};
	const cancelConstruction = (): void => {
		if (constructionCancelled) return;
		constructionCancelled = true;
		aborted = true;
		resolveConstructionCancellation?.();
		abortSession();
	};
	const cleanupLateSession = (lateSession: SdkSeatSession): void => {
		if (cleanedLateSessions.has(lateSession)) return;
		cleanedLateSessions.add(lateSession);
		// A factory that wins only after cancellation never receives a prompt, so
		// it holds no model-seat work or capacity. Its resources still need the
		// normal abort-before-dispose order, with every rejection observed.
		void (async () => {
			try {
				await lateSession.session.abort();
			} catch {}
			try {
				lateSession.session.dispose();
			} catch {}
		})();
	};

	try {
		if (!aborted) {
			const factory = options.sessionFactory ?? createSdkSeatSession;
			abortListener = cancelConstruction;
			options.abortSignal?.addEventListener("abort", abortListener, {
				once: true,
			});
			if (options.abortSignal?.aborted) {
				cancelConstruction();
			}
			if (options.deadlineMs !== undefined && !constructionCancelled) {
				const remaining = options.deadlineMs - deadlineNow();
				if (remaining <= 0) {
					cancelConstruction();
				} else {
					deadlineTimer = setTimeout(cancelConstruction, remaining);
				}
			}
			if (!constructionCancelled) {
				const confine = createConfinementGuard({
					worktree: spec.worktree,
				});
				if (options.live !== undefined) {
					options.live.current = () => {
						let tokens: number | undefined;
						let cost: number | undefined;
						try {
							const stats = session?.session.getSessionStats();
							tokens = stats?.tokens.total;
							cost = stats?.cost;
						} catch {
							// Live stats are observational. A failed read must not stop the seat.
						}
						return {
							attempts,
							...(tokens === undefined ? {} : { tokens }),
							...(cost === undefined ? {} : { cost }),
							...(lastTool === undefined ? {} : { lastTool }),
						};
					};
				}
				const factoryPromise = Promise.resolve().then(() =>
					factory({
						spec,
						tools: toolset.tools,
						confinementGuard: (event) => {
							lastTool = event.toolName;
							return confine(event);
						},
					}),
				);
				// Observe a late factory rejection and reclaim a late session without
				// allowing either path to start a prompt after cancellation.
				void factoryPromise.then(
					(lateSession) => {
						if (constructionCancelled) cleanupLateSession(lateSession);
					},
					() => undefined,
				);
				const constructed = await Promise.race([
					factoryPromise,
					constructionCancellation.then(() => undefined),
				]);
				if (constructed !== undefined) {
					if (constructionCancelled) {
						cleanupLateSession(constructed);
					} else {
						session = constructed;
						await session.session.prompt(
							assembleSeatPrompt({
								lensPrompt: spec.lensPrompt,
								baseRef: spec.baseRef,
								scopingNote: spec.scopingNote,
								dataAppendix: spec.dataAppendix,
								profile,
							}),
						);
						if (
							options.deadlineMs !== undefined &&
							deadlineNow() >= options.deadlineMs
						) {
							cancelConstruction();
						}
						if (!toolset.channel.hasSubmitted() && !aborted) {
							nudgeFired = true;
							attempts = 2;
							await session.session.prompt(profile.noSubmitNudge);
						}
					}
				}
			}
		}
	} catch (cause) {
		error = cause;
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		options.abortSignal?.removeEventListener(
			"abort",
			abortListener ?? (() => undefined),
		);
		try {
			await abortSettlement;
		} catch {
			// abortSettlement observes its own rejection, this is defensive only.
		}
		try {
			session?.session.dispose();
		} catch {
			// Disposal must not hide the model result or cancellation state.
		}
	}

	const settledAtMs = wallNow();
	const durationMs = Math.max(0, deadlineNow() - startedAtMonotonicMs);
	const lifecycle = lifecycleFor(
		session,
		startedAtMs,
		settledAtMs,
		durationMs,
		attempts,
		aborted,
	);
	if (aborted && session === undefined) {
		return {
			identity: identityFor(spec),
			replay,
			lifecycle,
			outcome: {
				kind: "failure",
				class: "killed",
				reason: "seat SDK session was aborted before it started",
			},
		};
	}
	return classifyOutcome({
		identity: identityFor(spec),
		replay,
		lifecycle,
		profile,
		channel: toolset.channel as Parameters<
			typeof classifyOutcome
		>[0]["channel"],
		nudgeFired,
		...(error === undefined ? {} : { error }),
	});
}

/** The package runner contract used by structured replay. */
export async function runSeatForReplay(
	spec: SeatSpec<SeatProfile>,
	options: RunSeatOptions = {},
): Promise<SeatRunResult<SeatProfile>> {
	return runSeatInternal(spec, options);
}

/** Runs one findings reporter through an isolated embedded SDK session. */
export async function runSeat<P extends FindingsSeatProfile = FindingsProfile>(
	spec: SeatSpec<P>,
	options: RunSeatOptions = {},
): Promise<SeatRunResult<P>> {
	return (await runSeatInternal(
		spec as SeatSpec<SeatProfile>,
		options,
	)) as SeatRunResult<P>;
}

/** Runs one claim-audit or fix-verification reviewer through the same SDK lifecycle. */
export async function runAdvisorySeat(
	spec: SeatSpec<AuditProfile | VerificationProfile>,
	options: RunSeatOptions = {},
): Promise<SeatRunResult<AuditProfile | VerificationProfile>> {
	return (await runSeatInternal(
		spec as SeatSpec<SeatProfile>,
		options,
	)) as SeatRunResult<AuditProfile | VerificationProfile>;
}
