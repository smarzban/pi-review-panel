/**
 * Exclusive claims in a review's run record, so concurrent verifies of one
 * review never post the same thing twice: `round-<N>.claim` for the number
 * of a verify round, and `closeout.claim-<g>` for the review's one
 * close-out.
 *
 * Every claim is a fresh file created with `O_EXCL` (`wx`), holding who
 * made it and when (`{verifyRunId, pid, host, claimedAt}`). Mutual
 * exclusion comes only from that create: no claim is ever taken over,
 * renamed or put back. A claim older than the round deadline, or one made
 * on this host whose process is gone, was left by a crash. It is stale and
 * stays where it is; the next verify moves past it, to round N+1 or to
 * close-out generation g+1. A crash can therefore leave a gap in the verify
 * numbering, never a duplicate.
 *
 * Only node builtins are imported here, so a plain `node` child process can
 * load this module directly (the tests race real processes over it).
 */
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/** Every `gh` call of one round together gets at most this long. */
export const ROUND_DEADLINE_MS = 60_000;
/**
 * A verify waiting on another's round claim stops waiting while this much
 * of its round deadline is left, so a claim it wins always has time for
 * its POST (one `gh` call's own limit).
 */
export const POST_RESERVE_MS = 30_000;
/** A claim older than this was left by a verify that is no longer posting. */
const CLAIM_STALE_MS = ROUND_DEADLINE_MS + 5_000;
/** Close-out claims tried before the verify gives up: `closeout.claim-1` … `-5`. */
export const CLOSEOUT_GENERATIONS = 5;
const POLL_MS = 100;

export const CLOSEOUT_POSTED_FILE = "closeout.posted";

export type ClaimInfo = {
	verifyRunId: string;
	pid: number;
	/** The pid is judged only on the host that wrote it. */
	host: string;
	claimedAt: number;
};

export type HeldClaim = { file: string; info: ClaimInfo };

/** Records are untrusted: never follow a symlink or open a FIFO in one. */
export function isRealFile(target: string): boolean {
	try {
		return lstatSync(target).isFile();
	} catch {
		return false;
	}
}

function isRealDirectory(target: string): boolean {
	try {
		return lstatSync(target).isDirectory();
	} catch {
		return false;
	}
}

function exists(target: string): boolean {
	try {
		lstatSync(target);
		return true;
	} catch {
		return false;
	}
}

/** Only `ESRCH` means gone; `EPERM` means it runs as someone else. */
function processIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === "ESRCH";
	}
}

function parseInfo(text: string): ClaimInfo | undefined {
	try {
		const value = JSON.parse(text) as Partial<ClaimInfo> | null;
		if (
			value !== null &&
			typeof value === "object" &&
			typeof value.verifyRunId === "string" &&
			Number.isInteger(value.pid) &&
			typeof value.claimedAt === "number"
		) {
			return value as ClaimInfo;
		}
	} catch {
		// Not a claim this module wrote, or one still being written.
	}
	return undefined;
}

/**
 * Whether the claim at `file` was left by a crash, or undefined when there
 * is none. A claim this module did not write (or is still writing, or that
 * is not a regular file) is judged by its age on disk alone. The pid rule
 * applies only to a claim made on this host.
 */
function claimIsStale(file: string, now: number): boolean | undefined {
	let mtimeMs: number;
	let text = "";
	try {
		const stat = lstatSync(file);
		mtimeMs = stat.mtimeMs;
		if (stat.isFile()) {
			text = readFileSync(file, "utf8");
		}
	} catch {
		return undefined;
	}
	const info = parseInfo(text);
	if (now - (info?.claimedAt ?? mtimeMs) > CLAIM_STALE_MS) {
		return true;
	}
	return (
		info !== undefined &&
		info.host === hostname() &&
		info.pid !== process.pid &&
		processIsGone(info.pid)
	);
}

/** Creates `file` exclusively with `content`; false when it already exists. */
function createExclusive(file: string, content: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (error) {
		if ((error as { code?: unknown }).code === "EEXIST") {
			return false;
		}
		throw error;
	}
	try {
		writeSync(fd, content);
	} finally {
		closeSync(fd);
	}
	return true;
}

function createClaim(file: string, verifyRunId: string): HeldClaim | undefined {
	const info: ClaimInfo = {
		verifyRunId,
		pid: process.pid,
		host: hostname(),
		claimedAt: Date.now(),
	};
	return createExclusive(file, `${JSON.stringify(info)}\n`)
		? { file, info }
		: undefined;
}

/** Gives a claim back, if what is at its path is still this verify's. */
export function releaseClaim(claim: HeldClaim): void {
	try {
		const info = parseInfo(readFileSync(claim.file, "utf8"));
		if (
			info?.verifyRunId === claim.info.verifyRunId &&
			info.claimedAt === claim.info.claimedAt &&
			info.pid === claim.info.pid
		) {
			rmSync(claim.file, { force: true });
		}
	} catch {
		// Gone already, or unreadable: nothing of ours to give back.
	}
}

/**
 * Writes a posted marker exclusively, then gives the claim back. When the
 * marker cannot be written the claim stays: it goes stale and is skipped,
 * a gap rather than a duplicate.
 */
function settlePosted(claim: HeldClaim, marker: string): void {
	try {
		createExclusive(
			marker,
			`${JSON.stringify({ verifyRunId: claim.info.verifyRunId, postedAt: Date.now() })}\n`,
		);
	} catch {
		return;
	}
	releaseClaim(claim);
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").slice(0, 200);
}

export function roundClaimFile(recordDir: string, round: number): string {
	return path.join(recordDir, `round-${round}.claim`);
}

export function roundPostedFile(recordDir: string, round: number): string {
	return path.join(recordDir, `round-${round}.posted`);
}

export function closeoutClaimFile(
	recordDir: string,
	generation: number,
): string {
	return path.join(recordDir, `closeout.claim-${generation}`);
}

export function closeoutPostedFile(recordDir: string): string {
	return path.join(recordDir, CLOSEOUT_POSTED_FILE);
}

export type RoundClaim = HeldClaim & { round: number };

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Allocates the next verify round number of a review, from `floor` up.
 *
 * - A posted round (`round-<N>.posted`) is skipped.
 * - `round-<N>.claim` is created exclusively; after the create, the posted
 *   marker is checked again, because another verify can post N and settle
 *   between the first check and the create. If it is there, the claim is
 *   given back and N+1 is tried.
 * - A stale claim stays where it is and N+1 is tried.
 * - A live claim is waited on, so a failed post gives its number back and
 *   no round is skipped. Waiting stops on an interrupt, or once less than
 *   `reserveMs` (default {@link POST_RESERVE_MS}) of `deadline` is left,
 *   and a verify that has waited takes no claim after that point; it then
 *   posts no round, and the reason says so. A verify that never waited
 *   takes a free number whatever time is left.
 *
 * `beforeCreate` runs just before each create (tests park there).
 */
export async function claimRound(
	recordDir: string,
	floor: number,
	verifyRunId: string,
	options: {
		deadline: number;
		signal?: AbortSignal;
		pollMs?: number;
		reserveMs?: number;
		beforeCreate?: (round: number) => void;
	},
): Promise<RoundClaim | { reason: string }> {
	if (!isRealDirectory(recordDir)) {
		return { reason: "the review's run record is missing" };
	}
	const reserve = options.reserveMs ?? POST_RESERVE_MS;
	let round = Math.max(1, floor);
	let waited = false;
	for (;;) {
		if (options.signal?.aborted) {
			return { reason: "the run was interrupted" };
		}
		if (waited && Date.now() >= options.deadline - reserve) {
			// Not even a claim freed just now is taken this late.
			return { reason: `another verify is still posting verify ${round}` };
		}
		const posted = roundPostedFile(recordDir, round);
		if (exists(posted)) {
			round += 1;
			continue;
		}
		const file = roundClaimFile(recordDir, round);
		options.beforeCreate?.(round);
		let claim: HeldClaim | undefined;
		try {
			claim = createClaim(file, verifyRunId);
		} catch (error) {
			return {
				reason: `verify ${round} could not be claimed: ${errorMessage(error)}`,
			};
		}
		if (claim !== undefined) {
			if (exists(posted)) {
				releaseClaim(claim);
				round += 1;
				continue;
			}
			return { ...claim, round };
		}
		const stale = claimIsStale(file, Date.now());
		if (stale === undefined) {
			// Given back between the create and the look: try it again.
			continue;
		}
		if (stale) {
			round += 1;
			continue;
		}
		if (Date.now() >= options.deadline - reserve) {
			return { reason: `another verify is still posting verify ${round}` };
		}
		await sleep(options.pollMs ?? POLL_MS);
		waited = true;
	}
}

/**
 * Settles a round claim: once the comment is on the PR, `round-<N>.posted`
 * is written exclusively and the claim removed; otherwise the claim is
 * removed, giving the number back.
 */
export function settleRound(claim: RoundClaim, posted: boolean): void {
	if (posted) {
		settlePosted(claim, roundPostedFile(path.dirname(claim.file), claim.round));
		return;
	}
	releaseClaim(claim);
}

export type CloseoutClaimResult =
	| { kind: "taken"; claim: HeldClaim }
	/** Already posted: `closeout.posted` was there, or the card was on the PR. */
	| { kind: "posted"; onPr: boolean }
	/** A live claim: another verify is posting it. */
	| { kind: "busy" }
	/** Every generation was left stale and the card is not on the PR. */
	| { kind: "exhausted" }
	| { kind: "error"; error: unknown };

/**
 * Claims a review's one close-out.
 *
 * - `closeout.posted` there: already posted.
 * - Otherwise `closeout.claim-<g>` is created exclusively, from g = 1. After
 *   the create, `closeout.posted` is checked again, as for rounds.
 * - A live claim: another verify is posting it.
 * - A stale claim: `cardOnPr` asks the PR's comments. If the card is there,
 *   `closeout.posted` is written and nothing more is done. If not, the
 *   next generation is tried, up to {@link CLOSEOUT_GENERATIONS}.
 *
 * Only the creator of a generation posts. `cardOnPr` may throw (a `gh`
 * failure); that propagates, with no claim held.
 */
export async function claimCloseout(
	recordDir: string,
	verifyRunId: string,
	cardOnPr: () => Promise<boolean>,
	options: { beforeCreate?: (generation: number) => void } = {},
): Promise<CloseoutClaimResult> {
	if (!isRealDirectory(recordDir)) {
		return {
			kind: "error",
			error: new Error("the review's run record is missing"),
		};
	}
	const posted = closeoutPostedFile(recordDir);
	if (exists(posted)) {
		return { kind: "posted", onPr: false };
	}
	let generation = 1;
	let retries = 0;
	while (generation <= CLOSEOUT_GENERATIONS) {
		const file = closeoutClaimFile(recordDir, generation);
		options.beforeCreate?.(generation);
		let claim: HeldClaim | undefined;
		try {
			claim = createClaim(file, verifyRunId);
		} catch (error) {
			return { kind: "error", error };
		}
		if (claim !== undefined) {
			if (exists(posted)) {
				releaseClaim(claim);
				return { kind: "posted", onPr: false };
			}
			return { kind: "taken", claim };
		}
		const stale = claimIsStale(file, Date.now());
		if (stale === undefined) {
			// Given back by a failed post: try this generation again.
			retries += 1;
			if (retries > 3) {
				return { kind: "busy" };
			}
			continue;
		}
		if (!stale) {
			return { kind: "busy" };
		}
		if (await cardOnPr()) {
			try {
				createExclusive(
					posted,
					`${JSON.stringify({ verifyRunId, postedAt: Date.now(), foundOnPr: true })}\n`,
				);
			} catch {
				// The PR check still stops every later verify.
			}
			return { kind: "posted", onPr: true };
		}
		if (exists(posted)) {
			return { kind: "posted", onPr: false };
		}
		generation += 1;
	}
	return { kind: "exhausted" };
}

/**
 * Settles a close-out claim: once the card is on the PR (posted now or
 * found there), `closeout.posted` is written exclusively and the claim
 * removed; otherwise the claim is removed so a later verify can post it.
 */
export function settleCloseout(claim: HeldClaim, posted: boolean): void {
	if (posted) {
		settlePosted(claim, closeoutPostedFile(path.dirname(claim.file)));
		return;
	}
	releaseClaim(claim);
}
