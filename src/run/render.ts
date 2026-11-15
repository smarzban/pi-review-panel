import type { SeatIdentity } from "../seat/classify.js";
import type { Finding } from "../seat/schema.js";
import {
	GROUP_SEVERITY_LABEL,
	type GroupingFacts,
	groupedView,
	groupingLostLine,
} from "./grouping.js";
import { inertLine } from "./inert-text.js";
import type { PlannedSeat, SeatOutcomeFacts, StampedFinding } from "./types.js";

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
 * Everything the renderer needs for the two artifacts. Pure data in, text
 * out: the caller writes the files (T-15).
 */
export type RenderInput = {
	meta: RunMeta;
	stamped: StampedFinding[];
	outcomes: SeatOutcomeFacts[];
	/** Durable snapshot-cleanup failure notice (AC-19), when any. */
	cleanupError?: string;
	/** Present only when a resume finished this record. */
	resume?: ResumeFacts;
	/** The grouping step, when it ran. */
	grouping?: GroupingFacts;
};

/**
 * The seats that ran, grouped by lens in planned order:
 * `Seats: holistic (sol, opus), tests (sol, opus)`. A seat that failed is listed
 * too; the reply's `Lost:` line names it again.
 */
export function renderSeatsLine(
	seats: ReadonlyArray<Pick<PlannedSeat, "rosterId" | "lens">>,
): string {
	const byLens = new Map<string, string[]>();
	for (const seat of seats) {
		const ids = byLens.get(seat.lens) ?? [];
		ids.push(seat.rosterId);
		byLens.set(seat.lens, ids);
	}
	const groups = [...byLens.entries()].map(
		([lens, ids]) => `${lens} (${ids.join(", ")})`,
	);
	return `Seats: ${groups.join(", ")}`;
}

/**
 * Which planned seats a resume ran again, which it kept as recorded, and
 * which it could not rebuild from the owner config (lost coverage).
 */
export type ResumeFacts = {
	rerun: PlannedSeat[];
	kept: PlannedSeat[];
	lost: PlannedSeat[];
	/** The record named a scoping note that the re-run seats did not get. */
	scopingNoteDropped?: boolean;
};

/** Said wherever a resume ran seats without the record's scoping note. */
export const SCOPING_NOTE_DROPPED =
	"The interrupted run had a scoping note. It is stored in the record, so the re-run seats did not get it.";

/**
 * States plainly that the record was finished by a resume and which seats
 * ran when. Presentation only: it says nothing about the findings.
 */
export function renderResumeSection(resume: ResumeFacts | undefined): string[] {
	if (resume === undefined) {
		return [];
	}
	return [
		"## Resumed run",
		"",
		"An earlier attempt at this run was interrupted. Seats that had settled",
		"were kept as recorded; the rest ran again against the same head commit.",
		"",
		...resume.kept.map(
			(seat) => `- Kept from the interrupted run: ${seatLabel(seat)}`,
		),
		...resume.rerun.map((seat) => `- Re-run: ${seatLabel(seat)}`),
		...resume.lost.map(
			(seat) =>
				`- Not run, could not be rebuilt from the owner config: ${seatLabel(seat)}`,
		),
		"",
		...(resume.scopingNoteDropped === true ? [SCOPING_NOTE_DROPPED, ""] : []),
	];
}

/** Presentation order for a seat's stated severity (AC-14). */
const SEVERITY_RANK: Record<Finding["severity"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

/**
 * Renders the report.md text. Findings first, ordered by the severity the
 * submitting seat stated (high, medium, low) and attributed to that seat
 * with the run-stamped id (AC-14); then one section per planned seat with its identity and outcome
 * — voted with its finding count (zero allowed, AC-10, AC-11) or failed
 * with class and reason — and, for every seat that ran, the replay command
 * byte-identical to the command that ran (AC-15).
 *
 * Presentation only, per the constitution's "the tool never judges": no
 * verdict, no quorum, no agreement counting, no recomputed severity (NC-1).
 * Ordering by
 * a seat's STATED severity is presentation; nothing here derives a new one.
 * Pure: no filesystem, no clock, no process.
 */
export function renderReport(input: RenderInput): string {
	const lines = [
		`# Review run ${input.meta.runId}`,
		"",
		`Base ref: ${inlineCode(input.meta.baseRef)}`,
		`Base OID: \`${input.meta.baseOid}\``,
		`HEAD OID: \`${input.meta.headOid}\``,
		"",
		...renderResumeSection(input.resume),
		...renderCleanupSection(input.cleanupError),
		...renderFindingsSection(input.stamped, input.grouping),
		...renderSeatsSection(input.outcomes),
		...renderGroupingSection(input.grouping, input.stamped.length),
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

function renderFindingsSection(
	stamped: StampedFinding[],
	grouping?: GroupingFacts,
): string[] {
	const lines = ["## Findings", ""];
	if (stamped.length === 0) {
		lines.push("No findings were submitted.", "");
		return lines;
	}

	const lost = groupingLostLine(grouping);
	if (lost !== undefined) {
		lines.push(`${lost}. The list below is not grouped.`, "");
	}
	const groups = groupedView(stamped, grouping);
	if (groups !== undefined) {
		lines.push(
			"Findings that describe the same defect share a group. Groups are ordered by",
			"the highest severity a seat stated in them (high, medium, low), then by",
			"their lowest finding id; severity is each seat's stated opinion, not a",
			"computed ranking. Every finding keeps its own id, seat, severity and evidence.",
			"",
		);
		for (const group of groups) {
			const [only] = group.members;
			if (group.members.length === 1 && only !== undefined) {
				lines.push(
					...renderFinding(only, `${group.id} / ${only.id}`, "###"),
					"",
				);
				continue;
			}
			lines.push(
				`### ${group.id} [${group.severity}, ${GROUP_SEVERITY_LABEL}] ${inertLine(group.lead.finding.title)}`,
				"",
			);
			for (const entry of group.members) {
				lines.push(...renderFinding(entry, entry.id, "####"), "");
			}
		}
		return lines;
	}
	lines.push(
		"Ordered by the severity the submitting seat stated (high, medium, low);",
		"severity is each seat's stated opinion, not a computed ranking.",
		"",
	);

	// Array.prototype.sort is stable: within one stated severity, findings
	// keep their collection (id) order.
	const ordered = [...stamped].sort(
		(a, b) =>
			SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity],
	);
	for (const entry of ordered) {
		lines.push(...renderFinding(entry), "");
	}
	return lines;
}

function renderFinding(
	entry: StampedFinding,
	label = entry.id,
	heading = "###",
): string[] {
	return [
		`${heading} ${label} [${entry.finding.severity}] ${inertLine(entry.finding.title)}`,
		"",
		`- Seat: ${seatLabel(entry.seat)}`,
		`- Location: ${inertLine(location(entry.finding))}`,
		`- Evidence: ${inertLine(entry.finding.evidence)}`,
	];
}

/** Outcomes come one per planned seat, in planned order. */
function renderSeatsSection(outcomes: SeatOutcomeFacts[]): string[] {
	const voted = outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	).length;
	const lines = [
		"## Seats",
		"",
		`${outcomes.length} planned seats: ${voted} voted, ${outcomes.length - voted} failed.`,
		...(outcomes.length === 0
			? []
			: [renderSeatsLine(outcomes.map((facts) => facts.seat))]),
		"",
	];
	for (const facts of outcomes) {
		lines.push(...renderSeat(facts), "");
	}
	return lines;
}

/** The grouping seat, when it ran: its identity, outcome and timing. */
function renderGroupingSection(
	grouping: GroupingFacts | undefined,
	findingCount: number,
): string[] {
	if (grouping === undefined) {
		return [];
	}
	const lines = [
		"## Grouping",
		"",
		`### ${seatLabel(grouping.seat)}`,
		"",
		`- Roster id: ${grouping.seat.rosterId}`,
	];
	if (grouping.outcome.kind === "grouped") {
		const count = grouping.outcome.groups.length;
		lines.push(
			`- Outcome: grouped ${findingCount} ${findingCount === 1 ? "finding" : "findings"} in ${count} ${count === 1 ? "group" : "groups"}`,
		);
	} else {
		lines.push(
			"- Outcome: lost",
			`- Failure class: ${grouping.outcome.class}`,
			`- Reason: ${inertLine(grouping.outcome.reason)}`,
		);
	}
	lines.push(
		"- SDK lifecycle:",
		`  - Duration: ${grouping.lifecycle.durationMs}ms`,
		`  - Attempts: ${grouping.lifecycle.attempts}`,
		`  - Aborted: ${grouping.lifecycle.aborted}`,
		`  - Tokens: ${grouping.lifecycle.tokens.total}`,
		`  - Cost: ${grouping.lifecycle.cost}`,
		"",
	);
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

/**
 * One line of record text as a Markdown code span that it cannot close
 * early: the fence is longer than any backtick run inside, and a control
 * character (a newline could start a heading) shows as U+FFFD.
 */
export function inlineCode(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the replacement is of control characters
	const line = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
	const longest = Math.max(
		0,
		...(line.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(longest + 1);
	const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
	return `${fence}${pad}${line}${pad}${fence}`;
}

function seatLabel(seat: SeatIdentity): string {
	return `${seat.provider}/${seat.model} (${seat.lens})`;
}
