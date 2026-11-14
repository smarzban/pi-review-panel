import type { ReadinessReport } from "../config/readiness.js";
import {
	GROUP_SEVERITY_LABEL,
	type GroupView,
	groupedView,
	groupingLostLine,
} from "../run/grouping.js";
import { inert, inertLine } from "../run/inert-text.js";
import { inlineCode, renderSeatsLine } from "../run/render.js";
import type { RunReviewResult } from "../run/run-review.js";
import type {
	RunVerifyResult,
	VerifyProgressEvent,
} from "../run/run-verify.js";
import type { ReviewProgressEvent } from "../run/scheduler.js";
import type { Suggestion, SuggestionsUnavailable } from "../run/suggest.js";
import type { PlannedSeat, StampedFinding } from "../run/types.js";

/** The public boundary never sends more than this many UTF-8 bytes. */
export const MAX_PRESENTATION_BYTES = 16 * 1024;

/** `reserveBytes` keeps room for lines the caller appends after the report. */
function fitPresentation(lines: string[], reserveBytes = 0): string {
	const encoder = new TextEncoder();
	const limit = MAX_PRESENTATION_BYTES - reserveBytes;
	const joined = lines.join("\n");
	if (encoder.encode(joined).length <= limit) {
		return joined;
	}
	const recordIndex = lines.findIndex((line) => line.startsWith("Record:"));
	const keepThrough = recordIndex >= 0 ? recordIndex + 1 : 1;
	const head = lines.slice(0, keepThrough);
	const rest = lines.slice(keepThrough);
	while (rest.length > 0) {
		rest.pop();
		const omitted = "- additional row(s) omitted.";
		const candidate = [...head, ...rest, omitted].join("\n");
		if (encoder.encode(candidate).length <= limit) {
			return candidate;
		}
	}
	return [...head, "- additional row(s) omitted."].join("\n");
}

/** Cuts by whole code points, so a multibyte character is never split. */
export function truncateCodePoints(text: string, maxChars: number): string {
	const points = Array.from(text);
	return points.length <= maxChars
		? text
		: `${points.slice(0, maxChars).join("")}…`;
}

function truncateUtf8(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}

export type ReviewProgressView = {
	phase: "diagnose" | "review" | "verify" | "audit";
	event: string;
	elapsedMs: number;
	seat?: string;
	active?: number;
	completed?: number;
	total?: number;
	cost?: number;
	roster?: string;
	attempts?: 1 | 2;
	tokens?: number;
	lastTool?: string;
};

/** Groups planned seats as `lens: alias, alias` so the TUI can announce the panel. */
export function compactPanelRoster(seats: readonly PlannedSeat[]): string {
	const byLens = new Map<string, string[]>();
	for (const seat of seats) {
		const aliases = byLens.get(seat.lens) ?? [];
		aliases.push(seat.rosterId);
		byLens.set(seat.lens, aliases);
	}
	return [...byLens.entries()]
		.map(([lens, aliases]) => `${lens}: ${aliases.join(", ")}`)
		.join(" · ");
}

/** One-line in-flight status for the host TUI. No judgment, no full report. */
export function renderReviewProgress(view: ReviewProgressView): string {
	const elapsed =
		view.elapsedMs < 1000
			? `${Math.round(view.elapsedMs)}ms`
			: `${(view.elapsedMs / 1000).toFixed(0)}s`;
	const parts = [`${view.phase} ${view.event}`, elapsed];
	if (view.seat !== undefined) {
		parts.push(view.seat);
	}
	if (
		view.event === "started" &&
		view.seat === undefined &&
		view.total !== undefined
	) {
		parts.push(`${view.total} seat${view.total === 1 ? "" : "s"}`);
	} else if (
		view.active !== undefined &&
		view.completed !== undefined &&
		view.total !== undefined
	) {
		parts.push(`${view.active} active, ${view.completed}/${view.total} done`);
	}
	if (view.attempts !== undefined) {
		parts.push(`attempt ${view.attempts}`);
	}
	if (view.tokens !== undefined) {
		parts.push(formatTokenCount(view.tokens));
	}
	if (view.lastTool !== undefined) {
		parts.push(view.lastTool);
	}
	if (view.cost !== undefined) {
		parts.push(view.cost === 0 ? "$0" : `$${view.cost.toFixed(4)}`);
	}
	const status = parts.join(" · ");
	// Host onUpdate replaces the card. Keep the roster on every tick so it
	// is not wiped by the first heartbeat.
	if (view.roster !== undefined) {
		return `${view.roster}\n${status}`;
	}
	return status;
}

export function progressFromReviewEvent(
	event: ReviewProgressEvent,
	elapsedMs: number,
): ReviewProgressView {
	return {
		phase: "review",
		event: event.kind.replace("seat-", ""),
		elapsedMs,
		seat: `${event.seat.rosterId}/${event.seat.lens}`,
		active: event.activeSeats,
		completed: event.completedSeats,
		total: event.totalSeats,
		...(event.cost === undefined ? {} : { cost: event.cost }),
		...(event.attempts === undefined ? {} : { attempts: event.attempts }),
		...(event.tokens === undefined ? {} : { tokens: event.tokens }),
		...(event.lastTool === undefined ? {} : { lastTool: event.lastTool }),
	};
}

export function progressFromAuditEvent(
	event: ReviewProgressEvent,
	elapsedMs: number,
): ReviewProgressView {
	return {
		...progressFromReviewEvent(event, elapsedMs),
		phase: "audit",
	};
}

export function progressFromVerifyEvent(
	event: VerifyProgressEvent,
	elapsedMs: number,
): ReviewProgressView {
	return {
		phase: "verify",
		event: event.kind.replace("seat-", ""),
		elapsedMs,
		seat: `${event.seat.rosterId}/${event.seat.lens}`,
		active: event.kind === "seat-finished" ? 0 : 1,
		completed: event.completedSeats,
		total: event.totalSeats,
		...(event.cost === undefined ? {} : { cost: event.cost }),
		...(event.attempts === undefined ? {} : { attempts: event.attempts }),
		...(event.tokens === undefined ? {} : { tokens: event.tokens }),
		...(event.lastTool === undefined ? {} : { lastTool: event.lastTool }),
	};
}

/**
 * `reserveBytes` keeps room for text the caller appends after the report (the
 * diagnose warning section), so the whole reply stays within the public cap.
 */
export function renderReadiness(
	report: ReadinessReport,
	reserveBytes = 0,
): string {
	const header = [
		"# Review panel readiness",
		`- Status: ${report.ready ? "ready" : "needs setup"}`,
	];
	const rows: string[] = [];
	for (const row of report.rows) {
		const candidate = `- ${truncateUtf8(row.prerequisite, 500)}: ${truncateUtf8(row.remediation, 1_000)}`;
		const accepted = [...rows, candidate];
		const omitted = report.rows.length - accepted.length;
		const text = [
			...header,
			"## Required remediation",
			...accepted,
			...(omitted === 0
				? []
				: [`- ${omitted} additional remediation row(s) omitted.`]),
		].join("\n");
		if (
			new TextEncoder().encode(text).length >
			MAX_PRESENTATION_BYTES - reserveBytes
		) {
			break;
		}
		rows.push(candidate);
	}
	return [
		...header,
		...(rows.length === 0
			? [
					report.ready
						? "- All configured prerequisites are available."
						: "- No remediation row fit within the public output cap.",
				]
			: ["## Required remediation", ...rows]),
		...(report.rows.length > rows.length
			? [
					`- ${report.rows.length - rows.length} additional remediation row(s) omitted.`,
				]
			: []),
	].join("\n");
}

export { inert, inertLine };

/** The one line that says no rule ran because the diff could not be read. */
export function formatSuggestionsUnavailable(
	failure: SuggestionsUnavailable,
): string {
	return `- Suggestions unavailable: the diff could not be read (${inert(
		truncateCodePoints(failure.unavailable, 200),
	)}).`;
}

/**
 * One suggested lens on one line: ``- lens: reason (`file:line`, +N more)``.
 * `evidence` is how many pieces to show (default one); the rest are counted.
 * `note` marks the lens, as in `- tests (already on, owner default): …`.
 * A file name comes from the repository, so it is cut to 200 code points,
 * made inert and shown as one code span that it cannot close.
 */
export function formatSuggestion(
	row: Suggestion,
	options: { evidence?: number; note?: string } = {},
): string {
	const shown = row.evidence.slice(0, options.evidence ?? 1).map((piece) => {
		const file = truncateCodePoints(piece.file, 200);
		return inlineCode(
			inert(piece.line === undefined ? file : `${file}:${piece.line}`),
		);
	});
	const rest = row.evidence.length - shown.length;
	const where = [...shown, ...(rest > 0 ? [`+${rest} more`] : [])];
	const lens = inert(row.lens);
	const label = options.note === undefined ? lens : `${lens} (${options.note})`;
	return `- ${label}: ${inert(row.reason)}${where.length === 0 ? "" : ` (${where.join(", ")})`}`;
}

/**
 * The `suggest` reply: a heading, the rows, and a closing line, cut to
 * {@link MAX_PRESENTATION_BYTES} by dropping whole rows from the end and
 * counting them, so the heading and the closing line always survive.
 */
export function renderSuggestResult(input: {
	head: string[];
	rows: string[];
	tail: string[];
}): string {
	const encoder = new TextEncoder();
	for (let kept = input.rows.length; kept >= 0; kept -= 1) {
		const omitted = input.rows.length - kept;
		const text = [
			...input.head,
			...input.rows.slice(0, kept),
			...(omitted === 0 ? [] : [`- ${omitted} more suggestion(s) omitted.`]),
			...input.tail,
		].join("\n");
		if (encoder.encode(text).length <= MAX_PRESENTATION_BYTES) {
			return text;
		}
	}
	return [...input.head, ...input.tail].join("\n");
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const EVIDENCE_CHARS = 280;

function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) {
		return "n/a tok";
	}
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M tok`;
	}
	if (tokens >= 10_000) {
		return `${Math.round(tokens / 1_000)}k tok`;
	}
	return `${Math.round(tokens)} tok`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "n/a";
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const totalSeconds = Math.round(ms / 1000);
	return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost === 0) {
		return "$0";
	}
	return `$${cost.toFixed(4)}`;
}

function rollupLifecycle(
	outcomes: ReadonlyArray<
		Pick<RunReviewResult["outcomes"][number], "lifecycle">
	>,
):
	| {
			durationMs: number;
			cost: number;
			tokens: number;
	  }
	| undefined {
	if (
		outcomes.length === 0 ||
		outcomes.some((facts) => facts.lifecycle === undefined)
	) {
		return undefined;
	}
	const started = Math.min(
		...outcomes.map((facts) => facts.lifecycle.startedAtMs),
	);
	const settled = Math.max(
		...outcomes.map((facts) => facts.lifecycle.settledAtMs),
	);
	return {
		durationMs: settled - started,
		cost: outcomes.reduce((sum, facts) => sum + facts.lifecycle.cost, 0),
		tokens: outcomes.reduce(
			(sum, facts) => sum + facts.lifecycle.tokens.total,
			0,
		),
	};
}

export function findingAttribution(
	entry: StampedFinding,
	panel: PlannedSeat[],
): string {
	const match = panel.find(
		(seat) =>
			seat.provider === entry.seat.provider &&
			seat.model === entry.seat.model &&
			seat.lens === entry.seat.lens,
	);
	if (match !== undefined) {
		return `${match.rosterId}/${match.lens}`;
	}
	return `${entry.seat.provider}/${entry.seat.model}/${entry.seat.lens}`;
}

export function renderReviewResult(input: {
	recordPath: string;
	panel: PlannedSeat[];
	result: RunReviewResult;
	suggestions?: Suggestion[] | SuggestionsUnavailable;
	scopingNote?: string;
	findings?: StampedFinding[];
	/** Room kept for lines the caller appends after the report. */
	reserveBytes?: number;
}): string {
	const failed = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "failed",
	);
	const findings = input.findings ?? [];
	const lines = reviewHeadLines("# Review panel", input);
	if (failed.length > 0) {
		lines.push(reviewLostLine(input.result));
	}
	const groupingLost = groupingLostLine(input.result.grouping);
	if (groupingLost !== undefined) {
		lines.push(groupingLost);
	}
	lines.push(`Record: \`${input.recordPath}\``, "");
	const groups = groupedView(findings, input.result.grouping);
	if (findings.length === 0) {
		lines.push("None submitted.");
	} else if (groups !== undefined) {
		for (const group of groups) {
			lines.push(...groupReplyRows(group, input.panel));
		}
	} else {
		for (const entry of orderFindings(findings)) {
			lines.push(...findingReplyRows(entry, input.panel));
		}
	}
	// A lens that ran shows in the seats line; only untaken ones are suggested.
	const ran = new Set(input.panel.map((seat) => seat.lens));
	const offered = input.suggestions ?? [];
	const suggestions = Array.isArray(offered)
		? offered.filter((row) => !ran.has(row.lens))
		: [];
	if (!Array.isArray(offered)) {
		lines.push("", "Suggest:", formatSuggestionsUnavailable(offered));
	} else if (suggestions.length > 0) {
		lines.push(
			"",
			"Suggest:",
			...suggestions.map((row) => formatSuggestion(row)),
		);
	}
	if (input.result.cleanupError !== undefined) {
		lines.push("", input.result.cleanupError);
	}
	return fitPresentation(lines, input.reserveBytes);
}

function evidenceText(entry: StampedFinding): string {
	return truncateCodePoints(
		inertLine(entry.finding.evidence.trim()),
		EVIDENCE_CHARS,
	);
}

/** One flat finding: its row, then its evidence. `label` replaces the id. */
function findingReplyRows(
	entry: StampedFinding,
	panel: PlannedSeat[],
	label = entry.id,
): string[] {
	const rows = [
		`- ${label} [${entry.finding.severity}] ${inertLine(entry.finding.title)} (${inertLine(entry.finding.file)}:${entry.finding.line}) — ${findingAttribution(entry, panel)}`,
	];
	const evidence = evidenceText(entry);
	if (evidence.length > 0) {
		rows.push(`  ${evidence}`);
	}
	return rows;
}

/**
 * One group: a group of one is its finding's row with both ids; a larger
 * group is a header (id, the highest severity a seat stated, the lowest
 * member's title), then each member's own id, severity, seat, place and
 * evidence. The member count is never shown.
 */
function groupReplyRows(group: GroupView, panel: PlannedSeat[]): string[] {
	const [only] = group.members;
	if (group.members.length === 1 && only !== undefined) {
		return findingReplyRows(only, panel, `${group.id} / ${only.id}`);
	}
	const rows = [
		`- ${group.id} [${group.severity}, ${GROUP_SEVERITY_LABEL}] ${inertLine(group.lead.finding.title)}`,
	];
	for (const entry of group.members) {
		rows.push(
			`  - ${entry.id} [${entry.finding.severity}] ${findingAttribution(entry, panel)} (${inertLine(entry.finding.file)}:${entry.finding.line})`,
		);
		const evidence = evidenceText(entry);
		if (evidence.length > 0) {
			rows.push(`    ${evidence}`);
		}
	}
	return rows;
}

/** Findings by severity, then id, as the review reply lists them. */
export function orderFindings(
	findings: readonly StampedFinding[],
): StampedFinding[] {
	return [...findings].sort((left, right) => {
		const rank =
			SEVERITY_RANK[left.finding.severity] -
			SEVERITY_RANK[right.finding.severity];
		return rank !== 0 ? rank : left.id.localeCompare(right.id);
	});
}

/** The heading, the summary line and the Seats line of a review report. */
export function reviewHeadLines(
	heading: string,
	input: {
		panel: PlannedSeat[];
		result: RunReviewResult;
		findings?: StampedFinding[];
	},
): string[] {
	const voted = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	);
	const findingCount = voted.reduce((count, facts) => {
		return facts.outcome.kind === "voted"
			? count + facts.outcome.findings.length
			: count;
	}, 0);
	const findings = input.findings ?? [];
	const shownCount = findings.length > 0 ? findings.length : findingCount;
	const groups = groupedView(findings, input.result.grouping);
	const summary = [
		`${voted.length}/${input.result.outcomes.length} voted`,
		`${shownCount} finding${shownCount === 1 ? "" : "s"}${
			groups === undefined
				? ""
				: ` in ${groups.length} group${groups.length === 1 ? "" : "s"}`
		}`,
	];
	// The grouping seat's time and cost count too; it is never a vote.
	const totals = rollupLifecycle([
		...input.result.outcomes,
		...(input.result.grouping === undefined ? [] : [input.result.grouping]),
	]);
	if (totals !== undefined) {
		summary.push(formatDuration(totals.durationMs), formatCost(totals.cost));
	}
	const grouping = input.result.grouping;
	return [
		heading,
		summary.join(" · "),
		renderSeatsLine(
			grouping === undefined ? input.panel : [...input.panel, grouping.seat],
		),
	];
}

/** `Lost: seat/lens (class), …` for the seats that failed. */
export function reviewLostLine(result: RunReviewResult): string {
	const lost = result.outcomes
		.filter((facts) => facts.outcome.kind === "failed")
		.map((facts) => {
			const klass =
				facts.outcome.kind === "failed" ? facts.outcome.class : "failed";
			return `${facts.seat.rosterId}/${facts.seat.lens} (${klass})`;
		});
	return `Lost: ${lost.join(", ")}`;
}

export function renderAuditResult(input: {
	recordPath: string;
	panel: PlannedSeat[];
	result: RunReviewResult;
}): string {
	const voted = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	);
	const failed = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "failed",
	);
	const findings = voted.flatMap((facts) =>
		facts.outcome.kind === "voted" ? facts.outcome.findings : [],
	);
	const areas = [
		...new Set(
			findings.map((finding) => inertLine(finding.file.split("/")[0] ?? ".")),
		),
	].sort();
	const lines = [
		"# Repository audit",
		`${voted.length}/${input.result.outcomes.length} voted · ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
		renderSeatsLine(input.panel),
		...(areas.length === 0 ? [] : [`Areas: ${areas.join(", ")}`]),
	];
	if (failed.length > 0) {
		lines.push(
			`Lost: ${failed
				.map((facts) => {
					const failure =
						facts.outcome.kind === "failed" ? facts.outcome.class : "failed";
					return `${facts.seat.rosterId}/${facts.seat.lens} (${failure})`;
				})
				.join(", ")}`,
		);
	}
	lines.push(`Record: \`${input.recordPath}\``, "");
	for (const finding of findings) {
		lines.push(
			`- [${finding.severity}] ${inertLine(finding.title)} (${inertLine(finding.file)}:${finding.line})`,
		);
	}
	if (findings.length === 0) {
		lines.push("None submitted.");
	}
	if (input.result.cleanupError !== undefined) {
		lines.push("", input.result.cleanupError);
	}
	return fitPresentation(lines);
}

/** `panel` is the planned verify seats; it defaults to the outcomes' seats. */
export type VerifyRegression = {
	id: string;
	title: string;
	file: string;
	line: number;
	evidence: string;
};

export type VerifyFacts = {
	/** Each id's dispositions across the seats that voted. */
	dispositions: Map<string, Set<string>>;
	/** The first resolved evidence each id got, as `file: explanation`. */
	evidence: Map<string, { file: string; explanation: string }>;
	regressions: VerifyRegression[];
	keptIds: string[];
	voted: number;
};

/** What the verify seats said, gathered across every seat that voted. */
export function verifyFacts(result: RunVerifyResult): VerifyFacts {
	const dispositions = new Map<string, Set<string>>();
	const evidence = new Map<string, { file: string; explanation: string }>();
	const regressions: VerifyRegression[] = [];
	let voted = 0;
	for (const facts of result.outcomes) {
		if (facts.outcome.kind !== "voted") {
			continue;
		}
		voted += 1;
		for (const item of facts.outcome.result.items) {
			const seen = dispositions.get(item.id) ?? new Set<string>();
			seen.add(item.disposition);
			dispositions.set(item.id, seen);
			if (item.evidence !== undefined && !evidence.has(item.id)) {
				evidence.set(item.id, item.evidence);
			}
		}
		for (const regression of facts.outcome.result.regressions) {
			regressions.push({
				id: regression.regressionId,
				title: regression.title,
				file: regression.file,
				line: regression.line,
				evidence: regression.evidence,
			});
		}
	}
	const keptIds =
		result.kept.length > 0
			? result.kept.map((row) => row.id)
			: [...dispositions.keys()];
	return { dispositions, evidence, regressions, keptIds, voted };
}

/** `F-1 resolved`, `F-2 resolved/still present`, or the bare id when no seat answered. */
export function dispositionLabel(facts: VerifyFacts, id: string): string {
	const states = [...(facts.dispositions.get(id) ?? [])];
	return states.length === 0 ? id : `${id} ${states.join("/")}`;
}

export function renderVerifyResult(
	result: RunVerifyResult,
	panel: readonly PlannedSeat[] = result.outcomes.map((facts) => facts.seat),
	reserveBytes = 0,
): string {
	const voted = result.outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	);
	const failed = result.outcomes.filter(
		(facts) => facts.outcome.kind === "failed",
	);
	const facts = verifyFacts(result);
	const { regressions, keptIds } = facts;
	const keptSummary = keptIds.map((id) => dispositionLabel(facts, id));
	const summary = [
		`${voted.length}/${result.outcomes.length} voted`,
		...(keptSummary.length > 0 ? [keptSummary.join(", ")] : ["no kept ids"]),
		regressions.length === 0
			? "no regressions"
			: `${regressions.length} regression${regressions.length === 1 ? "" : "s"}`,
	];
	const lines = [
		"# Review panel verify",
		summary.join(" · "),
		...(panel.length === 0 ? [] : [renderSeatsLine(panel)]),
	];
	if (failed.length > 0) {
		lines.push(
			`Lost: ${failed.map((facts) => `${facts.seat.rosterId}/${facts.seat.lens}`).join(", ")}`,
		);
	}
	lines.push(`Record: \`${result.recordPath}\``);
	if (regressions.length > 0) {
		lines.push("");
		for (const regression of regressions) {
			lines.push(
				`- regression ${inertLine(regression.id)}: ${inertLine(regression.title)} (${inertLine(regression.file)}:${regression.line})`,
			);
			const evidence = inertLine(regression.evidence.trim());
			if (evidence.length > 0) {
				lines.push(`  ${truncateCodePoints(evidence, EVIDENCE_CHARS)}`);
			}
		}
	}
	if (result.cleanupError !== undefined) {
		lines.push("", result.cleanupError);
	}
	return fitPresentation(lines, reserveBytes);
}
