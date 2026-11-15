/**
 * The verify rounds and PR comment links a close-out card shows.
 *
 * A round is a link of the review's verify chain (see `verify-chain.ts`),
 * from signed records only, and its number is its place in the chain: the
 * same `verify N` its comment posts as, whether or not it posted.
 *
 * Links point only at comments this author posted on this PR, found by
 * first-line heading and the hidden marker as the last line, at the
 * `html_url` gh gave for that comment.
 */
import type { ChainLink } from "../run/verify-chain.js";
import type { CloseoutLinks, CloseoutVerifyRound } from "./closeout-comment.js";
import { prCommentUrl, runMarkerIds } from "./posted-text.js";

export const REVIEW_ROUND_HEADING = "## Review panel · review";
const VERIFY_ROUND_HEADING = /^## Review panel · verify [1-9]\d*$/u;

/** A verify round with the head its signed meta names. */
export type SignedVerifyRound = CloseoutVerifyRound & { headOid?: string };

/**
 * The chain's links as the card's rounds, in link order: each numbered by
 * its place in the chain, with its voting seats, the ids it resolved and its
 * lost seats.
 */
export function chainRounds(
	links: readonly ChainLink[],
): CloseoutVerifyRound[] {
	return links.map((link) => ({
		runId: link.runId,
		round: link.link,
		seats: link.seats,
		resolved: link.resolved,
		lost: link.lost,
	}));
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
