import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import {
	claimCloseout,
	settleCloseout,
} from "../../../src/tool/round-claim.js";
import { TEST_RECORD_KEY } from "../record-key.js";

/**
 * One verify, as its own process, racing others over one review record for
 * the close-out. "Posting" appends `<id> <what>` to the
 * shared `posts` file, which also stands in for the PR's comments. Barrier
 * files order the processes exactly where a test needs it. Prints one JSON
 * line: what this process got.
 *
 * Run with `node --import source-hooks.ts claim-race.ts <spec-json>`.
 */
type Spec = {
	kind: "closeout";
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
	/** Before creating this generation's claim, park once. */
	parkAt?: number;
	/** Touch this file when parked. */
	parked?: string;
	/** Leave the park once this file exists. */
	release?: string;
	/** Park in the first PR check (after judging a claim stale, before acting). */
	parkInCardCheck?: boolean;
	/** Milliseconds the post takes. */
	postMs?: number;
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

let checkedOnce = false;
function cardOnPr(): Promise<boolean> {
	if (spec.parkInCardCheck === true && !checkedOnce) {
		checkedOnce = true;
		touch(spec.parked);
		waitFor(spec.release as string);
	}
	return Promise.resolve(
		existsSync(spec.posts) &&
			readFileSync(spec.posts, "utf8").includes(" close-out"),
	);
}

async function main(): Promise<unknown> {
	if (spec.startAfter !== undefined) {
		waitFor(spec.startAfter);
	}
	const claim = await claimCloseout(spec.dir, spec.id, cardOnPr, {
		key: TEST_RECORD_KEY,
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
	return { kind: "card-posted" };
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
