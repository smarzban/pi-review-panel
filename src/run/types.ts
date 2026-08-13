import type {
	FailureClass,
	SeatIdentity,
	SeatLifecycle,
} from "../seat/classify.js";
import type { SeatReplayInput } from "../seat/replay.js";
import type { Finding } from "../seat/schema.js";

/** One seat the run planned: its roster identity and the lens to run it with. */
export type PlannedSeat = {
	/** Roster identity, carried as run metadata; never part of the SeatSpec. */
	rosterId: string;
	provider: string;
	model: string;
	lens: string;
	lensPrompt: string;
	/**
	 * Extra seat extensions, absolute paths, threaded into the seat's `-e` args
	 * (AC-9). Absent means no extra extensions.
	 */
	extraExtensionPaths?: string[];
};

/** A run's inputs. */
export type RunConfig = {
	repoDir: string;
	baseRef: string;
	/** Boundary-pinned full base commit, when the supported path supplied one. */
	baseRevision?: string;
	/** Boundary-pinned full head commit, when the supported path supplied one. */
	headRevision?: string;
	seats: PlannedSeat[];
	/**
	 * Coordinator-owned role attribution used to distinguish concurrently
	 * reserved role panels with the same base ref and timestamp.
	 */
	role?: string;
	/**
	 * The exact committed revision to snapshot and review. Absent means
	 * HEAD at run start (direct review). The review-loop discovery
	 * coordinator pins the loop's starting revision here so every phase and
	 * retry reviews the same committed snapshot (AC-48).
	 */
	revision?: string;
	/** Run-level scope note threaded into every seat's prompt (AC-23). */
	scopingNote?: string;
	/** Per-seat wall-clock budget override; the scheduler default applies when absent. */
	seatBudgetMs?: number;
	/**
	 * Prior run record paths whose discard ledgers flag this run's findings
	 * (AC-16), newest-first by contract. The adapter discovers and orders
	 * them (T-18); absent means no flags and no notices (AC-17).
	 */
	priorRecordPaths?: string[];
};

/** What one seat's run produced. */
export type SeatOutcomeFacts = {
	seat: PlannedSeat;
	/** Complete SDK package-runner input, never a reconstructed shell command. */
	replay: SeatReplayInput;
	/** SDK timing, usage, cost, cancellation, and retry facts. */
	lifecycle: SeatLifecycle;
	outcome:
		| { kind: "voted"; findings: Finding[] }
		| { kind: "failed"; class: FailureClass; reason: string };
};

/** A validated finding plus its run-stamped id. */
export type StampedFinding = {
	id: string;
	seat: SeatIdentity;
	finding: Finding;
};

/** A run's outcome: the record location and the per-seat outcomes. */
export type RunResult = {
	recordPath: string;
	outcomes: SeatOutcomeFacts[];
};

/** A reserved run record: its id and the paths the run writes to. */
export type ReservedRecord = {
	runId: string;
	recordPath: string;
	reportPath: string;
	findingsPath: string;
	panelPath: string;
	/** Durable SDK lifecycle and structured replay record. */
	executionPath: string;
};

/**
 * The durable planned-panel record (AC-25): the audit input, persisted
 * immediately after reservation and before any pinning or scheduling. Key
 * order is exactly `runId`, `baseRef`, optional `scopingNote`, `seats`;
 * each seat row is exactly `rosterId`, `lens`, `provider`, `model`.
 */
export type PanelRecord = {
	runId: string;
	baseRef: string;
	/** Run-level scope note, verbatim; the key is omitted entirely when absent (AC-23). */
	scopingNote?: string;
	seats: Array<{
		rosterId: string;
		lens: string;
		provider: string;
		model: string;
	}>;
};

/**
 * What {@link writePanel} needs to build a {@link PanelRecord}: the run's
 * identity, its baseRef, the optional scoping note, and the ordered planned
 * seats to project to the 4-key rows. Anything that must never be serialized
 * (lensPrompt, extraExtensionPaths, credentials) is intentionally absent.
 */
export type PanelRecordInput = {
	runId: string;
	baseRef: string;
	scopingNote?: string;
	seats: PlannedSeat[];
};
