import type { SeatIdentity } from "../seat/classify.js";
import type { Finding } from "../seat/schema.js";
import type { SeatOutcomeFacts, StampedFinding } from "./types.js";

/** Identifies this run in the report header. */
export type RunMeta = {
	runId: string;
	/** Human-requested base ref (may be symbolic). */
	baseRef: string;
	/** Frozen base commit OID actually reviewed. */
	baseOid: string;
	/** Frozen HEAD commit OID at run start. */
	headOid: string;
};

/**
 * A persistence flag on one current finding: it co-locates with an earlier
 * discard, carrying the prior reason (ADR-0002). Produced by the persistence
 * flagger (flag.ts) and rendered inline on the flagged finding (AC-16).
 */
export type FindingFlag = {
	findingId: string;
	reason: string;
};

/**
 * A prior discard ledger that could not be read: surfaced in the report,
 * never skipped silently (AC-33). Produced by the persistence flagger
 * (flag.ts) and rendered in the loud unreadable-ledger section.
 */
export type LedgerNotice = {
	recordPath: string;
	reason: string;
};

/**
 * The persistence flagger's output for this run, passed in by the core
 * (run-review.ts). The renderer draws each flag inline on its finding and
 * every notice in a loud section. Absent means no annotations, and nothing
 * annotation-related is rendered.
 */
export type RunAnnotations = {
	flags: FindingFlag[];
	notices: LedgerNotice[];
};

/**
 * Everything the renderer needs for the two artifacts. Pure data in, text
 * out: the caller writes the files (T-15).
 */
export type RenderInput = {
	meta: RunMeta;
	stamped: StampedFinding[];
	outcomes: SeatOutcomeFacts[];
	annotations?: RunAnnotations;
	/** Durable snapshot-cleanup failure notice (AC-19), when any. */
	cleanupError?: string;
};

/** Presentation order for a seat's stated severity (AC-14). */
const SEVERITY_RANK: Record<Finding["severity"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

/**
 * Renders the report.md text. Unreadable-ledger notices first, when any,
 * in a loud section ahead of everything else (AC-33); then findings,
 * ordered by the severity the submitting seat stated (high, medium, low)
 * and attributed to that seat with the run-stamped id (AC-14), each flagged
 * finding carrying its persistence flag and the prior discard reason inline
 * (AC-16); then one section per planned seat with its identity and outcome
 * — voted with its finding count (zero allowed, AC-10, AC-11) or failed
 * with class and reason — and, for every seat that ran, the replay command
 * byte-identical to the command that ran (AC-15).
 *
 * Presentation only, per the constitution's "the tool never judges": no
 * verdict, no quorum, no agreement counting, no recomputed severity (NC-1).
 * Annotations are the flagger's mechanical prose, displayed attributed; a
 * flag's reason is carried verbatim, never reworded or ranked. Ordering by
 * a seat's STATED severity is presentation; nothing here derives a new one.
 * Pure: no filesystem, no clock, no process.
 */
export function renderReport(input: RenderInput): string {
	const annotations = input.annotations ?? { flags: [], notices: [] };
	const lines = [
		`# Review run ${input.meta.runId}`,
		"",
		`Base ref: \`${input.meta.baseRef}\``,
		`Base OID: \`${input.meta.baseOid}\``,
		`HEAD OID: \`${input.meta.headOid}\``,
		"",
		...renderCleanupSection(input.cleanupError),
		...renderLedgerNoticesSection(annotations.notices),
		...renderFindingsSection(input.stamped, annotations.flags),
		...renderSeatsSection(input.outcomes),
	];
	return `${lines.join("\n")}\n`;
}

function renderCleanupSection(cleanupError: string | undefined): string[] {
	if (cleanupError === undefined) {
		return [];
	}
	return [
		"## Snapshot cleanup failure",
		"",
		"The run's seat outcomes are unchanged. Snapshot release failed:",
		"",
		cleanupError,
		"",
	];
}

/**
 * Renders the findings.json content: the stamped findings exactly, ids
 * included, so a finding's id is identical in report.md and findings.json
 * (AC-13 cross-file identity). Nothing else belongs in the file: findings
 * entered only through the structured channel, and the renderer adds no
 * computed field.
 */
export function renderFindingsJson(stamped: StampedFinding[]): string {
	return `${JSON.stringify(stamped, null, 2)}\n`;
}

/**
 * Unreadable-ledger notices in one loud section ahead of the findings
 * (AC-33): a complete prior record whose ledger could not be read is never
 * skipped silently, so the section leads the body and states plainly which
 * record and why.
 */
function renderLedgerNoticesSection(notices: LedgerNotice[]): string[] {
	if (notices.length === 0) {
		return [];
	}
	const lines = [
		"## Unreadable discard ledgers",
		"",
		"Each prior run record below is marked complete, but its discard ledger",
		"could not be read. Its discards were not used for flagging; this is",
		"surfaced here rather than skipped silently.",
		"",
	];
	for (const notice of notices) {
		lines.push(
			`- Record: ${notice.recordPath}`,
			`- Reason: ${notice.reason}`,
			"",
		);
	}
	return lines;
}

function renderFindingsSection(
	stamped: StampedFinding[],
	flags: FindingFlag[],
): string[] {
	const lines = ["## Findings", ""];
	if (stamped.length === 0) {
		lines.push("No findings were submitted.", "");
		return lines;
	}
	lines.push(
		"Ordered by the severity the submitting seat stated (high, medium, low);",
		"severity is each seat's stated opinion, not a computed ranking.",
		"",
	);

	// The flagger emits at most one flag per finding; the map mirrors that.
	const reasonByFinding = new Map<string, string>();
	for (const flag of flags) {
		reasonByFinding.set(flag.findingId, flag.reason);
	}

	// Array.prototype.sort is stable: within one stated severity, findings
	// keep their collection (id) order.
	const ordered = [...stamped].sort(
		(a, b) =>
			SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity],
	);
	for (const entry of ordered) {
		lines.push(...renderFinding(entry, reasonByFinding.get(entry.id)), "");
	}
	return lines;
}

function renderFinding(
	entry: StampedFinding,
	priorReason: string | undefined,
): string[] {
	const lines = [
		`### ${entry.id} [${entry.finding.severity}] ${entry.finding.title}`,
		"",
		`- Seat: ${seatLabel(entry.seat)}`,
		`- Location: ${location(entry.finding)}`,
		`- Evidence: ${entry.finding.evidence}`,
	];
	if (priorReason !== undefined) {
		lines.push(
			"- Flag: co-locates with a finding discarded in a prior run.",
			`- Prior discard reason: ${priorReason}`,
		);
	}
	return lines;
}

function renderSeatsSection(outcomes: SeatOutcomeFacts[]): string[] {
	const voted = outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	).length;
	const lines = [
		"## Seats",
		"",
		`${outcomes.length} planned seats: ${voted} voted, ${outcomes.length - voted} failed.`,
		"",
	];
	for (const facts of outcomes) {
		lines.push(...renderSeat(facts), "");
	}
	return lines;
}

function renderSeat(facts: SeatOutcomeFacts): string[] {
	const lines = [`### ${seatLabel(facts.seat)}`, ""];

	if (facts.outcome.kind === "voted") {
		const count = facts.outcome.findings.length;
		lines.push(
			`- Outcome: voted, ${count} ${count === 1 ? "finding" : "findings"}`,
		);
	} else {
		lines.push(
			"- Outcome: failed",
			`- Failure class: ${facts.outcome.class}`,
			`- Reason: ${facts.outcome.reason}`,
		);
	}

	lines.push(
		"- SDK lifecycle:",
		`  - Duration: ${facts.lifecycle.durationMs}ms`,
		`  - Attempts: ${facts.lifecycle.attempts}`,
		`  - Aborted: ${facts.lifecycle.aborted}`,
		`  - Tokens: ${facts.lifecycle.tokens.total}`,
		`  - Cost: ${facts.lifecycle.cost}`,
	);
	return lines;
}

function location(finding: Finding): string {
	if (finding.endLine === undefined) {
		return `${finding.file}:${finding.line}`;
	}
	return `${finding.file}:${finding.line}-${finding.endLine}`;
}

function seatLabel(seat: SeatIdentity): string {
	return `${seat.provider}/${seat.model} (${seat.lens})`;
}
