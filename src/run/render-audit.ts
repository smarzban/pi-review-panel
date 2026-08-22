import type { Finding } from "../seat/schema.js";
import type { SeatOutcomeFacts, StampedFinding } from "./types.js";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

export function renderAuditFindingsJson(stamped: StampedFinding[]): string {
	return `${JSON.stringify(stamped, null, 2)}\n`;
}

/** Presentation only: one whole-tree snapshot, submitted findings, and coverage. */
export function renderAuditReport(input: {
	runId: string;
	snapshotOid: string;
	stamped: StampedFinding[];
	outcomes: SeatOutcomeFacts[];
	cleanupError?: string;
}): string {
	const lines = [
		`# Repository audit ${input.runId}`,
		"",
		`Snapshot OID: \`${input.snapshotOid}\``,
		"",
		...(input.cleanupError === undefined
			? []
			: [
					"## Snapshot cleanup failure",
					"",
					"The seat outcomes are unchanged. Snapshot release failed:",
					"",
					input.cleanupError,
					"",
				]),
		"## Findings",
		"",
		...renderFindings(input.stamped),
		"## Seats",
		"",
		...renderSeats(input.outcomes),
		"Not a merge decision.",
		"",
	];
	return lines.join("\n");
}

function renderFindings(stamped: StampedFinding[]): string[] {
	if (stamped.length === 0) {
		return ["No findings were submitted.", ""];
	}
	const lines = [
		"Ordered by the severity the submitting seat stated (high, medium, low);",
		"severity is each seat's stated opinion, not a computed ranking.",
		"",
	];
	const ordered = [...stamped].sort(
		(left, right) =>
			SEVERITY_RANK[left.finding.severity] -
			SEVERITY_RANK[right.finding.severity],
	);
	for (const entry of ordered) {
		const location =
			entry.finding.endLine === undefined
				? `${entry.finding.file}:${entry.finding.line}`
				: `${entry.finding.file}:${entry.finding.line}-${entry.finding.endLine}`;
		lines.push(
			`### ${entry.id} [${entry.finding.severity}] ${entry.finding.title}`,
			"",
			`- Seat: ${entry.seat.provider}/${entry.seat.model} (${entry.seat.lens})`,
			`- Location: ${location}`,
			`- Evidence: ${entry.finding.evidence}`,
			"",
		);
	}
	return lines;
}

function renderSeats(outcomes: SeatOutcomeFacts[]): string[] {
	const voted = outcomes.filter((outcome) => outcome.outcome.kind === "voted");
	const lines = [
		`${outcomes.length} planned seats: ${voted.length} voted, ${outcomes.length - voted.length} failed.`,
		"",
	];
	for (const facts of outcomes) {
		lines.push(
			`### ${facts.seat.provider}/${facts.seat.model} (${facts.seat.lens})`,
			"",
		);
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
		lines.push("");
	}
	return lines;
}
