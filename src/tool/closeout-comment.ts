import type { PanelRecord, StampedFinding } from "../run/types.js";
import { fitCommentBody, postedCode, postedText } from "./posted-text.js";

const OID_DISPLAY_LENGTH = 7;

export type CloseoutDismissed = {
	id: string;
	title: string;
	reason: string;
};

export type CloseoutLow = {
	id: string;
	title: string;
};

export type CloseoutCommentInput = {
	submitted: number;
	fixed: number;
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
	seats: string[];
	extras: string[];
	lost: string[];
	/** Verify seats that were lost, listed after the review's on `Lost:`. */
	verifyLost?: string[];
	baseRef: string;
	baseOid: string;
	headRef?: string;
	headOid: string;
	/** Defaults to `## Review panel`, the manual `comment` card's heading. */
	heading?: string;
	/** One line under the heading, such as the run ids an automatic card is for. */
	runLine?: string;
};

export type CloseoutJudgmentRow = {
	id: string;
	reason: string;
};

export type AccountCloseoutInput = {
	findings: readonly StampedFinding[];
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
	/**
	 * Ids a verify kept, of any severity. They count as fixed, and are left
	 * out of the dismissed and low/advisory accounting.
	 */
	kept?: readonly string[];
};

export type AccountedCloseout = {
	submitted: number;
	fixed: StampedFinding[];
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
};

export type AssembleCloseoutInput = AccountCloseoutInput & {
	panel: PanelRecord;
	lost: readonly string[];
	verifyLost?: readonly string[];
	meta: { baseRef: string; baseOid: string; headOid: string };
	headRef?: string;
	heading?: string;
	runLine?: string;
};

function shortOid(oid: string): string {
	return oid.slice(0, OID_DISPLAY_LENGTH);
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

/** One close-out card as its head lines and its list rows. */
export type CloseoutCardParts = {
	/** The heading, run line, counts, `Seats:`, `Lost:` and the range. */
	head: string[];
	/**
	 * One row per list item. A section heading goes with the first item
	 * under it, so a cut never leaves a heading without items.
	 */
	rows: string[][];
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

	const findingWord = input.submitted === 1 ? "finding" : "findings";
	const extras =
		input.extras.length === 0
			? ""
			: ` · extras: ${input.extras.map((name) => postedText(name)).join(", ")}`;
	const lostNames = [
		...input.lost.map((name) => postedText(name)),
		...(input.verifyLost ?? []).map((name) => `${postedText(name)} (verify)`),
	];
	const lost = lostNames.length === 0 ? "none" : lostNames.join(", ");
	const headRef = input.headRef ?? "HEAD";
	const head = [
		input.heading ?? "## Review panel",
		...(input.runLine === undefined ? [] : [input.runLine]),
		"",
		`${input.submitted} ${findingWord} submitted · ${input.fixed} fixed · ${input.dismissed.length} dismissed · ${input.lowAdvisory.length} left as low/advisory`,
		`Seats: ${input.seats.map((name) => postedText(name)).join(", ")} (holistic)${extras}`,
		`Lost: ${lost}`,
		`${postedCode(input.baseRef)} (${postedCode(shortOid(input.baseOid))}) → ${postedCode(headRef)} (${postedCode(shortOid(input.headOid))})`,
	];
	const rows: string[][] = [];
	const section = (title: string, items: string[]) => {
		for (const [index, item] of items.entries()) {
			rows.push(index === 0 ? ["", title, item] : [item]);
		}
	};
	section(
		"### Dismissed",
		input.dismissed.map(
			(row) =>
				`- ${postedText(row.id, 40)} ${postedText(row.title)} — ${postedText(row.reason, 1_000)}`,
		),
	);
	section(
		"### Low / advisory (not kept)",
		input.lowAdvisory.map(
			(row) => `- ${postedText(row.id, 40)} ${postedText(row.title)}`,
		),
	);
	return { head, rows };
}

/** Presentation-only close-out card. Counts and lists, no merge claim. */
export function renderCloseoutComment(input: CloseoutCommentInput): string {
	const { head, rows } = closeoutCardParts(input);
	return fitCommentBody(head, rows, [], "row");
}

function uniqueInOrder(
	values: readonly string[],
	skip?: (value: string) => boolean,
): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const value of values) {
		if (skip?.(value) || seen.has(value)) {
			continue;
		}
		seen.add(value);
		ordered.push(value);
	}
	return ordered;
}

export function seatsFromPanel(panel: PanelRecord): {
	seats: string[];
	extras: string[];
} {
	return {
		seats: uniqueInOrder(
			panel.seats
				.filter((seat) => seat.lens === "holistic")
				.map((seat) => seat.rosterId),
		),
		extras: uniqueInOrder(
			panel.seats.map((seat) => seat.lens),
			(lens) => lens === "holistic" || lens === "fix-verification",
		),
	};
}

/** Split a review record into dismissed, leftover lows, and remaining (fixed) ids. */
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

	const fixed: StampedFinding[] = [];
	for (const entry of input.findings) {
		if (claimed.has(entry.id)) {
			continue;
		}
		if (kept.has(entry.id) || entry.finding.severity !== "low") {
			fixed.push(entry);
			continue;
		}
		throw new Error(
			`${entry.id} is low/advisory and was not listed; pass it in lowAdvisory or dismiss it with a reason`,
		);
	}

	return {
		submitted: input.findings.length,
		fixed,
		dismissed,
		lowAdvisory,
	};
}

/** The close-out card's parts, from a review record plus orchestrator judgment. */
export function assembleCloseoutParts(
	input: AssembleCloseoutInput,
): CloseoutCardParts {
	const accounted = accountCloseoutFindings(input);
	const { seats, extras } = seatsFromPanel(input.panel);
	return closeoutCardParts({
		submitted: accounted.submitted,
		fixed: accounted.fixed.length,
		dismissed: accounted.dismissed,
		lowAdvisory: accounted.lowAdvisory,
		seats,
		extras,
		lost: [...input.lost],
		...(input.verifyLost === undefined
			? {}
			: { verifyLost: [...input.verifyLost] }),
		baseRef: input.meta.baseRef,
		baseOid: input.meta.baseOid,
		headOid: input.meta.headOid,
		...(input.headRef === undefined ? {} : { headRef: input.headRef }),
		...(input.heading === undefined ? {} : { heading: input.heading }),
		...(input.runLine === undefined ? {} : { runLine: input.runLine }),
	});
}

/**
 * Derive the close-out card from a review record plus orchestrator judgment,
 * cut by whole rows to stay under GitHub's comment limit.
 */
export function assembleCloseoutComment(input: AssembleCloseoutInput): string {
	const { head, rows } = assembleCloseoutParts(input);
	return fitCommentBody(head, rows, [], "row");
}
