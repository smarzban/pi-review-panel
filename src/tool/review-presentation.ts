import type { ReadinessReport } from "../config/readiness.js";
import type { RunReviewResult } from "../run/run-review.js";
import type {
	RunVerifyResult,
	VerifyProgressEvent,
} from "../run/run-verify.js";
import type { ReviewProgressEvent } from "../run/scheduler.js";
import type { Suggestion } from "../run/suggest.js";
import type { PlannedSeat, StampedFinding } from "../run/types.js";

/** The public boundary never sends more than this many UTF-8 bytes. */
export const MAX_PRESENTATION_BYTES = 16 * 1024;

function fitPresentation(lines: string[]): string {
	const encoder = new TextEncoder();
	const joined = lines.join("\n");
	if (encoder.encode(joined).length <= MAX_PRESENTATION_BYTES) {
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
		if (encoder.encode(candidate).length <= MAX_PRESENTATION_BYTES) {
			return candidate;
		}
	}
	return [...head, "- additional row(s) omitted."].join("\n");
}

function truncateUtf8(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}

export type ReviewProgressView = {
	phase: "diagnose" | "review" | "verify";
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

export function renderReadiness(report: ReadinessReport): string {
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
		if (new TextEncoder().encode(text).length > MAX_PRESENTATION_BYTES) {
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

function rollupLifecycle(outcomes: RunReviewResult["outcomes"]):
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

function findingAttribution(
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
	suggestions?: Suggestion[];
	scopingNote?: string;
	findings?: StampedFinding[];
}): string {
	const voted = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	);
	const failed = input.result.outcomes.filter(
		(facts) => facts.outcome.kind === "failed",
	);
	const findingCount = voted.reduce((count, facts) => {
		return facts.outcome.kind === "voted"
			? count + facts.outcome.findings.length
			: count;
	}, 0);
	const findings = input.findings ?? [];
	const shownCount = findings.length > 0 ? findings.length : findingCount;
	const summary = [
		`${voted.length}/${input.result.outcomes.length} voted`,
		`${shownCount} finding${shownCount === 1 ? "" : "s"}`,
	];
	const totals = rollupLifecycle(input.result.outcomes);
	if (totals !== undefined) {
		summary.push(formatDuration(totals.durationMs), formatCost(totals.cost));
	}
	const lines = ["# Review panel", summary.join(" · ")];
	if (failed.length > 0) {
		const lost = failed.map((facts) => {
			const klass =
				facts.outcome.kind === "failed" ? facts.outcome.class : "failed";
			return `${facts.seat.rosterId}/${facts.seat.lens} (${klass})`;
		});
		lines.push(`Lost: ${lost.join(", ")}`);
	}
	lines.push(`Record: \`${input.recordPath}\``, "");
	if (findings.length === 0) {
		lines.push("None submitted.");
	} else {
		const ordered = [...findings].sort((left, right) => {
			const rank =
				SEVERITY_RANK[left.finding.severity] -
				SEVERITY_RANK[right.finding.severity];
			return rank !== 0 ? rank : left.id.localeCompare(right.id);
		});
		for (const entry of ordered) {
			lines.push(
				`- ${entry.id} [${entry.finding.severity}] ${entry.finding.title} (${entry.finding.file}:${entry.finding.line}) — ${findingAttribution(entry, input.panel)}`,
			);
			const evidence = entry.finding.evidence.trim();
			if (evidence.length > 0) {
				lines.push(`  ${truncateUtf8(evidence, EVIDENCE_CHARS)}`);
			}
		}
	}
	const suggestions = input.suggestions ?? [];
	if (suggestions.length > 0) {
		lines.push("", `Suggest: ${suggestions.map((row) => row.lens).join(", ")}`);
	}
	if (input.result.cleanupError !== undefined) {
		lines.push("", input.result.cleanupError);
	}
	lines.push("", "Not a merge decision.");
	return fitPresentation(lines);
}

export function renderVerifyResult(result: RunVerifyResult): string {
	const voted = result.outcomes.filter(
		(facts) => facts.outcome.kind === "voted",
	);
	const failed = result.outcomes.filter(
		(facts) => facts.outcome.kind === "failed",
	);
	const dispositions = new Map<string, Set<string>>();
	const regressions: Array<{
		id: string;
		title: string;
		file: string;
		line: number;
		evidence: string;
	}> = [];
	for (const facts of voted) {
		if (facts.outcome.kind !== "voted") {
			continue;
		}
		for (const item of facts.outcome.result.items) {
			const seen = dispositions.get(item.id) ?? new Set<string>();
			seen.add(item.disposition);
			dispositions.set(item.id, seen);
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
	const keptSummary = keptIds.map((id) => {
		const states = [...(dispositions.get(id) ?? [])];
		if (states.length === 1) {
			return `${id} ${states[0]}`;
		}
		if (states.length === 0) {
			return id;
		}
		return `${id} ${states.join("/")}`;
	});
	const summary = [
		`${voted.length}/${result.outcomes.length} voted`,
		...(keptSummary.length > 0 ? [keptSummary.join(", ")] : ["no kept ids"]),
		regressions.length === 0
			? "no regressions"
			: `${regressions.length} regression${regressions.length === 1 ? "" : "s"}`,
	];
	const lines = ["# Review panel verify", summary.join(" · ")];
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
				`- regression ${regression.id}: ${regression.title} (${regression.file}:${regression.line})`,
			);
			const evidence = regression.evidence.trim();
			if (evidence.length > 0) {
				lines.push(`  ${truncateUtf8(evidence, EVIDENCE_CHARS)}`);
			}
		}
	}
	if (result.cleanupError !== undefined) {
		lines.push("", result.cleanupError);
	}
	lines.push("", "Not a merge decision.");
	return fitPresentation(lines);
}
