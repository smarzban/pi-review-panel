import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	CLOSEOUT_GENERATIONS,
	chainClaimFile,
	claimChain,
	claimCloseout,
	claimRound,
	closeoutClaimFile,
	closeoutPostedFile,
	isSignedMarker,
	ROUND_DEADLINE_MS,
	releaseClaim,
	roundClaimFile,
	roundPostedFile,
	settleCloseout,
	settleRound,
} from "../src/tool/round-claim.js";
import { TEST_RECORD_KEY, writeSignedMarker } from "./fixtures/record-key.js";

/**
 * Fix round 3: every claim is a fresh exclusive create. No claim is ever
 * taken over, renamed or put back, so two verifies can never hold one.
 */

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"child",
);

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function record(): string {
	const root = mkdtempSync(path.join(tmpdir(), "round-claim-"));
	roots.push(root);
	return root;
}

/** A process id that is certainly not running any more. */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

function seed(file: string, info: object | string): void {
	writeFileSync(file, typeof info === "string" ? info : JSON.stringify(info));
}

function staleByAge(): object {
	return {
		verifyRunId: "v-0",
		pid: process.pid,
		host: hostname(),
		claimedAt: Date.now() - ROUND_DEADLINE_MS - 10_000,
	};
}

function liveHere(): object {
	return {
		verifyRunId: "v-0",
		pid: process.pid,
		host: hostname(),
		claimedAt: Date.now(),
	};
}

function claimsIn(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => name.includes(".claim"))
		.sort();
}

type ChildResult = unknown;

/** Runs one racing verify as its own `node` process. */
function child(spec: object): Promise<ChildResult> {
	const proc = spawn(
		process.execPath,
		[
			"--import",
			path.join(FIXTURES, "source-hooks.ts"),
			path.join(FIXTURES, "claim-race.ts"),
			JSON.stringify(spec),
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	let out = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		out += chunk;
	});
	const watchdog = setTimeout(() => proc.kill("SIGKILL"), 30_000);
	return new Promise((resolve, reject) => {
		proc.on("error", reject);
		proc.on("close", () => {
			clearTimeout(watchdog);
			try {
				resolve(JSON.parse(out.trim()));
			} catch {
				reject(new Error(`child printed: ${out}`));
			}
		});
	});
}

function postLines(file: string): string[] {
	return existsSync(file)
		? readFileSync(file, "utf8").split("\n").filter(Boolean)
		: [];
}

describe("claimRound: verify N is posted at most once (its number is its chain link)", () => {
	const claim = (dir: string, signal?: AbortSignal) =>
		claimRound(dir, 1, "v-2", {
			key: TEST_RECORD_KEY,
			...(signal === undefined ? {} : { signal }),
		});
	const LIVE = { reason: "another process is posting verify 1" };
	const STALE = {
		reason:
			"round-1.claim was left by a post of verify 1 that stopped, so verify 1 is not on the PR; later rounds and the card still post",
	};

	it("a signed round-N.posted means it is on the PR already", async () => {
		const dir = record();
		writeSignedMarker(dir, "round-1.posted", "v-2");
		expect(await claim(dir)).toEqual({
			reason: "verify 1 is already on the PR",
		});
		expect(claimsIn(dir)).toEqual([]);
	});

	it("a stale claim stays where it is and is never taken over", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), staleByAge());
		const before = readFileSync(roundClaimFile(dir, 1), "utf8");
		expect(await claim(dir)).toEqual(STALE);
		expect(readFileSync(roundClaimFile(dir, 1), "utf8")).toBe(before);
	});

	it("a claim on this host whose process is gone is stale", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			host: hostname(),
			claimedAt: Date.now(),
		});
		expect(await claim(dir)).toEqual(STALE);
	});

	it("a fresh claim from another host is not judged by its pid (L2)", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			host: `not-${hostname()}`,
			claimedAt: Date.now(),
		});
		expect(await claim(dir)).toEqual(LIVE);
	});

	it("a fresh claim that names no host is judged by age alone", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			claimedAt: Date.now(),
		});
		expect(await claim(dir)).toEqual(LIVE);
	});

	it("an old claim from another host is stale by its age", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			...staleByAge(),
			host: `not-${hostname()}`,
		});
		expect(await claim(dir)).toEqual(STALE);
	});

	it("EPERM from the pid probe counts as alive (L4)", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: 424242,
			host: hostname(),
			claimedAt: Date.now(),
		});
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("operation not permitted"), {
				code: "EPERM",
			});
		});
		expect(await claim(dir)).toEqual(LIVE);
	});

	it("a claim with unreadable content is judged by its age on disk", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), "");
		expect(await claim(dir)).toEqual(LIVE);
		const old = (Date.now() - ROUND_DEADLINE_MS - 10_000) / 1000;
		utimesSync(roundClaimFile(dir, 1), old, old);
		expect(await claim(dir)).toEqual(STALE);
	});

	it("an interrupted run claims nothing, saying so", async () => {
		const dir = record();
		const controller = new AbortController();
		controller.abort();
		expect(await claim(dir, controller.signal)).toEqual({
			reason: "the run was interrupted",
		});
		expect(claimsIn(dir)).toEqual([]);
	});

	it("the claim records the verify, its pid, this host and when", async () => {
		const dir = record();
		await claim(dir);
		const info = JSON.parse(readFileSync(roundClaimFile(dir, 1), "utf8"));
		expect(info).toMatchObject({
			verifyRunId: "v-2",
			pid: process.pid,
			host: hostname(),
		});
		expect(typeof info.claimedAt).toBe("number");
	});

	it("settling a posted round writes round-N.posted and removes the claim", async () => {
		const dir = record();
		const held = await claim(dir);
		if ("reason" in held) {
			throw new Error(held.reason);
		}
		settleRound(held, true);
		expect(claimsIn(dir)).toEqual([]);
		expect(
			JSON.parse(readFileSync(roundPostedFile(dir, 1), "utf8")),
		).toMatchObject({ verifyRunId: "v-2" });
	});

	it("settling a failed post removes the claim and writes nothing", async () => {
		const dir = record();
		const held = await claim(dir);
		if ("reason" in held) {
			throw new Error(held.reason);
		}
		settleRound(held, false);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("releaseClaim only removes this verify's own claim (L4)", () => {
	it("leaves a claim another verify created at the same path", async () => {
		const dir = record();
		const claim = await claimRound(dir, 1, "v-1", {
			key: TEST_RECORD_KEY,
		});
		if ("reason" in claim) {
			throw new Error(claim.reason);
		}
		const other = {
			verifyRunId: "v-9",
			pid: process.pid,
			host: hostname(),
			claimedAt: Date.now() + 1,
		};
		seed(claim.file, other);
		releaseClaim(claim);
		expect(JSON.parse(readFileSync(claim.file, "utf8"))).toEqual(other);
	});
});

describe("close-out generations", () => {
	const nothingOnPr = () => Promise.resolve(false);

	it("the first verify creates closeout.claim-1", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
		});
		expect(got).toMatchObject({ kind: "taken" });
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});

	it("closeout.posted means already posted, without asking the PR", async () => {
		const dir = record();
		writeSignedMarker(dir, "closeout.posted", "v-0");
		const onPr = vi.fn(nothingOnPr);
		expect(
			await claimCloseout(dir, "v-1", onPr, { key: TEST_RECORD_KEY }),
		).toEqual({
			kind: "posted",
			onPr: false,
		});
		expect(onPr).not.toHaveBeenCalled();
		expect(claimsIn(dir)).toEqual([]);
	});

	it("a fresh claim means another verify is posting it", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), liveHere());
		expect(
			await claimCloseout(dir, "v-1", nothingOnPr, { key: TEST_RECORD_KEY }),
		).toEqual({
			kind: "busy",
		});
	});

	it("a stale claim with the card on the PR writes closeout.posted and stops", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), staleByAge());
		expect(
			await claimCloseout(dir, "v-1", () => Promise.resolve(true), {
				key: TEST_RECORD_KEY,
			}),
		).toEqual({ kind: "posted", onPr: true });
		expect(existsSync(closeoutPostedFile(dir))).toBe(true);
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});

	it("a stale claim without the card moves to the next generation; the stale one stays", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), staleByAge());
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
		});
		expect(got).toMatchObject({ kind: "taken" });
		expect(claimsIn(dir)).toEqual(["closeout.claim-1", "closeout.claim-2"]);
	});

	it("re-checks closeout.posted after its create, and stops when it appeared", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
			beforeCreate: () => writeSignedMarker(dir, "closeout.posted", "v-0"),
		});
		expect(got).toEqual({ kind: "posted", onPr: false });
		expect(claimsIn(dir)).toEqual([]);
	});

	it("every generation stale and no card: the claim is refused, saying why", async () => {
		const dir = record();
		for (let g = 1; g <= CLOSEOUT_GENERATIONS; g += 1) {
			seed(closeoutClaimFile(dir, g), staleByAge());
		}
		expect(
			await claimCloseout(dir, "v-1", nothingOnPr, { key: TEST_RECORD_KEY }),
		).toEqual({
			kind: "exhausted",
		});
	});

	it("settling a posted close-out writes closeout.posted and removes the claim", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
		});
		if (got.kind !== "taken") {
			throw new Error(got.kind);
		}
		settleCloseout(got.claim, true);
		expect(claimsIn(dir)).toEqual([]);
		expect(
			JSON.parse(readFileSync(closeoutPostedFile(dir), "utf8")),
		).toMatchObject({ verifyRunId: "v-1" });
	});

	it("settling a failed close-out removes the claim, so the next verify takes generation 1 again", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
		});
		if (got.kind !== "taken") {
			throw new Error(got.kind);
		}
		settleCloseout(got.claim, false);
		expect(readdirSync(dir)).toEqual([]);
		expect(
			await claimCloseout(dir, "v-2", nothingOnPr, { key: TEST_RECORD_KEY }),
		).toMatchObject({
			kind: "taken",
		});
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});
});

describe("close-out across processes over a stale claim", () => {
	it("five concurrent verifies, all judging a stale closeout.claim-1 before any acts, post exactly one card", async () => {
		for (let trial = 0; trial < 3; trial += 1) {
			const dir = record();
			seed(closeoutClaimFile(dir, 1), staleByAge());
			const posts = path.join(dir, "posts");
			const release = path.join(dir, "release");
			const ids = ["v-1", "v-2", "v-3", "v-4", "v-5"];
			const parked = (id: string) => path.join(dir, `parked-${id}`);
			const runs = ids.map((id) =>
				child({
					kind: "closeout",
					dir,
					id,
					posts,
					parkInCardCheck: true,
					parked: parked(id),
					release,
					postMs: 5,
				}),
			);
			// Every verify has judged claim-1 stale and is in its PR check.
			const until = Date.now() + 20_000;
			while (!ids.every((id) => existsSync(parked(id)))) {
				if (Date.now() > until) {
					throw new Error("the verifies did not all reach the PR check");
				}
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			writeFileSync(release, "");
			const results = await Promise.all(runs);
			expect(postLines(posts)).toHaveLength(1);
			expect(
				results.filter(
					(result) => (result as { kind?: string }).kind === "card-posted",
				),
			).toHaveLength(1);
			expect(existsSync(closeoutPostedFile(dir))).toBe(true);
			expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
		}
	}, 60_000);

	it("a verify parked before creating generation 2 while another posts and settles it stops at closeout.posted", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), staleByAge());
		const posts = path.join(dir, "posts");
		const at = (name: string) => path.join(dir, `barrier-${name}`);
		const [late, winner] = await Promise.all([
			child({
				kind: "closeout",
				dir,
				id: "v-late",
				posts,
				parkAt: 2,
				parked: at("late-parked"),
				release: at("winner-settled"),
			}),
			child({
				kind: "closeout",
				dir,
				id: "v-winner",
				posts,
				startAfter: at("late-parked"),
				settled: at("winner-settled"),
			}),
		]);
		expect(winner).toEqual({ kind: "card-posted" });
		expect(late).toEqual({ kind: "posted", onPr: false });
		expect(postLines(posts)).toEqual(["v-winner close-out"]);
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	}, 30_000);
});

describe("posted markers are signed (T502)", () => {
	const nothingOnPr = () => Promise.resolve(false);

	it("an unsigned round-1.posted is no marker: verify 1 is claimed, and settling replaces it with a signed one", async () => {
		const dir = record();
		seed(roundPostedFile(dir, 1), { verifyRunId: "v-0", postedAt: 1 });
		const claim = await claimRound(dir, 1, "v-2", {
			key: TEST_RECORD_KEY,
		});
		if ("reason" in claim) {
			throw new Error(claim.reason);
		}
		expect(claim.round).toBe(1);
		settleRound(claim, true);
		expect(isSignedMarker(roundPostedFile(dir, 1), TEST_RECORD_KEY)).toBe(true);
		expect(claimsIn(dir)).toEqual([]);
		expect(
			await claimRound(dir, 1, "v-2", {
				key: TEST_RECORD_KEY,
			}),
		).toEqual({ reason: "verify 1 is already on the PR" });
	});

	it("a signed marker is bound to its round, its record and the key", async () => {
		const dir = record();
		writeSignedMarker(dir, "round-1.posted", "v-1");
		expect(isSignedMarker(roundPostedFile(dir, 1), TEST_RECORD_KEY)).toBe(true);
		// Copied to round 2: not a marker there.
		writeFileSync(
			roundPostedFile(dir, 2),
			readFileSync(roundPostedFile(dir, 1)),
		);
		expect(isSignedMarker(roundPostedFile(dir, 2), TEST_RECORD_KEY)).toBe(
			false,
		);
		// Copied to another review's record: not a marker there.
		const other = record();
		writeFileSync(
			roundPostedFile(other, 1),
			readFileSync(roundPostedFile(dir, 1)),
		);
		expect(isSignedMarker(roundPostedFile(other, 1), TEST_RECORD_KEY)).toBe(
			false,
		);
		// Another owner's key: not a marker.
		expect(isSignedMarker(roundPostedFile(dir, 1), Buffer.alloc(32, 9))).toBe(
			false,
		);
		// Renamed to closeout.posted: not a marker.
		writeFileSync(
			closeoutPostedFile(dir),
			readFileSync(roundPostedFile(dir, 1)),
		);
		expect(isSignedMarker(closeoutPostedFile(dir), TEST_RECORD_KEY)).toBe(
			false,
		);
	});

	it("an unsigned closeout.posted does not stop the close-out, and settling replaces it", async () => {
		const dir = record();
		seed(closeoutPostedFile(dir), "{}");
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			key: TEST_RECORD_KEY,
		});
		if (got.kind !== "taken") {
			throw new Error(got.kind);
		}
		settleCloseout(got.claim, true);
		expect(isSignedMarker(closeoutPostedFile(dir), TEST_RECORD_KEY)).toBe(true);
		expect(
			await claimCloseout(dir, "v-2", nothingOnPr, { key: TEST_RECORD_KEY }),
		).toEqual({ kind: "posted", onPr: false });
	});
});

describe("claimChain (S-2)", () => {
	it("checks the chain again after the create, and gives the claim back when a verify finished in between", () => {
		const dir = record();
		expect(() =>
			claimChain(dir, "prior", "verify-b", () => {
				throw new Error(
					'Verify refused: review "prior" has been verified already; verify against the latest verify, "verify-a"',
				);
			}),
		).toThrow('verify against the latest verify, "verify-a"');
		expect(existsSync(chainClaimFile(dir, "prior", 1))).toBe(false);
	});

	it("a live claim is checked against the chain too, so a finished verify is named as the latest", () => {
		const dir = record();
		const first = claimChain(dir, "prior", "verify-a", () => undefined);
		expect(() =>
			claimChain(dir, "prior", "verify-b", () => {
				throw new Error('verify against the latest verify, "verify-a"');
			}),
		).toThrow('verify against the latest verify, "verify-a"');
		first.release();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("past 100 stale claims it refuses, saying to delete them (F-5)", () => {
		const dir = record();
		for (let generation = 1; generation <= 100; generation += 1) {
			writeFileSync(
				chainClaimFile(dir, "prior", generation),
				JSON.stringify({
					verifyRunId: `v-${generation}`,
					pid: 1,
					host: "elsewhere",
					claimedAt: 1,
				}),
			);
		}
		expect(() => claimChain(dir, "prior", "verify-b", () => undefined)).toThrow(
			'Verify refused: 100 stale chain-prior.claim files are in the review\'s run record; delete them to verify from "prior"',
		);
	});

	it("refreshes only its own claim, and releases only its own", () => {
		const dir = record();
		const held = claimChain(dir, "prior", "verify-a", () => undefined);
		const file = chainClaimFile(dir, "prior", 1);
		const before = JSON.parse(readFileSync(file, "utf8")).claimedAt as number;
		vi.spyOn(Date, "now").mockReturnValue(before + 30_000);
		held.refresh();
		expect(JSON.parse(readFileSync(file, "utf8")).claimedAt).toBe(
			before + 30_000,
		);
		writeFileSync(
			file,
			JSON.stringify({ verifyRunId: "other", pid: 1, host: "x", claimedAt: 1 }),
		);
		held.refresh();
		held.release();
		expect(JSON.parse(readFileSync(file, "utf8")).verifyRunId).toBe("other");
	});
});
