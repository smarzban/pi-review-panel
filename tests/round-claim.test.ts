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
	claimCloseout,
	claimRound,
	closeoutClaimFile,
	closeoutPostedFile,
	POST_RESERVE_MS,
	ROUND_DEADLINE_MS,
	releaseClaim,
	roundClaimFile,
	roundPostedFile,
	settleCloseout,
	settleRound,
} from "../src/tool/round-claim.js";

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

describe("round numbers across processes (regression-1-1)", () => {
	it("a verify between its posted check and its create, while another posts and settles that round, takes the next number", async () => {
		const dir = record();
		const posts = path.join(dir, "posts");
		const at = (name: string) => path.join(dir, `barrier-${name}`);
		const [a, b] = await Promise.all([
			child({
				kind: "round",
				dir,
				id: "v-a",
				posts,
				claimed: at("a-claimed"),
				postAfter: at("b-parked"),
				settled: at("a-settled"),
			}),
			child({
				kind: "round",
				dir,
				id: "v-b",
				posts,
				startAfter: at("a-claimed"),
				parkAt: 1,
				parked: at("b-parked"),
				release: at("a-settled"),
			}),
		]);
		expect(a).toEqual([{ round: 1 }]);
		expect(b).toEqual([{ round: 2 }]);
		expect(postLines(posts)).toEqual(["v-a verify 1", "v-b verify 2"]);
		expect(claimsIn(dir)).toEqual([]);
		expect(existsSync(roundPostedFile(dir, 1))).toBe(true);
		expect(existsSync(roundPostedFile(dir, 2))).toBe(true);
	});

	it("several processes claiming many rounds, some posts failing, never post one number twice", async () => {
		for (let trial = 0; trial < 3; trial += 1) {
			const dir = record();
			const posts = path.join(dir, "posts");
			const go = path.join(dir, "go");
			const runs = ["v-1", "v-2", "v-3", "v-4"].map((id, index) =>
				child({
					kind: "round",
					dir,
					id,
					posts,
					startAfter: go,
					rounds: 3,
					postMs: 1 + ((index * 3 + trial) % 4),
					failPosts: index === trial ? [2] : [],
				}),
			);
			writeFileSync(go, "");
			await Promise.all(runs);
			const numbers = postLines(posts).map((line) =>
				Number(line.split(" ").at(-1)),
			);
			expect(numbers).toHaveLength(11);
			expect(new Set(numbers).size).toBe(numbers.length);
			expect(claimsIn(dir)).toEqual([]);
		}
	}, 60_000);
});

describe("claimRound", () => {
	it("re-checks round-N.posted after its create, and moves on when it appeared", async () => {
		const dir = record();
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
			beforeCreate: (round) => {
				if (round === 1) {
					// Another verify posts and settles verify 1 just now.
					writeFileSync(roundPostedFile(dir, 1), "{}");
				}
			},
		});
		expect(claim).toMatchObject({ round: 2 });
		expect(claimsIn(dir)).toEqual(["round-2.claim"]);
	});

	it("a stale round claim stays where it is and is skipped: a gap, no duplicate", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), staleByAge());
		const before = readFileSync(roundClaimFile(dir, 1), "utf8");
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		expect(claim).toMatchObject({ round: 2 });
		expect(readFileSync(roundClaimFile(dir, 1), "utf8")).toBe(before);
		if ("reason" in claim) {
			throw new Error(claim.reason);
		}
		settleRound(claim, true);
		expect(existsSync(roundPostedFile(dir, 1))).toBe(false);
		expect(existsSync(roundPostedFile(dir, 2))).toBe(true);
		expect(claimsIn(dir)).toEqual(["round-1.claim"]);
	});

	it("a claim on this host whose process is gone is stale: skipped", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			host: hostname(),
			claimedAt: Date.now(),
		});
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		expect(claim).toMatchObject({ round: 2 });
	});

	it("a fresh claim from another host is not judged by its pid (L2)", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			host: `not-${hostname()}`,
			claimedAt: Date.now(),
		});
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 150,
			reserveMs: 0,
			pollMs: 20,
		});
		expect(claim).toEqual({
			reason: "another verify is still posting verify 1",
		});
	});

	it("a fresh claim that names no host is judged by age alone", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			verifyRunId: "v-0",
			pid: deadPid(),
			claimedAt: Date.now(),
		});
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 150,
			reserveMs: 0,
			pollMs: 20,
		});
		expect(claim).toMatchObject({
			reason: "another verify is still posting verify 1",
		});
	});

	it("an old claim from another host is stale by its age", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), {
			...staleByAge(),
			host: `not-${hostname()}`,
		});
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		expect(claim).toMatchObject({ round: 2 });
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
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 150,
			reserveMs: 0,
			pollMs: 20,
		});
		expect(claim).toEqual({
			reason: "another verify is still posting verify 1",
		});
	});

	it("a fresh claim with unreadable content is held, judged by its age on disk", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), "");
		const held = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 150,
			reserveMs: 0,
			pollMs: 20,
		});
		expect(held).toMatchObject({
			reason: "another verify is still posting verify 1",
		});
		const old = (Date.now() - ROUND_DEADLINE_MS - 10_000) / 1000;
		utimesSync(roundClaimFile(dir, 1), old, old);
		const skipped = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		expect(skipped).toMatchObject({ round: 2 });
	});

	it("takes the live claim's number once that post fails and gives it back", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), liveHere());
		setTimeout(() => rmSync(roundClaimFile(dir, 1), { force: true }), 60);
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
			pollMs: 20,
		});
		expect(claim).toMatchObject({ round: 1 });
	});

	it("stops waiting while 30 s of the round deadline remain (L3)", async () => {
		expect(POST_RESERVE_MS).toBe(30_000);
		const dir = record();
		seed(roundClaimFile(dir, 1), liveHere());
		const started = Date.now();
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + POST_RESERVE_MS + 200,
			pollMs: 20,
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(claim).toEqual({
			reason: "another verify is still posting verify 1",
		});
		expect(claimsIn(dir)).toEqual(["round-1.claim"]);
	});

	it("with more than 30 s left it keeps waiting and takes the number", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), liveHere());
		setTimeout(() => rmSync(roundClaimFile(dir, 1), { force: true }), 300);
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + POST_RESERVE_MS + 5_000,
			pollMs: 20,
		});
		expect(claim).toMatchObject({ round: 1 });
	});

	it("a claim it can take right away is taken even inside the last 30 s", async () => {
		const dir = record();
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 1_000,
			pollMs: 20,
		});
		expect(claim).toMatchObject({ round: 1 });
	});

	it("an interrupted run stops waiting, saying so", async () => {
		const dir = record();
		seed(roundClaimFile(dir, 1), liveHere());
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 40);
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 10_000,
			reserveMs: 0,
			pollMs: 20,
			signal: controller.signal,
		});
		expect(claim).toEqual({ reason: "the run was interrupted" });
	});

	it("the claim records the verify, its pid, this host and when", async () => {
		const dir = record();
		await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
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
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		if ("reason" in claim) {
			throw new Error(claim.reason);
		}
		settleRound(claim, true);
		expect(claimsIn(dir)).toEqual([]);
		expect(
			JSON.parse(readFileSync(roundPostedFile(dir, 1), "utf8")),
		).toMatchObject({ verifyRunId: "v-2" });
	});

	it("settling a failed post removes the claim and writes nothing", async () => {
		const dir = record();
		const claim = await claimRound(dir, 1, "v-2", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
		});
		if ("reason" in claim) {
			throw new Error(claim.reason);
		}
		settleRound(claim, false);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("releaseClaim only removes this verify's own claim (L4)", () => {
	it("leaves a claim another verify created at the same path", async () => {
		const dir = record();
		const claim = await claimRound(dir, 1, "v-1", {
			deadline: Date.now() + 5_000,
			reserveMs: 0,
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
		const got = await claimCloseout(dir, "v-1", nothingOnPr);
		expect(got).toMatchObject({ kind: "taken" });
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});

	it("closeout.posted means already posted, without asking the PR", async () => {
		const dir = record();
		seed(closeoutPostedFile(dir), "{}");
		const onPr = vi.fn(nothingOnPr);
		expect(await claimCloseout(dir, "v-1", onPr)).toEqual({
			kind: "posted",
			onPr: false,
		});
		expect(onPr).not.toHaveBeenCalled();
		expect(claimsIn(dir)).toEqual([]);
	});

	it("a fresh claim means another verify is posting it", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), liveHere());
		expect(await claimCloseout(dir, "v-1", nothingOnPr)).toEqual({
			kind: "busy",
		});
	});

	it("a stale claim with the card on the PR writes closeout.posted and stops", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), staleByAge());
		expect(
			await claimCloseout(dir, "v-1", () => Promise.resolve(true)),
		).toEqual({ kind: "posted", onPr: true });
		expect(existsSync(closeoutPostedFile(dir))).toBe(true);
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});

	it("a stale claim without the card moves to the next generation; the stale one stays", async () => {
		const dir = record();
		seed(closeoutClaimFile(dir, 1), staleByAge());
		const got = await claimCloseout(dir, "v-1", nothingOnPr);
		expect(got).toMatchObject({ kind: "taken" });
		expect(claimsIn(dir)).toEqual(["closeout.claim-1", "closeout.claim-2"]);
	});

	it("re-checks closeout.posted after its create, and stops when it appeared", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr, {
			beforeCreate: () => writeFileSync(closeoutPostedFile(dir), "{}"),
		});
		expect(got).toEqual({ kind: "posted", onPr: false });
		expect(claimsIn(dir)).toEqual([]);
	});

	it("every generation stale and no card: the claim is refused, saying why", async () => {
		const dir = record();
		for (let g = 1; g <= CLOSEOUT_GENERATIONS; g += 1) {
			seed(closeoutClaimFile(dir, g), staleByAge());
		}
		expect(await claimCloseout(dir, "v-1", nothingOnPr)).toEqual({
			kind: "exhausted",
		});
	});

	it("settling a posted close-out writes closeout.posted and removes the claim", async () => {
		const dir = record();
		const got = await claimCloseout(dir, "v-1", nothingOnPr);
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
		const got = await claimCloseout(dir, "v-1", nothingOnPr);
		if (got.kind !== "taken") {
			throw new Error(got.kind);
		}
		settleCloseout(got.claim, false);
		expect(readdirSync(dir)).toEqual([]);
		expect(await claimCloseout(dir, "v-2", nothingOnPr)).toMatchObject({
			kind: "taken",
		});
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});
});

describe("close-out across processes over a stale claim", () => {
	it("five concurrent verifies over a stale closeout.claim-1 post exactly one card", async () => {
		for (let trial = 0; trial < 4; trial += 1) {
			const dir = record();
			seed(closeoutClaimFile(dir, 1), staleByAge());
			const posts = path.join(dir, "posts");
			const go = path.join(dir, "go");
			const runs = [1, 2, 3, 4, 5].map((n) =>
				child({
					kind: "closeout",
					dir,
					id: `v-${n}`,
					posts,
					startAfter: go,
					postMs: 5,
				}),
			);
			writeFileSync(go, "");
			const results = await Promise.all(runs);
			expect(postLines(posts)).toHaveLength(1);
			expect(
				results.filter(
					(result) => (result as { kind?: string }).kind === "posted",
				),
			).toHaveLength(1);
			expect(existsSync(closeoutPostedFile(dir))).toBe(true);
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
		expect(winner).toEqual({ kind: "posted" });
		expect(late).toEqual({ kind: "posted", onPr: false });
		expect(postLines(posts)).toEqual(["v-winner close-out"]);
		expect(claimsIn(dir)).toEqual(["closeout.claim-1"]);
	});
});
