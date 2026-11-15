/**
 * Exclusive claims in a review's run record, so nothing is posted twice:
 * `round-<N>.claim` for the post of verify round N (N is the verify's place
 * in the review's chain), and `closeout.claim-<g>` for the review's one
 * close-out.
 *
 * Every claim is a fresh file created with `O_EXCL` (`wx`), holding who
 * made it and when (`{verifyRunId, pid, host, claimedAt}`). Mutual
 * exclusion comes only from that create: no claim is ever taken over,
 * renamed or put back. A claim older than the round deadline, or one made
 * on this host whose process is gone, was left by a crash. It is stale and
 * stays where it is: a round whose claim was left stale is not posted, and
 * the next close-out moves past it to generation g+1. A crash can leave a
 * round unposted, never posted twice.
 *
 * The posted markers (`round-<N>.posted`, `closeout.posted`) carry a MAC
 * from the owner's record key, bound to the record's run id, the marker's
 * file name and the verify that wrote it. The record lives in the reviewed
 * repository, so a marker without a valid MAC (planted, copied from another
 * record or round, or written before markers were signed), or a round
 * marker signed for another verify, counts as no marker: it neither stops
 * this verify's round nor a close-out, and the verify that posts replaces
 * it.
 *
 * Only node builtins are imported here, so a plain `node` child process can
 * load this module directly (the tests race real processes over it).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
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
/** A claim older than this was left by a verify that is no longer posting. */
const CLAIM_STALE_MS = ROUND_DEADLINE_MS + 5_000;
/** Close-out claims tried before the verify gives up: `closeout.claim-1` … `-5`. */
export const CLOSEOUT_GENERATIONS = 5;

export const CLOSEOUT_POSTED_FILE = "closeout.posted";

export type ClaimInfo = {
	verifyRunId: string;
	pid: number;
	/** The pid is judged only on the host that wrote it. */
	host: string;
	claimedAt: number;
};

/** A claim this verify holds, with the record key its posted marker is signed with. */
export type HeldClaim = { file: string; info: ClaimInfo; key: Buffer };

/**
 * The MAC of a posted marker: the owner's record key over the run id of the
 * record that holds it (its folder name), the marker's file name (which
 * carries the round) and the verify that wrote it. Its own domain tag keeps
 * it from ever matching a plan, seat or record MAC.
 */
export function postedMarkerMac(
	key: Buffer,
	recordRunId: string,
	name: string,
	verifyRunId: string,
): string {
	return createHmac("sha256", key)
		.update(
			`pi-review-panel/posted/v1\0${recordRunId}\0${name}\0${verifyRunId}\0`,
		)
		.digest("hex");
}

/** The text of a posted marker at `file`, signed with `key`. */
export function postedMarkerText(
	file: string,
	key: Buffer,
	verifyRunId: string,
	extra: Record<string, unknown> = {},
): string {
	return `${JSON.stringify({
		verifyRunId,
		postedAt: Date.now(),
		...extra,
		mac: postedMarkerMac(
			key,
			path.basename(path.dirname(file)),
			path.basename(file),
			verifyRunId,
		),
	})}\n`;
}

/**
 * True only for a regular file at `file` holding a posted marker whose MAC
 * is the owner's for this record, this file name and the verify it names.
 * Anything else, planted or copied, is no marker.
 */
export function isSignedMarker(file: string, key: Buffer): boolean {
	return signedMarkerVerifyRunId(file, key) !== undefined;
}

/**
 * The verify a signed posted marker names, or undefined for anything that
 * is not one (see {@link isSignedMarker}). The verify id is under the MAC;
 * any other field in the marker is not.
 */
function signedMarkerVerifyRunId(
	file: string,
	key: Buffer,
): string | undefined {
	if (!isRealFile(file)) {
		return undefined;
	}
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as {
			verifyRunId?: unknown;
			mac?: unknown;
		} | null;
		if (
			value === null ||
			typeof value !== "object" ||
			typeof value.verifyRunId !== "string" ||
			typeof value.mac !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.mac)
		) {
			return undefined;
		}
		const expected = postedMarkerMac(
			key,
			path.basename(path.dirname(file)),
			path.basename(file),
			value.verifyRunId,
		);
		return timingSafeEqual(
			Buffer.from(expected, "hex"),
			Buffer.from(value.mac, "hex"),
		)
			? value.verifyRunId
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Writes a signed posted marker exclusively. When something is already at
 * `file` that is not a marker signed for this verify (planted, left
 * half-written, or another verify's), it is removed (a symlink itself,
 * never its target) and the create is tried once more. True when a signed
 * marker is there afterwards.
 */
export function writeSignedMarker(
	file: string,
	key: Buffer,
	verifyRunId: string,
	extra: Record<string, unknown> = {},
): boolean {
	const text = () => postedMarkerText(file, key, verifyRunId, extra);
	if (createExclusive(file, text())) {
		return true;
	}
	if (signedMarkerVerifyRunId(file, key) === verifyRunId) {
		return true;
	}
	rmSync(file, { force: true });
	return createExclusive(file, text()) || isSignedMarker(file, key);
}

/** Records are untrusted: never follow a symlink or open a FIFO in one. */
function isRealFile(target: string): boolean {
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

function createClaim(
	file: string,
	verifyRunId: string,
	key: Buffer,
): HeldClaim | undefined {
	const info: ClaimInfo = {
		verifyRunId,
		pid: process.pid,
		host: hostname(),
		claimedAt: Date.now(),
	};
	return createExclusive(file, `${JSON.stringify(info)}\n`)
		? { file, info, key }
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
 * Writes a signed posted marker, then gives the claim back. When the marker
 * cannot be written the claim stays: it goes stale and is skipped, a gap
 * rather than a duplicate.
 */
function settlePosted(claim: HeldClaim, marker: string): void {
	try {
		if (!writeSignedMarker(marker, claim.key, claim.info.verifyRunId)) {
			return;
		}
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

/**
 * Claims the post of verify round `round`: the round number is the verify's
 * place in its review's chain, so only that verify posts it.
 *
 * - A `round-<N>.posted` signed for this verify: the round is already on
 *   the PR. An unsigned marker, or one signed for another verify (left by
 *   a chain that is gone), is no marker for it.
 * - `round-<N>.claim` is created exclusively; after the create, the posted
 *   marker is checked again.
 * - A claim already there is never taken over: a live one means the round
 *   is being posted, a stale one that a post of it stopped.
 */
export async function claimRound(
	recordDir: string,
	round: number,
	verifyRunId: string,
	options: {
		/** The owner's record key: posted markers are read and signed with it. */
		key: Buffer;
		signal?: AbortSignal;
	},
): Promise<RoundClaim | { reason: string }> {
	if (!isRealDirectory(recordDir)) {
		return { reason: "the review's run record is missing" };
	}
	if (options.signal?.aborted) {
		return { reason: "the run was interrupted" };
	}
	const posted = roundPostedFile(recordDir, round);
	const postedHere = () =>
		signedMarkerVerifyRunId(posted, options.key) === verifyRunId;
	if (postedHere()) {
		return { reason: `verify ${round} is already on the PR` };
	}
	const file = roundClaimFile(recordDir, round);
	let claim: HeldClaim | undefined;
	try {
		claim = createClaim(file, verifyRunId, options.key);
	} catch (error) {
		return {
			reason: `verify ${round} could not be claimed: ${errorMessage(error)}`,
		};
	}
	if (claim === undefined) {
		return {
			reason: claimIsStale(file, Date.now())
				? `round-${round}.claim was left by a post of verify ${round} that stopped; delete it from the review's run record to post it`
				: `another process is posting verify ${round}`,
		};
	}
	if (postedHere()) {
		releaseClaim(claim);
		return { reason: `verify ${round} is already on the PR` };
	}
	return { ...claim, round };
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
 * - A signed `closeout.posted` there: already posted. An unsigned one is no
 *   marker; the verify that posts the card replaces it.
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
	options: {
		/** The owner's record key: `closeout.posted` is read and signed with it. */
		key: Buffer;
		beforeCreate?: (generation: number) => void;
	},
): Promise<CloseoutClaimResult> {
	if (!isRealDirectory(recordDir)) {
		return {
			kind: "error",
			error: new Error("the review's run record is missing"),
		};
	}
	const posted = closeoutPostedFile(recordDir);
	const isPosted = () => isSignedMarker(posted, options.key);
	if (isPosted()) {
		return { kind: "posted", onPr: false };
	}
	let generation = 1;
	let retries = 0;
	while (generation <= CLOSEOUT_GENERATIONS) {
		const file = closeoutClaimFile(recordDir, generation);
		options.beforeCreate?.(generation);
		let claim: HeldClaim | undefined;
		try {
			claim = createClaim(file, verifyRunId, options.key);
		} catch (error) {
			return { kind: "error", error };
		}
		if (claim !== undefined) {
			if (isPosted()) {
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
				writeSignedMarker(posted, options.key, verifyRunId, {
					foundOnPr: true,
				});
			} catch {
				// The PR check still stops every later verify.
			}
			return { kind: "posted", onPr: true };
		}
		if (isPosted()) {
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
