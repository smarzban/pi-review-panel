import type { PanelRecord, PlannedSeat, StampedFinding } from "../run/types.js";
import type { ChainItem, ChainState } from "../run/verify-chain.js";
import { CLOSEOUT_HEADING } from "./closeout-post.js";
import {
	fitCommentBody,
	markerTail,
	postedCode,
	postedLink,
	postedText,
} from "./posted-text.js";

const OID_DISPLAY_LENGTH = 7;
const SEVERITIES = ["high", "medium", "low"] as const;
/** The range line links at most this many verify comments, the latest. */
const MAX_VERIFY_LINKS = 10;

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

/** A review finding or a regression as one row of the card. */
export type CloseoutItem = {
	id: string;
	title: string;
	/** A review finding's stated severity; a regression shows `regression`. */
	severity?: string;
	/** For a regression: the id an earlier round resolved that it undoes. */
	undoes?: string;
	/** Tool-written words after the title, such as `resolved in verify 2`. */
	label?: string;
};

/** One verify of this review, as the card counts and names it. */
export type CloseoutVerifyRound = {
	runId: string;
	/** The `verify N` its comment posted as; absent when it never posted. */
	round?: number;
	seats: readonly CloseoutSeat[];
	/** The ids it marked resolved: every voting seat that answered said resolved. */
	resolved: ReadonlySet<string>;
	/** Its verify seats that were lost, as `rosterId/lens`. */
	lost?: readonly string[];
	/** The final check before the card: the review head to the final head. */
	final?: true;
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
	/** The ids a verify round resolved, each with the round that did. */
	resolved: readonly CloseoutItem[];
	/** The ids still open: never "fixed", listed so the owner sees them. */
	open?: readonly CloseoutItem[];
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
	/** Where every id stands after the verify chain (see `chainState`). */
	state: ChainState;
	/**
	 * The chain's links as rounds, in link order: a resolved id names the
	 * posted round of the link that resolved it.
	 */
	rounds?: readonly CloseoutVerifyRound[];
	/** Judgment given with the card, on top of the chain's own. */
	dismissed: readonly CloseoutJudgmentRow[];
	lowAdvisory: readonly string[];
};

export type AccountedCloseout = {
	submitted: number;
	resolved: CloseoutItem[];
	open: CloseoutItem[];
	dismissed: CloseoutDismissed[];
	lowAdvisory: CloseoutLow[];
};

export type AssembleCloseoutInput = AccountCloseoutInput & {
	panel: PanelRecord;
	lost: readonly string[];
	verifyLost?: readonly string[];
	meta: { baseRef: string; baseOid: string; headOid: string };
	rounds?: readonly CloseoutVerifyRound[];
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
	const open = input.open?.length ?? 0;
	if (open > 0) {
		parts.push(`**${open} open**`);
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
	const link = (label: string, url: string | undefined) =>
		url === undefined ? undefined : postedLink(label, url);
	const review = link("review", input.links?.review);
	const verify = inOrder(input.rounds ?? []).flatMap((round) => {
		const found =
			round.round === undefined
				? undefined
				: link(`verify ${round.round}`, input.links?.verify?.get(round.runId));
		return found === undefined ? [] : [found];
	});
	// The range line is part of the head, which is never cut: only the last
	// rounds are linked, so it stays short whatever the number of rounds.
	const shown = verify.slice(-MAX_VERIFY_LINKS);
	return [
		`${base} → ${postedCode(shortOid(input.headOid))}`,
		...(review === undefined ? [] : [review]),
		...(shown.length < verify.length ? ["…"] : []),
		...shown,
	].join(" · ");
}

/** Rounds in order: by number, a round with no number (never posted) last. */
function inOrder(
	rounds: readonly CloseoutVerifyRound[],
): CloseoutVerifyRound[] {
	return [...rounds].sort(
		(left, right) =>
			(left.round ?? Number.POSITIVE_INFINITY) -
			(right.round ?? Number.POSITIVE_INFINITY),
	);
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Review findings by severity, high first, then id; regressions last, in chain order. */
function orderItems(items: readonly CloseoutItem[]): CloseoutItem[] {
	const rank = (item: CloseoutItem) =>
		item.severity === undefined ? 3 : (SEVERITY_RANK[item.severity] ?? 3);
	return [...items].sort((left, right) => {
		const order = rank(left) - rank(right);
		if (order !== 0) {
			return order;
		}
		return left.severity === undefined ? 0 : left.id.localeCompare(right.id);
	});
}

/** One card row: id, severity (or `regression`), title, what it undoes, label. */
function itemRow(item: CloseoutItem): string {
	const undoes =
		item.undoes === undefined ? "" : ` (undoes ${postedCode(item.undoes, 40)})`;
	return `- **${postedText(item.id, 40)} [${postedText(item.severity ?? "regression", 20)}]** ${postedText(item.title)}${undoes}${item.label === undefined ? "" : ` · ${item.label}`}`;
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
	const rounds = inOrder(input.rounds ?? []);
	const lostNames = [
		...input.lost.map((name) => postedText(name)),
		...[...new Set(input.verifyLost ?? [])].map(
			(name) => `${postedText(name)} (verify)`,
		),
	];
	const verifiedBy = seatGroups(rounds.flatMap((round) => round.seats));
	// Shown only when the card's last round is the final check.
	const last = (input.rounds ?? []).at(-1);
	const finalCheck =
		last?.final !== true || last.round === undefined
			? undefined
			: (last.lost?.length ?? 0) > 0
				? `**Final check:** verify ${last.round} lost its seat, so nothing was checked`
				: `**Final check:** verify ${last.round}, from the reviewed head to the final head`;
	const head = [
		CLOSEOUT_HEADING,
		"",
		// The final check resolves nothing: it has its own line.
		countsLine(input, rounds.filter((round) => round.final !== true).length),
		`**Review seats:** ${seatGroups(input.seats) ?? "none"}`,
		...(verifiedBy === undefined ? [] : [`**Verified by:** ${verifiedBy}`]),
		...(finalCheck === undefined ? [] : [finalCheck]),
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
	section(undefined, orderItems(input.resolved).map(itemRow));
	section("### Open (not resolved)", orderItems(input.open ?? []).map(itemRow));
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

function itemOf(item: ChainItem, label?: string): CloseoutItem {
	return {
		id: item.id,
		title: item.title,
		...(item.severity === undefined ? {} : { severity: item.severity }),
		...(item.regression?.undoes === undefined
			? {}
			: { undoes: item.regression.undoes }),
		...(label === undefined ? {} : { label }),
	};
}

/**
 * Sorts every review finding and regression onto the card from where the
 * verify chain left it, plus judgment given with the card: resolved (with
 * the round of the link that resolved it), open, dismissed with the reason,
 * or left as low/advisory. With no verify, every finding is unplaced: a low
 * is left as low/advisory, and a high or medium not dismissed is refused as
 * never verified. Judgment given with the card may name only an open or
 * unplaced id; never one a round resolved, dismissed or left as
 * low/advisory.
 */
export function accountCloseoutFindings(
	input: AccountCloseoutInput,
): AccountedCloseout {
	const items = input.state.items;
	const rounds = input.rounds ?? [];
	const claimed = new Map<string, "dismissed" | "low">();
	const reasons = new Map<string, string>();
	// Judgment given with the card names only an id still open, or one no
	// verify placed: what a round judged is on the card as that round left it.
	const refuseResolved = (id: string, item: ChainItem) => {
		const state = item.state;
		if (state.status === "resolved") {
			throw new Error(
				`${id} was resolved in a verify round; it cannot also be kept out`,
			);
		}
		if (state.status === "dismissed" || state.status === "low") {
			throw new Error(
				`${id} was ${state.status === "dismissed" ? "dismissed" : "left as low/advisory"} in verify ${rounds[state.link - 1]?.round ?? state.link}; name only ids still open`,
			);
		}
	};
	for (const row of input.dismissed) {
		const item = items.get(row.id);
		if (item === undefined) {
			throw new Error(`dismissed ${row.id} is not in the review record`);
		}
		if (claimed.has(row.id)) {
			throw new Error(`${row.id} is listed more than once`);
		}
		refuseResolved(row.id, item);
		claimed.set(row.id, "dismissed");
		reasons.set(row.id, requireReason(row.id, row.reason));
	}
	for (const id of input.lowAdvisory) {
		const item = items.get(id);
		if (item === undefined) {
			throw new Error(`low/advisory ${id} is not in the review record`);
		}
		if (claimed.has(id)) {
			throw new Error(`${id} is listed more than once`);
		}
		if (item.severity !== "low") {
			throw new Error(
				item.severity === undefined
					? `${id} is a regression, which has no severity; dismiss it with a reason, not as low/advisory`
					: `${id} is ${item.severity}; high/medium findings that are not kept must be dismissed with a reason, not listed as low/advisory`,
			);
		}
		refuseResolved(id, item);
		claimed.set(id, "low");
	}

	const unverified: string[] = [];
	const accounted: AccountedCloseout = {
		submitted: input.findings.length,
		resolved: [],
		open: [],
		dismissed: [],
		lowAdvisory: [],
	};
	for (const item of items.values()) {
		const given = claimed.get(item.id);
		const state = item.state;
		if (
			given === "dismissed" ||
			(given === undefined && state.status === "dismissed")
		) {
			accounted.dismissed.push({
				id: item.id,
				title: item.title,
				reason:
					reasons.get(item.id) ??
					(state.status === "dismissed" ? state.reason : ""),
			});
			continue;
		}
		if (given === "low" || state.status === "low") {
			accounted.lowAdvisory.push({ id: item.id, title: item.title });
			continue;
		}
		if (state.status === "resolved") {
			const round = rounds[state.link - 1]?.round;
			accounted.resolved.push(
				itemOf(
					item,
					round === undefined ? "resolved" : `resolved in verify ${round}`,
				),
			);
			continue;
		}
		if (state.status === "open") {
			accounted.open.push(itemOf(item));
			continue;
		}
		// Unplaced: no verify ran. A low left out is advisory; a high or
		// medium must be verified or dismissed.
		if (item.severity === "low") {
			accounted.lowAdvisory.push({ id: item.id, title: item.title });
			continue;
		}
		unverified.push(item.id);
	}
	if (unverified.length > 0) {
		throw new Error(
			unverified.length === 1
				? `${unverified[0]} was never verified: verify it, or dismiss it with a reason`
				: `${unverified.join(", ")} were never verified: verify them, or dismiss each with a reason`,
		);
	}
	return accounted;
}

/** The close-out card's parts, from a review record plus orchestrator judgment. */
export function assembleCloseoutParts(
	input: AssembleCloseoutInput,
): CloseoutCardParts {
	const accounted = accountCloseoutFindings(input);
	return closeoutCardParts({
		findings: input.findings,
		resolved: accounted.resolved,
		open: accounted.open,
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
