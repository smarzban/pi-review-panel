import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	claimCloseout,
	claimRound,
	settleCloseout,
	settleRound,
} from "../../../src/tool/round-claim.js";

/**
 * One verify, as its own process, racing others over one review record for
 * a round number or the close-out. "Posting" appends `<id> <what>` to the
 * shared `posts` file, which also stands in for the PR's comments. Barrier
 * files order the processes exactly where a test needs it. Prints one JSON
 * line: what this process got.
 *
 * Run with `node --import source-hooks.ts claim-race.ts <spec-json>`.
 */
type Spec = {
	kind: "round" | "closeout";
	dir: string;
	id: string;
	posts: string;
	/** Start only once this file exists. */
	startAfter?: string;
	/** Touch this file once the claim is held. */
	claimed?: string;
	/** Hold the claim until this file exists, then post. */
	postAfter?: string;
	/** Touch this file once the post is settled. */
	settled?: string;
	/** Before creating this round's (or generation's) claim, park once. */
	parkAt?: number;
	/** Touch this file when parked. */
	parked?: string;
	/** Leave the park once this file exists. */
	release?: string;
	/** Milliseconds the post takes. */
	postMs?: number;
	/** Claim and post this many rounds, one after another. */
	rounds?: number;
	/** Fail every post whose 1-based index is listed. */
	failPosts?: number[];
};

const spec = JSON.parse(process.argv[2] as string) as Spec;
const lock = new Int32Array(new SharedArrayBuffer(4));

function pause(ms: number): void {
	Atomics.wait(lock, 0, 0, ms);
}

function waitFor(file: string): void {
	const until = Date.now() + 20_000;
	while (!existsSync(file)) {
		if (Date.now() > until) {
			throw new Error(`timed out waiting for ${file}`);
		}
		pause(2);
	}
}

function touch(file: string | undefined): void {
	if (file !== undefined) {
		writeFileSync(file, "");
	}
}

let parkedOnce = false;
function beforeCreate(at: number): void {
	if (spec.parkAt === at && !parkedOnce) {
		parkedOnce = true;
		touch(spec.parked);
		waitFor(spec.release as string);
	}
}

function cardOnPr(): Promise<boolean> {
	return Promise.resolve(
		existsSync(spec.posts) &&
			readFileSync(spec.posts, "utf8").includes(" close-out"),
	);
}

async function main(): Promise<unknown> {
	if (spec.startAfter !== undefined) {
		waitFor(spec.startAfter);
	}
	if (spec.kind === "round") {
		const got: unknown[] = [];
		for (let index = 1; index <= (spec.rounds ?? 1); index += 1) {
			const claim = await claimRound(spec.dir, 1, spec.id, {
				deadline: Date.now() + 20_000,
				reserveMs: 0,
				pollMs: 2,
				beforeCreate,
			});
			if ("reason" in claim) {
				got.push({ reason: claim.reason });
				continue;
			}
			touch(spec.claimed);
			if (spec.postAfter !== undefined) {
				waitFor(spec.postAfter);
			}
			pause(spec.postMs ?? 0);
			const fails = spec.failPosts?.includes(index) === true;
			if (!fails) {
				appendFileSync(spec.posts, `${spec.id} verify ${claim.round}\n`);
			}
			settleRound(claim, !fails);
			touch(spec.settled);
			got.push(fails ? { failed: claim.round } : { round: claim.round });
		}
		return got;
	}
	const claim = await claimCloseout(spec.dir, spec.id, cardOnPr, {
		beforeCreate,
	});
	if (claim.kind !== "taken") {
		return claim;
	}
	touch(spec.claimed);
	if (spec.postAfter !== undefined) {
		waitFor(spec.postAfter);
	}
	if (await cardOnPr()) {
		settleCloseout(claim.claim, true);
		return { kind: "on-pr" };
	}
	pause(spec.postMs ?? 0);
	appendFileSync(spec.posts, `${spec.id} close-out\n`);
	settleCloseout(claim.claim, true);
	touch(spec.settled);
	return { kind: "posted" };
}

main().then(
	(result) => {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	},
	(error: unknown) => {
		process.stdout.write(
			`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
		);
	},
);
