import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ActionDependencies,
	type ActionResult,
	commentAction,
	parseVerifyArguments,
	verifyAction,
} from "../src/actions/actions.js";
import { coerceCallArguments } from "../src/actions/call.js";
import { parseCommand } from "../src/cli/args.js";
import type { Config } from "../src/config/schema.js";
import { COMPLETE_MARKER } from "../src/run/record.js";
import {
	planRecheckSeats,
	runVerify,
	VerifyCancelledError,
} from "../src/run/run-verify.js";
import type { StampedFinding } from "../src/run/types.js";
import { loadVerifyChain } from "../src/run/verify-chain.js";
import type { SdkSessionFactory } from "../src/seat/run-seat.js";
import type { SeatSpec } from "../src/seat/sdk-session.js";
import {
	findCloseoutPr,
	type PostCloseoutInput,
} from "../src/tool/closeout-post.js";
import type { RoundGhRunner } from "../src/tool/round-post.js";
import { signReviewRecord, TEST_RECORD_KEY } from "./fixtures/record-key.js";

/**
 * T509: `verify --recheck <lenses>` runs review-lens seats over this round's
 * diff alongside the fix-verification seat. What they find gets `V<N>-F<k>`
 * ids, is recorded in the signed verify record, and is open like any id.
 *
 * Every seat here, verify and recheck alike, runs through the real seat
 * runner and its real submit tool (`submit_verification`,
 * `submit_findings`); only the SDK session is a script, which calls that
 * tool. Nothing here reaches GitHub: gh is a script.
 */

const REPO_SLUG = "smarzban/demo";
const REVIEW = "2026-11-16T10-00-00-000Z-main-review";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function finding(
	id: string,
	severity: "high" | "medium" | "low",
	title: string,
): StampedFinding {
	return {
		id,
		seat: {
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			lens: "holistic",
		},
		finding: { file: "src/cache.ts", line: 3, severity, title, evidence: "e" },
	};
}

const FINDINGS = [
	finding("F-1", "high", "cache key misses the tenant"),
	finding("F-2", "medium", "retry loop never backs off"),
];

const CONFIG: Config = {
	roster: [
		{ id: "terra", provider: "openai-codex", model: "gpt-5.6-terra" },
		{ id: "opus", provider: "anthropic", model: "claude-opus-5-5" },
		{ id: "luna", provider: "google", model: "gemini-luna" },
	],
	defaults: { seats: ["terra", "opus"] },
};

type Row = {
	file: string;
	line: number;
	severity: "high" | "medium" | "low";
	title: string;
	evidence: string;
};

/** What each recheck seat submits, by lens; `lost` makes it fail. */
let recheckScript: Map<
	string,
	Row[] | "lost" | "hold" | { tries: unknown[][] }
>;
/** Called when a `hold` seat starts waiting, with how many wait now. */
let onHold: (waiting: number) => void;
/** Lenses of the sessions the runner aborted. */
let abortedLenses: string[];
/** Prompts still running, across every session. */
let activePrompts: number;
/** Sessions waiting in a `hold`. */
let holding: number;
/** Each verify seat's disposition per id; resolved when not named. */
let verifyScript: Map<string, "resolved" | "still present">;
/** Every session the runner opened, with its spec and its prompt. */
let sessions: Array<{ spec: SeatSpec; prompt: string; tools: string[] }>;
/** Tool errors a submission got. */
let refusals: string[];

let root: string;
let repo: string;
/** The pinned snapshot folder every seat must run in. */
let pinned: string;
/** The head each pin was asked for. */
let pins: string[];
/** The prompts still running when each snapshot was released. */
let releases: number[];
let commits: string[];
let comments: Array<{
	id: number;
	html_url: string;
	body: string;
	user: { login: string };
}>;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "verify-recheck-"));
	repo = path.join(root, "repo");
	mkdirSync(repo);
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "recheck@example.test"]);
	git(repo, ["config", "user.name", "Recheck Test"]);
	commits = [];
	for (const name of ["base", "head", "fix1", "fix2", "fix3"]) {
		writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", name, "--quiet"]);
		commits.push(git(repo, ["rev-parse", "HEAD"]));
	}
	repo = realpathSync(repo);
	pinned = path.join(root, "pinned");
	mkdirSync(pinned);
	pins = [];
	releases = [];
	const recordPath = path.join(repo, ".review-panel", "runs", REVIEW);
	mkdirSync(recordPath, { recursive: true });
	writeFileSync(
		path.join(recordPath, "meta.json"),
		JSON.stringify({
			runId: REVIEW,
			baseRef: "main",
			baseOid: commits[0],
			headOid: commits[1],
		}),
	);
	writeFileSync(
		path.join(recordPath, "panel.json"),
		JSON.stringify({
			runId: REVIEW,
			baseRef: "main",
			seats: [
				{
					rosterId: "terra",
					lens: "holistic",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
				},
			],
		}),
	);
	writeFileSync(
		path.join(recordPath, "findings.json"),
		JSON.stringify(FINDINGS),
	);
	writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
	signReviewRecord(recordPath);
	recheckScript = new Map();
	onHold = () => undefined;
	abortedLenses = [];
	activePrompts = 0;
	holding = 0;
	verifyScript = new Map();
	sessions = [];
	refusals = [];
	comments = [];
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type Tool = {
	name: string;
	execute: (
		id: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: unknown,
	) => Promise<unknown>;
};

/**
 * An SDK session script: it calls the seat's real submit tool with the
 * answer this test scripted for the seat's lens. It supplies no row past
 * that tool: what it submits crosses the production validation.
 */
const factory: SdkSessionFactory = async (input) => {
	const spec = input.spec as SeatSpec;
	const tools = input.tools as unknown as Tool[];
	const entry = { spec, prompt: "", tools: tools.map((tool) => tool.name) };
	sessions.push(entry);
	let submitted = false;
	let release: (() => void) | undefined;
	const prompt = async (text: string) => {
		entry.prompt ||= text;
		if (submitted) {
			return;
		}
		if (recheckScript.get(spec.lens) === "hold") {
			// Waits until the runner aborts this session.
			const waiting = new Promise<void>((resolve) => {
				release = resolve;
			});
			holding += 1;
			onHold(holding);
			await waiting;
			return;
		}
		const tool = tools.find((row) => row.name.startsWith("submit_"));
		if (tool === undefined) {
			throw new Error("no submit tool");
		}
		let tries: Array<Record<string, unknown>>;
		if (
			(spec.profile as { kind?: string } | undefined)?.kind === "verification"
		) {
			tries = [
				{
					items: (spec.expectedIds ?? []).map((id) => {
						const disposition = verifyScript.get(id) ?? "resolved";
						return {
							id,
							disposition,
							...(disposition === "resolved"
								? {
										evidence: {
											file: "src/cache.ts",
											explanation: `${id} holds at line 3`,
										},
									}
								: {}),
						};
					}),
					regressions: [],
				},
			];
		} else {
			const script = recheckScript.get(spec.lens) ?? [];
			if (script === "lost" || script === "hold") {
				throw new Error("injected provider failure");
			}
			tries = Array.isArray(script)
				? [{ findings: script }]
				: script.tries.map((findings) => ({ findings }));
		}
		// Each try is a submission; a refused one is followed by the
		// next, as a model would after a tool error.
		for (const args of tries) {
			try {
				await tool.execute(
					"scripted",
					args,
					new AbortController().signal,
					() => undefined,
					{},
				);
				submitted = true;
				return;
			} catch (error) {
				refusals.push(error instanceof Error ? error.message : String(error));
			}
		}
	};
	return {
		session: {
			async prompt(text: string) {
				activePrompts += 1;
				try {
					await prompt(text);
				} finally {
					activePrompts -= 1;
				}
			},
			async abort() {
				abortedLenses.push(spec.lens);
				release?.();
			},
			dispose() {},
			getSessionStats() {
				return {
					tokens: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						total: 2,
					},
					cost: 0,
				};
			},
		},
	} as never;
};

/** The head PR 12 was last asked about. */
let prHead = "";

const runGh: RoundGhRunner = (args, options) => {
	const joined = args.join(" ");
	if (args[0] === "api" && args[1] === "user") {
		return "saeed\n";
	}
	if (args[0] === "repo" && args[1] === "view") {
		return `${REPO_SLUG}\n`;
	}
	const head = /commits\/([0-9a-f]+)\/pulls/.exec(joined);
	if (head !== null) {
		prHead = head[1] as string;
		return JSON.stringify([
			{ number: 12, state: "open", head: { sha: head[1] } },
		]);
	}
	if (/issues\/12\/comments/.test(joined) && joined.includes("POST")) {
		const id = 100 + comments.length + 1;
		const body = (JSON.parse(options?.input ?? "{}") as { body: string }).body;
		const html_url = `https://github.com/${REPO_SLUG}/pull/12#issuecomment-${id}`;
		comments.push({ id, html_url, body, user: { login: "saeed" } });
		return JSON.stringify({ id, html_url });
	}
	if (/repos\/[^/]+\/[^/]+\/pulls\/12$/.test(args[1] ?? "")) {
		return JSON.stringify({ number: 12, state: "open", head: { sha: prHead } });
	}
	if (/issues\/12\/comments/.test(joined)) {
		return JSON.stringify(comments);
	}
	throw new Error(`unexpected gh ${joined}`);
};

/**
 * A pinned snapshot apart from the repository, so a seat run in the host
 * checkout instead is seen. A release records the prompts still running.
 */
function pin(_repoDir: string, head?: string) {
	pins.push(head ?? "");
	return {
		worktreePath: pinned,
		release: () => {
			releases.push(activePrompts);
			return { ok: true as const };
		},
	};
}

function deps(): ActionDependencies {
	return {
		env: {},
		home: "/tmp/verify-recheck-home",
		diagnose: async () => ({ ready: true, rows: [] }),
		loadConfig: () => CONFIG,
		recordKey: () => TEST_RECORD_KEY,
		checkRecordKey: () => undefined,
		runGh,
		runVerify: (input, options) =>
			runVerify(input, {
				...options,
				sessionFactory: factory,
				pinSnapshot: pin,
			}),
	};
}

function textOf(result: ActionResult): string {
	return result.content[0]?.text ?? "";
}

function recordOf(reply: string): string {
	const found = /^Record: `(.+)`$/mu.exec(reply);
	expect(found).not.toBeNull();
	return path.basename(found?.[1] ?? "");
}

async function verify(args: Record<string, unknown>) {
	const before = sessions.length;
	const reply = textOf(
		await verifyAction(
			{ repoDir: repo, ...(args as { priorRunId: string; head: string }) },
			{ deps: deps() },
		),
	);
	const runId = recordOf(reply);
	const bodies = comments
		.map((row) => row.body)
		.filter((body) => body.split("\n").at(-1)?.includes(`verify=${runId}`));
	return {
		reply,
		runId,
		body: bodies[0] ?? "",
		seats: sessions.slice(before),
	};
}

function verificationOf(runId: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(
			path.join(repo, ".review-panel", "runs", runId, "verification.json"),
			"utf8",
		),
	) as Record<string, unknown>;
}

const LEAK: Row = {
	file: "src/log.ts",
	line: 7,
	severity: "medium",
	title: "the new retry log prints the token",
	evidence: "logger.info(token) on every retry",
};

const NIT: Row = {
	file: "src/retry.ts",
	line: 2,
	severity: "low",
	title: "backoff constant is unnamed",
	evidence: "a bare 250 in the loop",
};

/** Verify 1 at fix1, keeping both findings. */
function first(extra: Record<string, unknown> = {}) {
	return verify({
		priorRunId: REVIEW,
		head: commits[2],
		keptFindingIds: ["F-1", "F-2"],
		...extra,
	});
}

describe("verify without --recheck", () => {
	it("is exactly as before: no recheck seat, no recheck key, no recheck text", async () => {
		const v1 = await first();
		expect(v1.seats.map((row) => row.spec.lens)).toEqual(["fix-verification"]);
		expect(Object.keys(verificationOf(v1.runId))).toEqual([
			"priorRunId",
			"keptFindingIds",
			"dismissed",
			"lowAdvisory",
			"outcomes",
		]);
		expect(v1.body.split("\n")).toEqual([
			"## Review panel · verify 1",
			`\`${commits[1]?.slice(0, 7)}\` → \`${commits[2]?.slice(0, 7)}\``,
			"1/1 voted · F-1 resolved, F-2 resolved · no regressions",
			"**Seats:** fix-verification (terra)",
			"**Open after this round:** none",
			"",
			"### Kept",
			"- **F-1 resolved** — cache key misses the tenant — `src/cache.ts`: F-1 holds at line 3",
			"- **F-2 resolved** — retry loop never backs off — `src/cache.ts`: F-2 holds at line 3",
			"",
			`<!-- review-panel review=${REVIEW} verify=${v1.runId} -->`,
		]);
		expect(v1.reply).not.toMatch(/Recheck \(|New in this round/u);
	});
});

describe("verify --recheck", () => {
	it("is a CLI flag and a call argument, as a lens list", () => {
		const parsed = parseCommand([
			"verify",
			"--prior-run-id",
			REVIEW,
			"--head",
			"HEAD",
			"--recheck",
			"tests,security",
		]);
		expect(parsed).toMatchObject({
			kind: "action",
			action: "verify",
			args: { recheck: ["tests", "security"] },
		});
		expect(
			parseVerifyArguments(
				coerceCallArguments({
					action: "verify",
					priorRunId: REVIEW,
					head: "HEAD",
					recheck: "security",
				}),
			).recheck,
		).toEqual(["security"]);
		expect(() =>
			parseVerifyArguments({ priorRunId: REVIEW, head: "HEAD", recheck: [] }),
		).toThrow(/recheck/u);
		expect(() =>
			parseVerifyArguments({
				priorRunId: REVIEW,
				head: "HEAD",
				recheck: 7,
			}),
		).toThrow(/recheck/u);
	});

	it("plans one seat per lens on the owner's default seats, specialists on the first two like review, never the caller's seats", () => {
		// Three default seats: a specialist runs on the first two only,
		// holistic on all three.
		const three: Config = {
			...CONFIG,
			defaults: { seats: ["terra", "opus", "luna"] },
		};
		const seats = planRecheckSeats(three, ["security", "holistic"]);
		expect(seats.map((row) => `${row.rosterId}/${row.lens}`)).toEqual([
			"terra/security",
			"opus/security",
			"terra/holistic",
			"opus/holistic",
			"luna/holistic",
		]);
		expect(() => planRecheckSeats(CONFIG, ["vibes"])).toThrow(
			'Verify refused: unknown recheck lens "vibes"',
		);
		expect(() => planRecheckSeats(CONFIG, ["fix-verification"])).toThrow(
			'Verify refused: unknown recheck lens "fix-verification"',
		);
		expect(() => planRecheckSeats(CONFIG, ["tests", "tests"])).toThrow(
			'Verify refused: recheck lens "tests" is listed twice',
		);
	});

	it("a finding gets V<N>-F<k>, is posted and open; the next verify checks it; the card shows it resolved", async () => {
		recheckScript.set("tests", [LEAK]);
		const v1 = await first({ recheck: ["tests"], seats: ["luna"] });
		// The caller's seats pick the verify seat only; recheck seats are the
		// owner's defaults.
		expect(
			v1.seats.map((row) => `${row.spec.model}/${row.spec.lens}`).sort(),
		).toEqual([
			"claude-opus-5-5/tests",
			"gemini-luna/fix-verification",
			"gpt-5.6-terra/tests",
		]);
		// Every seat, recheck seats included, ran in the snapshot pinned at
		// the verify's head, never in the host checkout.
		expect(pins).toEqual([commits[2]]);
		expect(v1.seats.map((row) => row.spec.worktree)).toEqual([
			pinned,
			pinned,
			pinned,
		]);
		// Two seats, one finding each: numbered across seats in order.
		const lines = v1.body.split("\n");
		expect(lines.slice(0, 5)).toEqual([
			"## Review panel · verify 1",
			`\`${commits[1]?.slice(0, 7)}\` → \`${commits[2]?.slice(0, 7)}\``,
			"1/1 voted · F-1 resolved, F-2 resolved · no regressions",
			"**Seats:** fix-verification (luna), tests (terra, opus)",
			"**Open after this round:** V1-F1, V1-F2",
		]);
		const section = lines.indexOf("**New in this round (recheck: tests):**");
		expect(section).toBeGreaterThan(0);
		expect(lines.slice(section, section + 5)).toEqual([
			"**New in this round (recheck: tests):**",
			"- **V1-F1 [medium]** the new retry log prints the token (`src/log.ts:7`) — terra/tests",
			"  **Evidence:** logger.info(token) on every retry",
			"- **V1-F2 [medium]** the new retry log prints the token (`src/log.ts:7`) — opus/tests",
			"  **Evidence:** logger.info(token) on every retry",
		]);
		expect(v1.body).not.toMatch(/fixed|ready to merge/iu);
		// The reply says the same.
		expect(v1.reply).toContain("New in this round (recheck: tests):");
		expect(v1.reply).toContain(
			"- V1-F1 [medium] the new retry log prints the token (src/log.ts:7) — terra/tests",
		);
		// Signed, and read back with the same ids.
		const chain = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY);
		expect(chain[0]?.recheck?.findings.map((row) => row.id)).toEqual([
			"V1-F1",
			"V1-F2",
		]);
		expect(chain[0]?.recheck?.lenses).toEqual(["tests"]);

		// Verify 2 names no kept ids: it checks what is open, the recheck
		// findings included; V1-F2 is dismissed as the same as V1-F1.
		recheckScript.clear();
		const v2 = await verify({
			priorRunId: v1.runId,
			head: commits[3],
			dismissed: [{ id: "V1-F2", reason: "same leak as V1-F1" }],
			closeOut: true,
		});
		const check = v2.seats.find((row) => row.spec.lens === "fix-verification");
		expect(check?.spec.expectedIds).toEqual(["V1-F1"]);
		// Verify 2's own seat, then the final check's: no recheck seat.
		expect(v2.seats.map((row) => row.spec.lens)).toEqual([
			"fix-verification",
			"fix-verification",
		]);
		// The final check guards the resolved recheck id like any other.
		expect(v2.seats[1]?.spec.undoableIds).toEqual(["F-1", "F-2", "V1-F1"]);
		const card = comments
			.map((row) => row.body)
			.find((body) => body.startsWith("## Review panel · close-out"));
		expect(card).toBeDefined();
		const list = (card ?? "")
			.split("\n")
			.filter((line) => line.startsWith("- "));
		expect(list).toEqual([
			"- **F-1 [high]** cache key misses the tenant · resolved in verify 1",
			"- **F-2 [medium]** retry loop never backs off · resolved in verify 1",
			"- **V1-F1 [medium]** the new retry log prints the token · resolved in verify 2",
			"- **V1-F2** the new retry log prints the token — same leak as V1-F1",
		]);
	});

	it("a recheck finding blocks --close-out in the round that found it", async () => {
		recheckScript.set("security", [LEAK]);
		const v1 = await first({ recheck: ["security"], closeOut: true });
		expect(v1.reply).toMatch(/^PR close-out: not posted/mu);
		expect(
			comments.some((row) =>
				row.body.startsWith("## Review panel · close-out"),
			),
		).toBe(false);
	});

	it("recheck ids work in --low-advisory (a low) and are refused there when medium", async () => {
		recheckScript.set("tests", [NIT, LEAK]);
		const v1 = await first({ recheck: ["tests"] });
		expect(v1.body).toContain(
			"**Open after this round:** V1-F1, V1-F2, V1-F3, V1-F4",
		);
		await expect(
			verifyAction(
				{
					repoDir: repo,
					priorRunId: v1.runId,
					head: commits[3] as string,
					lowAdvisory: ["V1-F2"],
				},
				{ deps: deps() },
			),
		).rejects.toThrow(
			"Verify refused: V1-F2 is medium; a high/medium finding that is not kept must be dismissed with a reason",
		);
		recheckScript.clear();
		const v2 = await verify({
			priorRunId: v1.runId,
			head: commits[3],
			lowAdvisory: ["V1-F1", "V1-F3"],
			dismissed: [{ id: "V1-F4", reason: "same leak as V1-F2" }],
		});
		expect(
			v2.seats.find((row) => row.spec.lens === "fix-verification")?.spec
				.expectedIds,
		).toEqual(["V1-F2"]);
		expect(v2.body).toContain("**Open after this round:** none");
	});

	it("nothing found: the round says nothing new", async () => {
		const v1 = await first({ recheck: ["tests", "security"] });
		expect(v1.body).toContain("**Recheck (tests, security):** nothing new");
		expect(v1.reply).toContain("Recheck (tests, security): nothing new");
		expect(v1.body).toContain("**Open after this round:** none");
	});

	it("every recheck seat lost: no nothing-new, the seats are named on Lost, and the card is blocked", async () => {
		recheckScript.set("tests", "lost");
		const v1 = await first({ recheck: ["tests"], closeOut: true });
		expect(v1.body).not.toContain("nothing new");
		expect(v1.reply).not.toContain("nothing new");
		expect(v1.body).toContain("**Lost:** terra/tests, opus/tests");
		expect(v1.body).toContain(
			"**Recheck (tests):** every recheck seat was lost, so nothing was checked",
		);
		expect(v1.reply).toContain("Lost: terra/tests, opus/tests");
		// A lost recheck seat does not undo what the verify seat resolved.
		expect(v1.body).toContain("1/1 voted · F-1 resolved, F-2 resolved");
		expect(v1.body).not.toContain("a verify seat was lost");
		expect(v1.reply).toMatch(
			/^PR close-out: not posted \(lost recheck coverage: terra\/tests, opus\/tests\)/mu,
		);
	});

	it("the card names a recheck seat an earlier round lost", async () => {
		recheckScript.set("tests", "lost");
		const v1 = await first({ recheck: ["tests"] });
		recheckScript.clear();
		await verify({ priorRunId: v1.runId, head: commits[3], closeOut: true });
		const card = comments
			.map((row) => row.body)
			.find((body) => body.startsWith("## Review panel · close-out"));
		expect(card).toContain(
			"**Lost:** terra/tests (recheck), opus/tests (recheck)",
		);
	});

	it("one lens lost, one voted with nothing: nothing new names only the lens that voted", async () => {
		recheckScript.set("tests", "lost");
		const v1 = await first({ recheck: ["tests", "security"] });
		expect(v1.body).toContain("**Recheck (security):** nothing new");
		expect(v1.body).toContain("**Lost:** terra/tests, opus/tests");
	});

	it("the recheck prompt lists, as data, what is open and what is settled, and asks only for what is not listed", async () => {
		// V1: F-1 resolved, F-2 still present, so F-2 stays open.
		verifyScript.set("F-2", "still present");
		const v1 = await first();
		const v2 = await verify({
			priorRunId: v1.runId,
			head: commits[3],
			recheck: ["security"],
		});
		const seat = v2.seats.find((row) => row.spec.lens === "security");
		expect(seat?.tools).toContain("submit_findings");
		expect(seat?.spec.baseRef).toBe(commits[2]);
		expect(seat?.spec.scopingNote).toContain(`${commits[2]}...${commits[3]}`);
		expect(seat?.spec.scopingNote).toMatch(/not already listed/u);
		expect(seat?.spec.dataAppendix).toContain(
			"- F-1 [high, resolved] cache key misses the tenant (src/cache.ts:3)",
		);
		expect(seat?.spec.dataAppendix).toContain(
			"- F-2 [medium, open] retry loop never backs off (src/cache.ts:3)",
		);
		// The listed records are data after the role prompt, never the scope.
		expect(seat?.prompt.indexOf("- F-2 [medium, open]")).toBeGreaterThan(
			seat?.prompt.indexOf("submit_findings") ?? Number.POSITIVE_INFINITY,
		);
		expect(seat?.spec.scopingNote).not.toContain("retry loop never backs off");
	});

	it("a malformed recheck row is refused by the real submit tool; the seat's accepted row is what is recorded", async () => {
		// Each tests seat submits a malformed row first, then a valid one.
		recheckScript.set("tests", {
			tries: [[{ ...LEAK, severity: "critical" }], [NIT]],
		});
		const v1 = await first({ recheck: ["tests"] });
		expect(refusals).toHaveLength(2);
		expect(refusals[0]).toMatch(/severity/u);
		// Only the accepted rows are recorded, signed and posted.
		const recorded = verificationOf(v1.runId).recheck as {
			outcomes: Array<{ outcome: { kind: string; findings?: unknown[] } }>;
		};
		expect(recorded.outcomes.map((row) => row.outcome)).toEqual([
			{ kind: "voted", findings: [NIT] },
			{ kind: "voted", findings: [NIT] },
		]);
		const chain = loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY);
		expect(chain[0]?.recheck?.findings.map((row) => row.title)).toEqual([
			NIT.title,
			NIT.title,
		]);
		expect(v1.body).toContain(
			"- **V1-F1 [low]** backoff constant is unnamed (`src/retry.ts:2`) — terra/tests",
		);
		expect(v1.body).not.toContain("the new retry log prints the token");
	});
});

describe("cancelling verify --recheck", () => {
	it("an abort while recheck seats run reaches them; the snapshot is released after they settle, and no link is signed", {
		timeout: 15_000,
	}, async () => {
		recheckScript.set("tests", "hold");
		const controller = new AbortController();
		onHold = (waiting) => {
			if (waiting === 2) {
				controller.abort();
			}
		};
		await expect(
			runVerify(
				{
					repoDir: repo,
					config: CONFIG,
					priorRunId: REVIEW,
					headRevision: commits[2] as string,
					keptFindingIds: ["F-1", "F-2"],
					recheck: ["tests"],
				},
				{
					recordKey: TEST_RECORD_KEY,
					sessionFactory: factory,
					pinSnapshot: pin,
					abortSignal: controller.signal,
				},
			),
		).rejects.toBeInstanceOf(VerifyCancelledError);
		expect(abortedLenses.filter((lens) => lens === "tests")).toHaveLength(2);
		expect(releases).toEqual([0]);
		expect(loadVerifyChain(repo, REVIEW, TEST_RECORD_KEY)).toEqual([]);
	});
});

describe("the final check", () => {
	it("refuses recheck lenses, and verify --close-out --recheck runs no recheck seat in its final check", async () => {
		const v1 = await first();
		await expect(
			runVerify(
				{
					repoDir: repo,
					config: CONFIG,
					priorRunId: v1.runId,
					headRevision: commits[2] as string,
					keptFindingIds: [],
					final: true,
					recheck: ["tests"],
				},
				{ recordKey: TEST_RECORD_KEY, sessionFactory: factory },
			),
		).rejects.toThrow("Verify refused: the final check runs no recheck seat");
		const v2 = await verify({
			priorRunId: v1.runId,
			head: commits[3],
			recheck: ["tests"],
			closeOut: true,
		});
		// Verify 2: one verify seat and two recheck seats; then the final
		// check, one verify seat and nothing else.
		expect(v2.seats.map((row) => row.spec.lens)).toEqual(
			expect.arrayContaining(["fix-verification", "tests", "tests"]),
		);
		const last = sessions.at(-1);
		expect(last?.spec.lens).toBe("fix-verification");
		expect(sessions.filter((row) => row.spec.lens === "tests")).toHaveLength(2);
		expect(
			comments.some((row) =>
				row.body.startsWith("## Review panel · close-out"),
			),
		).toBe(true);
	});
});

describe("comment", () => {
	it("lists an open recheck id with its severity, takes it in --dismissed, and names a lost recheck seat", async () => {
		recheckScript.set("tests", [LEAK]);
		recheckScript.set("security", "lost");
		await first({ recheck: ["tests", "security"] });
		recheckScript.clear();
		const bodies: string[] = [];
		const reply = await commentAction(
			{
				repoDir: repo,
				ownerApproved: true,
				priorRunId: REVIEW,
				dismissed: [{ id: "V1-F2", reason: "same leak as V1-F1" }],
				lowAdvisory: [],
			},
			{
				deps: {
					...deps(),
					findCloseoutPr: (input: Parameters<typeof findCloseoutPr>[0]) =>
						findCloseoutPr({ ...input, runGh: runGh as never }),
					postComment: (input: PostCloseoutInput) => {
						bodies.push(input.body);
						return {
							action: "created" as const,
							commentId: 1,
							pr: 12,
							url: `https://github.com/${REPO_SLUG}/pull/12#issuecomment-1`,
						};
					},
				},
			},
		);
		expect(textOf(reply)).not.toMatch(/refused/u);
		const card = bodies[0] ?? "";
		const lines = card.split("\n");
		const open = lines.indexOf("### Open (not resolved)");
		expect(open).toBeGreaterThan(0);
		expect(lines[open + 1]).toBe(
			"- **V1-F1 [medium]** the new retry log prints the token",
		);
		expect(card).toContain(
			"- **V1-F2** the new retry log prints the token — same leak as V1-F1",
		);
		expect(card).toContain(
			"**Lost:** terra/security (recheck), opus/security (recheck)",
		);
	});
});
