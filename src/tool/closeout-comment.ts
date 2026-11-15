import type { PanelRecord, PlannedSeat, StampedFinding } from "../run/types.js";
import {
	fitCommentBody,
	markerTail,
	postedCode,
	postedLink,
	postedText,
} from "./posted-text.js";
import { orderFindings } from "./review-presentation.js";

const OID_DISPLAY_LENGTH = 7;
const SEVERITIES = ["high", "medium", "low"] as const;

export type CloseoutDismissed = {
	id: string;
	title: string;
	reason: string;
};

export type CloseoutLow = {
	id: string;
	title: string;
};

export type CloseoutSeat = Pick<PlannedSeat, "rosterId" | "lens">;

/** One verify of this review, as the card counts and names it. */
export type CloseoutVerifyRound = {
	runId: string;
	/** The `verify N` its comment posted as; absent when it never posted. */
	round?: number;
	seats: readonly CloseoutSeat[];
	/** The ids it marked resolved. */
	resolved: ReadonlySet<string>;
};

/**
 * Comment URLs on the PR, each already checked to be this PR's own comment
 * URL as gh gave it (see `roundCommentLinks`). A link is left out unless it
 * also has that shape here.
 */
export type CloseoutLinks = {
	review?: string;
	/** By verify run id. */
	verify?: ReadonlyMap<string, string>;
};

export type CloseoutCommentInput = {
	/** Every finding the review submitted, for the counts by severity. */
	findings: readonly StampedFinding[];
	/** The kept findings a verify marked resolved, each listed. */
	resolved: readonly StampedFinding[];
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
	/** The review's seats, shown grouped by lens like the reply's `Seats:` line. */
	seats: ReadonlyArray<CloseoutSeat>;
	lost: string[];
	/** Verify seats that were lost, listed after the review's on `Lost:`. */
	verifyLost?: string[];
	/** The verify rounds the card counts, in order. */
	rounds?: readonly CloseoutVerifyRound[];
	baseRef: string;
	baseOid: string;
	headOid: string;
	/** Defaults to `## Review panel`, the manual `comment` card's heading. */
	heading?: string;
	/** The run ids the card is for, carried in its hidden marker only. */
	runIds?: CloseoutRunIds;
	links?: CloseoutLinks;
};

export type CloseoutRunIds = { review: string; verify?: string };

export type CloseoutJudgmentRow = {
	id: string;
	reason: string;
};

export type AccountCloseoutInput = {
	findings: readonly StampedFinding[];
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
	/**
	 * Ids a verify kept, of any severity. They count as resolved, and are
	 * left out of the dismissed and low/advisory accounting.
	 */
	kept?: readonly string[];
};

export type AccountedCloseout = {
	submitted: number;
	/** Every finding neither dismissed nor left as low/advisory. */
	resolved: StampedFinding[];
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
};

export type AssembleCloseoutInput = AccountCloseoutInput & {
	panel: PanelRecord;
	lost: readonly string[];
	verifyLost?: readonly string[];
	meta: { baseRef: string; baseOid: string; headOid: string };
	rounds?: readonly CloseoutVerifyRound[];
	heading?: string;
	runIds?: CloseoutRunIds;
	links?: CloseoutLinks;
};

function shortOid(oid: string): string {
	return oid.slice(0, OID_DISPLAY_LENGTH);
}

/**
 * True when a ref names the commit by its own id, full or abbreviated: then
 * showing it beside the short id says nothing more. A ref that is all hex
 * but not a prefix of the commit, such as a branch named `deadbeef`, is a
 * name.
 */
function isCommitIdOf(ref: string, oid: string): boolean {
	return (
		/^[0-9a-f]{4,64}$/iu.test(ref) &&
		oid.toLowerCase().startsWith(ref.toLowerCase())
	);
}

/** True when a dismissed reason has no visible text. */
function isBlank(text: string): boolean {
	return text.replace(/[\s\u0085]+/gu, "") === "";
}

function requireReason(id: string, reason: string): string {
	if (isBlank(reason)) {
		throw new Error(`dismissed ${id} needs a reason`);
	}
	return reason;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** `(1 high, 2 medium)`: each severity with findings, high first. */
function severityCounts(findings: readonly StampedFinding[]): string {
	const counts = SEVERITIES.map(
		(severity) =>
			[
				severity,
				findings.filter((row) => row.finding.severity === severity).length,
			] as const,
	).filter(([, count]) => count > 0);
	return counts.length === 0
		? ""
		: ` (${counts.map(([severity, count]) => `${count} ${severity}`).join(", ")})`;
}

/** The counts line: only counts that are not zero. */
function countsLine(input: CloseoutCommentInput, rounds: number): string {
	const parts: string[] = [];
	const submitted = input.findings.length;
	parts.push(
		submitted === 0
			? "No findings submitted"
			: `**${plural(submitted, "finding")}**${severityCounts(input.findings)}`,
	);
	const verified = rounds === 0 ? "" : plural(rounds, "verify round");
	if (input.resolved.length > 0) {
		parts.push(
			`**${input.resolved.length} resolved**${verified === "" ? "" : ` in ${verified}`}`,
		);
	} else if (verified !== "") {
		parts.push(verified);
	}
	if (input.dismissed.length > 0) {
		parts.push(`${input.dismissed.length} dismissed`);
	}
	if (input.lowAdvisory.length > 0) {
		parts.push(`${input.lowAdvisory.length} left as low/advisory`);
	}
	return parts.join(" · ");
}

/** The range, then a link to the review and to each verify that has one. */
function rangeLine(input: CloseoutCommentInput): string {
	const base = isCommitIdOf(input.baseRef, input.baseOid)
		? postedCode(shortOid(input.baseOid))
		: `${postedCode(input.baseRef)} (${postedCode(shortOid(input.baseOid))})`;
	const parts = [`${base} → ${postedCode(shortOid(input.headOid))}`];
	const add = (label: string, url: string | undefined) => {
		const link = url === undefined ? undefined : postedLink(label, url);
		if (link !== undefined) {
			parts.push(link);
		}
	};
	add("review", input.links?.review);
	for (const round of input.rounds ?? []) {
		if (round.round !== undefined) {
			add(`verify ${round.round}`, input.links?.verify?.get(round.runId));
		}
	}
	return parts.join(" · ");
}

/**
 * `resolved in verify N`, N the lowest-numbered round that marked the id
 * resolved; plain `resolved` when only a round with no number did.
 */
function resolvedLabel(
	id: string,
	rounds: readonly CloseoutVerifyRound[],
): string {
	const numbers = rounds
		.filter((round) => round.round !== undefined && round.resolved.has(id))
		.map((round) => round.round as number);
	return numbers.length === 0
		? "resolved"
		: `resolved in verify ${Math.min(...numbers)}`;
}

/** One close-out card as its head lines and its list rows. */
export type CloseoutCardParts = {
	/** The heading, counts, seats, `Lost:` and the range with its links. */
	head: string[];
	/**
	 * One row per list item. A section heading goes with the first item
	 * under it, so a cut never leaves a heading without items.
	 */
	rows: string[][];
	/** A blank line and the hidden run marker, when there are run ids. */
	tail: string[];
};

/**
 * Presentation-only close-out card, as parts. Counts and lists, no merge
 * claim. Every field that came from a seat, a record or a ref goes through
 * the posted-text sanitizer here, once.
 */
export function closeoutCardParts(
	input: CloseoutCommentInput,
): CloseoutCardParts {
	for (const row of input.dismissed) {
		requireReason(row.id, row.reason);
	}
	const rounds = input.rounds ?? [];
	const lostNames = [
		...input.lost.map((name) => postedText(name)),
		...(input.verifyLost ?? []).map((name) => `${postedText(name)} (verify)`),
	];
	const verifiedBy = seatGroups(rounds.flatMap((round) => round.seats));
	const head = [
		input.heading ?? "## Review panel",
		"",
		countsLine(input, rounds.length),
		`**Review seats:** ${seatGroups(input.seats) ?? "none"}`,
		...(verifiedBy === undefined ? [] : [`**Verified by:** ${verifiedBy}`]),
		...(lostNames.length === 0 ? [] : [`**Lost:** ${lostNames.join(", ")}`]),
		rangeLine(input),
	];
	const rows: string[][] = [];
	const section = (title: string | undefined, items: string[]) => {
		for (const [index, item] of items.entries()) {
			rows.push(
				index !== 0
					? [item]
					: title === undefined
						? ["", item]
						: ["", title, item],
			);
		}
	};
	section(
		undefined,
		orderFindings(input.resolved).map(
			(row) =>
				`- **${postedText(row.id, 40)} [${postedText(row.finding.severity, 20)}]** ${postedText(row.finding.title)} · ${resolvedLabel(row.id, rounds)}`,
		),
	);
	section(
		"### Dismissed",
		input.dismissed.map(
			(row) =>
				`- **${postedText(row.id, 40)}** ${postedText(row.title)} — ${postedText(row.reason, 1_000)}`,
		),
	);
	section(
		"### Low / advisory (not kept)",
		input.lowAdvisory.map(
			(row) => `- **${postedText(row.id, 40)}** ${postedText(row.title)}`,
		),
	);
	return {
		head,
		rows,
		tail: input.runIds === undefined ? [] : markerTail(input.runIds),
	};
}

/**
 * The seats grouped by lens, each seat once, in the reply's `Seats:` format
 * (`holistic (sol, opus), tests (sol, opus)`), each name as posted text.
 * Undefined when there are none.
 */
function seatGroups(seats: ReadonlyArray<CloseoutSeat>): string | undefined {
	const byLens = new Map<string, string[]>();
	for (const seat of seats) {
		const ids = byLens.get(seat.lens) ?? [];
		if (!ids.includes(seat.rosterId)) {
			ids.push(seat.rosterId);
		}
		byLens.set(seat.lens, ids);
	}
	if (byLens.size === 0) {
		return undefined;
	}
	return [...byLens.entries()]
		.map(
			([lens, ids]) =>
				`${postedText(lens)} (${ids.map((id) => postedText(id)).join(", ")})`,
		)
		.join(", ");
}

/** Presentation-only close-out card. Counts and lists, no merge claim. */
export function renderCloseoutComment(input: CloseoutCommentInput): string {
	const { head, rows, tail } = closeoutCardParts(input);
	return fitCommentBody(head, rows, tail, "row");
}

/** Split a review record into dismissed, leftover lows, and the rest (resolved). */
export function accountCloseoutFindings(
	input: AccountCloseoutInput,
): AccountedCloseout {
	const byId = new Map(input.findings.map((row) => [row.id, row]));
	const kept = new Set(input.kept ?? []);
	const claimed = new Set<string>();

	const dismissed: CloseoutDismissed[] = [];
	for (const row of input.dismissed.filter((entry) => !kept.has(entry.id))) {
		const entry = byId.get(row.id);
		if (entry === undefined) {
			throw new Error(`dismissed ${row.id} is not in the review record`);
		}
		if (claimed.has(row.id)) {
			throw new Error(`${row.id} is listed more than once`);
		}
		claimed.add(row.id);
		dismissed.push({
			id: row.id,
			title: entry.finding.title,
			reason: requireReason(row.id, row.reason),
		});
	}

	const lowAdvisory: CloseoutLow[] = [];
	for (const id of input.lowAdvisory.filter((entry) => !kept.has(entry))) {
		const entry = byId.get(id);
		if (entry === undefined) {
			throw new Error(`low/advisory ${id} is not in the review record`);
		}
		if (claimed.has(id)) {
			throw new Error(`${id} is listed more than once`);
		}
		if (entry.finding.severity !== "low") {
			throw new Error(
				`${id} is ${entry.finding.severity}; high/medium findings that are not kept must be dismissed with a reason, not listed as low/advisory`,
			);
		}
		claimed.add(id);
		lowAdvisory.push({ id, title: entry.finding.title });
	}

	const resolved: StampedFinding[] = [];
	for (const entry of input.findings) {
		if (claimed.has(entry.id)) {
			continue;
		}
		if (kept.has(entry.id) || entry.finding.severity !== "low") {
			resolved.push(entry);
			continue;
		}
		throw new Error(
			`${entry.id} is low/advisory and was not listed; pass it in lowAdvisory or dismiss it with a reason`,
		);
	}

	return {
		submitted: input.findings.length,
		resolved,
		dismissed,
		lowAdvisory,
	};
}

/** The close-out card's parts, from a review record plus orchestrator judgment. */
export function assembleCloseoutParts(
	input: AssembleCloseoutInput,
): CloseoutCardParts {
	const accounted = accountCloseoutFindings(input);
	return closeoutCardParts({
		findings: input.findings,
		resolved: accounted.resolved,
		dismissed: accounted.dismissed,
		lowAdvisory: accounted.lowAdvisory,
		seats: input.panel.seats,
		lost: [...input.lost],
		...(input.verifyLost === undefined
			? {}
			: { verifyLost: [...input.verifyLost] }),
		...(input.rounds === undefined ? {} : { rounds: input.rounds }),
		baseRef: input.meta.baseRef,
		baseOid: input.meta.baseOid,
		headOid: input.meta.headOid,
		...(input.heading === undefined ? {} : { heading: input.heading }),
		...(input.runIds === undefined ? {} : { runIds: input.runIds }),
		...(input.links === undefined ? {} : { links: input.links }),
	});
}

/**
 * Derive the close-out card from a review record plus orchestrator judgment,
 * cut by whole rows to stay under GitHub's comment limit.
 */
export function assembleCloseoutComment(input: AssembleCloseoutInput): string {
	const { head, rows, tail } = assembleCloseoutParts(input);
	return fitCommentBody(head, rows, tail, "row");
}
