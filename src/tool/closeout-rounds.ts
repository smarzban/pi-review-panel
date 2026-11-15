/**
 * The verify rounds and PR comment links a close-out card shows, from
 * signed records only.
 *
 * A round's number is the `verify N` its comment posted as: the review
 * record's `round-<N>.posted`, whose file name and verify id are under the
 * owner's MAC (the round field inside a marker is not, so it is never read).
 * Each round's seats and dispositions come from that verify's own signed
 * record (`record.mac`, kind verify), whose signed `meta.json` and
 * `verification.json` name this review. Anything unsigned, planted, copied
 * or for another review is no round.
 *
 * Links point only at comments this author posted on this PR, found by
 * first-line heading and the hidden marker as the last line, at the
 * `html_url` gh gave for that comment.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import { NEW_REVIEW_FIX, resolvePriorRunId } from "../run/prior-run.js";
import { COMPLETE_MARKER, readSignedRecord } from "../run/record.js";
import type {
	CloseoutLinks,
	CloseoutSeat,
	CloseoutVerifyRound,
} from "./closeout-comment.js";
import { prCommentUrl, runMarkerIds } from "./posted-text.js";
import { isRealFile, signedMarkerVerifyRunId } from "./round-claim.js";

export const REVIEW_ROUND_HEADING = "## Review panel · review";
const VERIFY_ROUND_HEADING = /^## Review panel · verify [1-9]\d*$/u;
const POSTED_ROUND = /^round-([1-9]\d{0,8})\.posted$/u;

/** A verify round with the head its signed meta names. */
export type SignedVerifyRound = CloseoutVerifyRound & { headOid?: string };

type VoteRow = {
	outcome?: {
		kind?: unknown;
		result?: { items?: Array<{ id?: unknown; disposition?: unknown }> };
	};
};

/** Per id, every disposition a voting seat gave it. */
export function dispositionsOf(outcomes: unknown): Map<string, Set<string>> {
	const dispositions = new Map<string, Set<string>>();
	if (!Array.isArray(outcomes)) {
		return dispositions;
	}
	for (const row of outcomes as VoteRow[]) {
		if (row?.outcome?.kind !== "voted") {
			continue;
		}
		const items = row.outcome.result?.items;
		for (const item of Array.isArray(items) ? items : []) {
			if (
				typeof item?.id !== "string" ||
				typeof item.disposition !== "string"
			) {
				continue;
			}
			const seen = dispositions.get(item.id) ?? new Set<string>();
			seen.add(item.disposition);
			dispositions.set(item.id, seen);
		}
	}
	return dispositions;
}

/**
 * The ids a verify marked resolved: at least one voting seat answered, and
 * every answer was `resolved` (the rule `comment` checks a verify by).
 */
export function resolvedIdsOf(
	dispositions: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
	const resolved = new Set<string>();
	for (const [id, states] of dispositions) {
		if (states.size === 1 && states.has("resolved")) {
			resolved.add(id);
		}
	}
	return resolved;
}

/** The ids a voting seat answered without every answer being `resolved`. */
export function unresolvedIdsOf(
	dispositions: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
	const unresolved = new Set<string>();
	for (const [id, states] of dispositions) {
		if (states.size !== 1 || !states.has("resolved")) {
			unresolved.add(id);
		}
	}
	return unresolved;
}

/**
 * The seats that voted in a verify, as roster id and lens, from its
 * outcomes: a lost seat (any other outcome) is not one.
 */
export function votedSeatsOf(outcomes: unknown): CloseoutSeat[] {
	if (!Array.isArray(outcomes)) {
		return [];
	}
	return outcomes.flatMap(
		(row: {
			seat?: { rosterId?: unknown; lens?: unknown };
			outcome?: { kind?: unknown };
		}) =>
			row?.outcome?.kind === "voted" &&
			typeof row.seat?.rosterId === "string" &&
			typeof row.seat.lens === "string"
				? [{ rosterId: row.seat.rosterId, lens: row.seat.lens }]
				: [],
	);
}

function parse(text: string | undefined): unknown {
	try {
		return text === undefined ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * A verify round from a verify record's signed bytes, or undefined when its
 * signed meta or verification does not name this review.
 */
export function verifyRoundOf(
	runId: string,
	signed: ReadonlyMap<string, string>,
	reviewRunId: string,
): SignedVerifyRound | undefined {
	const meta = parse(signed.get("meta.json")) as {
		kind?: unknown;
		priorRunId?: unknown;
		headOid?: unknown;
	} | null;
	const verification = parse(signed.get("verification.json")) as {
		priorRunId?: unknown;
		outcomes?: unknown;
	} | null;
	if (
		meta?.kind !== "verify" ||
		meta.priorRunId !== reviewRunId ||
		verification?.priorRunId !== reviewRunId
	) {
		return undefined;
	}
	const dispositions = dispositionsOf(verification.outcomes);
	return {
		runId,
		seats: votedSeatsOf(verification.outcomes),
		resolved: resolvedIdsOf(dispositions),
		unresolved: unresolvedIdsOf(dispositions),
		...(typeof meta.headOid === "string" ? { headOid: meta.headOid } : {}),
	};
}

/** The owner's complete, signed verify record of this review, or undefined. */
function loadSignedVerify(
	repoDir: string,
	verifyRunId: string,
	reviewRunId: string,
	key: Buffer,
): SignedVerifyRound | undefined {
	try {
		const runId = resolvePriorRunId(repoDir, verifyRunId);
		if (runId !== verifyRunId) {
			return undefined;
		}
		const recordPath = path.join(repoDir, ".review-panel", "runs", runId);
		if (!isRealFile(path.join(recordPath, COMPLETE_MARKER))) {
			return undefined;
		}
		const signed = readSignedRecord(
			recordPath,
			"verify",
			key,
			`verify run "${runId}"`,
			NEW_REVIEW_FIX,
		);
		return verifyRoundOf(runId, signed, reviewRunId);
	} catch {
		return undefined;
	}
}

/**
 * Every verify of this review whose comment reached the PR, numbered by the
 * review record's signed `round-<N>.posted` (the lowest N when a verify is
 * named twice), in round order.
 */
export function postedVerifyRounds(
	repoDir: string,
	review: { runId: string; recordPath: string },
	key: Buffer,
): SignedVerifyRound[] {
	let names: string[];
	try {
		names = readdirSync(review.recordPath);
	} catch {
		return [];
	}
	const roundOf = new Map<string, number>();
	for (const name of names) {
		const found = POSTED_ROUND.exec(name);
		if (found === null) {
			continue;
		}
		const verifyRunId = signedMarkerVerifyRunId(
			path.join(review.recordPath, name),
			key,
		);
		if (verifyRunId === undefined) {
			continue;
		}
		const round = Number(found[1]);
		const seen = roundOf.get(verifyRunId);
		if (seen === undefined || round < seen) {
			roundOf.set(verifyRunId, round);
		}
	}
	const rounds: SignedVerifyRound[] = [];
	for (const [verifyRunId, round] of roundOf) {
		const loaded = loadSignedVerify(repoDir, verifyRunId, review.runId, key);
		if (loaded !== undefined) {
			rounds.push({ ...loaded, round });
		}
	}
	return rounds.sort((left, right) => (left.round ?? 0) - (right.round ?? 0));
}

/**
 * The rounds a card counts: the card's own verify last, and before it each
 * posted round that came before it. A posted round after the card's own is
 * not counted. The card's own verify keeps its posted number, when it has
 * one, from either list.
 */
export function cardRounds(
	posted: readonly CloseoutVerifyRound[],
	own: CloseoutVerifyRound | undefined,
): CloseoutVerifyRound[] {
	if (own === undefined) {
		return [...posted];
	}
	const round =
		own.round ?? posted.find((row) => row.runId === own.runId)?.round;
	const others = posted.filter(
		(row) =>
			row.runId !== own.runId &&
			(round === undefined || (row.round ?? 0) < round),
	);
	return [...others, { ...own, ...(round === undefined ? {} : { round }) }];
}

type ListedComment = {
	id?: unknown;
	html_url?: unknown;
	body?: unknown;
	user?: { login?: unknown };
};

/**
 * Links to this review's comment and to each listed verify's comment on the
 * PR: only comments by `author`, whose first line is the round's heading and
 * whose last non-empty line is exactly its marker, at the `html_url` gh
 * gave, when that is this PR's URL for that comment id. The first match
 * wins. A comment that cannot be found has no link.
 */
export function roundCommentLinks(
	comments: readonly unknown[],
	place: { repo: string; pr: number; author: string },
	reviewRunId: string,
	verifyRunIds: Iterable<string>,
): CloseoutLinks {
	const wanted = new Set(verifyRunIds);
	let review: string | undefined;
	const verify = new Map<string, string>();
	for (const raw of comments) {
		const comment = raw as ListedComment | null;
		if (
			comment?.user?.login !== place.author ||
			typeof comment.body !== "string"
		) {
			continue;
		}
		const url = prCommentUrl(comment.html_url, place, comment.id);
		const ids = runMarkerIds(comment.body);
		if (url === undefined || ids?.review !== reviewRunId) {
			continue;
		}
		const heading = comment.body.split(/\r?\n/u, 1)[0]?.trim() ?? "";
		if (heading === REVIEW_ROUND_HEADING && ids.verify === undefined) {
			review ??= url;
		} else if (
			VERIFY_ROUND_HEADING.test(heading) &&
			ids.verify !== undefined &&
			wanted.has(ids.verify) &&
			!verify.has(ids.verify)
		) {
			verify.set(ids.verify, url);
		}
	}
	return { ...(review === undefined ? {} : { review }), verify };
}
