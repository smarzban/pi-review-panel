/**
 * Exclusive claims in a review's run record, so concurrent verifies of one
 * review never post the same thing twice: `round-<N>.claim` for the number
 * of a verify round, and `closeout.posted` for the review's one close-out.
 *
 * A claim is a file created with `O_EXCL` that holds who took it and when
 * (`{verifyRunId, pid, claimedAt}`). A claim whose owner is still posting
 * is live. One older than the round deadline, or whose process is gone,
 * was left by a crash: it is stale, and the next verify takes it over by
 * renaming it aside, so only one taker wins.
 */
import {
	closeSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import path from "node:path";

/** Every `gh` call of one round together gets at most this long. */
export const ROUND_DEADLINE_MS = 60_000;
/** A claim older than this was left by a verify that is no longer posting. */
const CLAIM_STALE_MS = ROUND_DEADLINE_MS + 5_000;
const POLL_MS = 100;

export type ClaimInfo = {
	verifyRunId: string;
	pid: number;
	claimedAt: number;
	/** Set once the claimed comment is on the PR; such a claim never goes stale. */
	postedAt?: number;
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

function processIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// EPERM: it exists and belongs to someone else.
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
		// Not a claim this module wrote; judged by its age on disk.
	}
	return undefined;
}

type Existing = { text: string; posted: boolean; stale: boolean };

/** What is in an existing claim, or undefined when it is gone. */
function readExisting(file: string, now: number): Existing | undefined {
	let text: string;
	let mtimeMs: number;
	try {
		const stat = lstatSync(file);
		if (!stat.isFile()) {
			// Not ours to judge or take over: it stays held.
			return { text: "", posted: false, stale: false };
		}
		mtimeMs = stat.mtimeMs;
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const info = parseInfo(text);
	if (info?.postedAt !== undefined) {
		return { text, posted: true, stale: false };
	}
	const claimedAt = info?.claimedAt ?? mtimeMs;
	const stale =
		now - claimedAt > CLAIM_STALE_MS ||
		(info !== undefined && info.pid !== process.pid && processIsGone(info.pid));
	return { text, posted: false, stale };
}

function create(file: string, info: ClaimInfo): "taken" | "exists" {
	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (error) {
		if ((error as { code?: unknown }).code === "EEXIST") {
			return "exists";
		}
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(info)}\n`);
	} finally {
		closeSync(fd);
	}
	return "taken";
}

/**
 * Moves a stale claim aside. Only one taker's rename succeeds; it then
 * checks that what it moved is the claim it judged stale, and puts back a
 * fresh claim it moved by mistake.
 */
function removeStale(file: string, judged: string): void {
	const aside = `${file}.stale-${process.pid}-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}`;
	try {
		renameSync(file, aside);
	} catch {
		return;
	}
	let moved = "";
	try {
		moved = readFileSync(aside, "utf8");
	} catch {
		// Unreadable: treat it as the stale claim.
		moved = judged;
	}
	if (moved !== judged) {
		try {
			// A fresh claim came between: give it back unless one is there again.
			if (!exists(file)) {
				renameSync(aside, file);
				return;
			}
		} catch {
			// Fall through and drop it.
		}
	}
	rmSync(aside, { force: true });
}

export type TakeResult =
	| { kind: "taken"; claim: HeldClaim }
	| { kind: "held"; posted: boolean }
	| { kind: "error"; error: unknown };

/**
 * Takes the claim at `file`, taking over a stale one. A live or posted
 * claim stays with its owner.
 */
export function takeClaim(file: string, verifyRunId: string): TakeResult {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const info: ClaimInfo = {
			verifyRunId,
			pid: process.pid,
			claimedAt: Date.now(),
		};
		try {
			if (create(file, info) === "taken") {
				return { kind: "taken", claim: { file, info } };
			}
		} catch (error) {
			return { kind: "error", error };
		}
		const existing = readExisting(file, Date.now());
		if (existing === undefined) {
			// Released between the two calls: try again.
			continue;
		}
		if (!existing.stale) {
			return { kind: "held", posted: existing.posted };
		}
		removeStale(file, existing.text);
	}
	return { kind: "held", posted: false };
}

/** Marks a claim posted, so it never goes stale. */
export function markPosted(claim: HeldClaim): void {
	const temp = `${claim.file}.${process.pid}.tmp`;
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeSync(
				fd,
				`${JSON.stringify({ ...claim.info, postedAt: Date.now() })}\n`,
			);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, claim.file);
	} catch {
		rmSync(temp, { force: true });
		// The claim still stands; it is judged by its time if it goes stale.
	}
}

/** Gives a claim back, if it is still this verify's. */
export function releaseClaim(claim: HeldClaim): void {
	try {
		const info = parseInfo(readFileSync(claim.file, "utf8"));
		if (
			info?.verifyRunId === claim.info.verifyRunId &&
			info.claimedAt === claim.info.claimedAt
		) {
			rmSync(claim.file, { force: true });
		}
	} catch {
		// Gone already, or unreadable: nothing of ours to give back.
	}
}

export function roundClaimFile(recordDir: string, round: number): string {
	return path.join(recordDir, `round-${round}.claim`);
}

export function roundPostedFile(recordDir: string, round: number): string {
	return path.join(recordDir, `round-${round}.posted`);
}

export type RoundClaim = HeldClaim & { round: number };

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Allocates the next verify round number of a review, from `floor` up. A
 * posted round is skipped. A round another verify is still posting is
 * waited on until that post settles, so a failed post gives its number
 * back and no round is skipped. Gives up at `deadline` or on an interrupt,
 * saying why.
 */
export async function claimRound(
	recordDir: string,
	floor: number,
	verifyRunId: string,
	options: { deadline: number; signal?: AbortSignal; pollMs?: number },
): Promise<RoundClaim | { reason: string }> {
	if (!isRealDirectory(recordDir)) {
		return { reason: "the review's run record is missing" };
	}
	let round = Math.max(1, floor);
	for (;;) {
		if (options.signal?.aborted) {
			return { reason: "the run was interrupted" };
		}
		if (exists(roundPostedFile(recordDir, round))) {
			round += 1;
			continue;
		}
		const taken = takeClaim(roundClaimFile(recordDir, round), verifyRunId);
		if (taken.kind === "taken") {
			return { ...taken.claim, round };
		}
		if (taken.kind === "error") {
			const message =
				taken.error instanceof Error
					? taken.error.message
					: String(taken.error);
			return {
				reason: `verify ${round} could not be claimed: ${message.replace(/\s+/g, " ").slice(0, 200)}`,
			};
		}
		if (taken.posted) {
			round += 1;
			continue;
		}
		if (Date.now() >= options.deadline) {
			return { reason: `another verify is still posting verify ${round}` };
		}
		await sleep(options.pollMs ?? POLL_MS);
	}
}

/**
 * Settles a round claim: once the comment is on the PR the round becomes
 * `round-<N>.posted`; otherwise the number is given back.
 */
export function settleRound(claim: RoundClaim, posted: boolean): void {
	if (!posted) {
		releaseClaim(claim);
		return;
	}
	try {
		renameSync(
			claim.file,
			roundPostedFile(path.dirname(claim.file), claim.round),
		);
	} catch {
		// The claim stays; it goes stale and is taken over, at worst
		// repeating this number once.
	}
}
