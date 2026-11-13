import {
	type ChildProcess,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAuditPassTable } from "../src/config/audit-passes.js";
import { loadLensTable, SHIPPED_LENSES } from "../src/config/lenses.js";
import type { Config } from "../src/config/schema.js";
import {
	COMPLETE_MARKER,
	PANEL_FILE,
	PLAN_FILE,
	RUN_LOCK_FILE,
	recordAt,
	SEATS_DIR,
} from "../src/run/record.js";
import { loadResumable, resumeRun } from "../src/run/resume.js";
import { executeAudit, runAudit } from "../src/run/run-audit.js";
import { executeReview, runReview } from "../src/run/run-review.js";
import { scheduleSeats } from "../src/run/scheduler.js";
import type { PlannedSeat } from "../src/run/types.js";
import type { SdkSessionFactory } from "../src/seat/run-seat.js";
import { createSdkSeatFake } from "./fixtures/sdk-seat-fake.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createHostRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "run-resume-trust-"));
	git(repo, ["init", "-b", "main", "--quiet"]);
	git(repo, ["config", "user.email", "run@example.test"]);
	git(repo, ["config", "user.name", "Run Test"]);
	writeFileSync(path.join(repo, "committed.txt"), "committed\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base", "--quiet"]);
	git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	writeFileSync(path.join(repo, "change.txt"), "change\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "change", "--quiet"]);
	return repo;
}

function threeSeats(): PlannedSeat[] {
	return ["correctness", "security", "tests"].map((lens, index) => ({
		rosterId: `roster-${index}`,
		provider: "openai-codex",
		model: `gpt-5.3-codex-${index}`,
		lens,
		lensPrompt: `Review this change through a ${lens} lens.`,
	}));
}

function ownerConfig(seatBudgetMs?: number): Config {
	return {
		roster: threeSeats().map((seat) => ({
			id: seat.rosterId,
			provider: seat.provider,
			model: seat.model,
		})),
		defaults: {
			seats: ["roster-0"],
			...(seatBudgetMs === undefined ? {} : { seatBudgetMs }),
		},
	};
}

function onlyRecord(repo: string): string {
	const runsDir = path.join(repo, ".review-panel", "runs");
	const ids = readdirSync(runsDir);
	expect(ids).toHaveLength(1);
	return path.join(runsDir, ids[0] as string);
}

/** Counts sessions and keeps each seat's spec. */
function recordingFactory(): {
	factory: SdkSessionFactory;
	specs: Array<{ lens: string; lensPrompt: string; scopingNote?: string }>;
} {
	const fake = createSdkSeatFake();
	const specs: Array<{
		lens: string;
		lensPrompt: string;
		scopingNote?: string;
	}> = [];
	return {
		specs,
		factory: async (input) => {
			specs.push({
				lens: input.spec.lens,
				lensPrompt: input.spec.lensPrompt,
				...(input.spec.scopingNote === undefined
					? {}
					: { scopingNote: input.spec.scopingNote }),
			});
			return fake.factory(input);
		},
	};
}

/** A three-seat review aborted as soon as its first seat settled. */
async function interruptedReview(
	repo: string,
	scopingNote?: string,
): Promise<string> {
	const controller = new AbortController();
	const fake = createSdkSeatFake([
		{ kind: "default" },
		{ kind: "pending" },
		{ kind: "pending" },
	]);
	await expect(
		runReview(
			{
				repoDir: repo,
				baseRef: "origin/main",
				seats: threeSeats(),
				...(scopingNote === undefined ? {} : { scopingNote }),
			},
			{
				abortSignal: controller.signal,
				sessionFactory: fake.factory,
				onProgress: (event) => {
					if (event.kind === "seat-finished") {
						controller.abort();
					}
				},
			},
		),
	).rejects.toThrow(/cancel/i);
	return onlyRecord(repo);
}

/** A two-seat audit (code-health, security) aborted after its first seat. */
async function interruptedAudit(repo: string): Promise<string> {
	const controller = new AbortController();
	const fake = createSdkSeatFake([{ kind: "default" }, { kind: "pending" }]);
	const seats = threeSeats()
		.slice(0, 2)
		.map((seat, index) => ({
			...seat,
			lens: index === 0 ? "code-health" : "security",
		}));
	await expect(
		runAudit(
			{ repoDir: repo, seats },
			{
				abortSignal: controller.signal,
				sessionFactory: fake.factory,
				onProgress: (event) => {
					if (event.kind === "seat-finished") {
						controller.abort();
					}
				},
			},
		),
	).rejects.toThrow(/cancel/i);
	return onlyRecord(repo);
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8"));
}

function rewritePlan(
	recordPath: string,
	edit: (plan: Record<string, unknown>) => void,
): void {
	const planPath = path.join(recordPath, PLAN_FILE);
	const plan = readJson(planPath);
	edit(plan);
	writeFileSync(planPath, JSON.stringify(plan));
}

function rewriteSeat(
	recordPath: string,
	index: number,
	edit: (file: { index: number; facts: Record<string, unknown> }) => void,
): void {
	const seatPath = path.join(recordPath, SEATS_DIR, `${index}.json`);
	const file = readJson(seatPath) as {
		index: number;
		facts: Record<string, unknown>;
	};
	edit(file);
	writeFileSync(seatPath, JSON.stringify(file));
}

/** A live process that is not this one; killed by the caller. */
function liveForeignProcess(): ChildProcess & { pid: number } {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
		stdio: "ignore",
	});
	if (child.pid === undefined) {
		throw new Error("could not spawn a sleeper");
	}
	return child as ChildProcess & { pid: number };
}

function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	if (pid === undefined) {
		throw new Error("could not spawn a short-lived child");
	}
	return pid;
}

describe("resume never follows a symlink in the record", () => {
	it("replaces a planted report.md symlink instead of writing through it", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const victim = path.join(outside, "victim.txt");
			writeFileSync(victim, "victim\n");
			symlinkSync(victim, path.join(recordPath, "report.md"));

			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: createSdkSeatFake().factory,
			});

			expect(readFileSync(victim, "utf8")).toBe("victim\n");
			expect(lstatSync(path.join(recordPath, "report.md")).isFile()).toBe(true);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("replaces every output symlink planted after the record was loaded", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const loaded = loadResumable(repo, path.basename(recordPath));
			const outputs = [
				"report.md",
				"findings.json",
				"execution.json",
				"meta.json",
				PANEL_FILE,
			];
			// COMPLETE is not planted: any entry at that name, symlink or not,
			// makes resume refuse once it holds the lock.
			for (const name of outputs) {
				const victim = path.join(outside, name);
				writeFileSync(victim, "victim\n");
				rmSync(path.join(recordPath, name), { force: true });
				symlinkSync(victim, path.join(recordPath, name));
			}

			await resumeRun(loaded, {
				config: ownerConfig(),
				sessionFactory: createSdkSeatFake().factory,
			});

			for (const name of outputs) {
				expect(readFileSync(path.join(outside, name), "utf8")).toBe("victim\n");
			}
			for (const name of ["report.md", "findings.json", "execution.json"]) {
				expect(lstatSync(path.join(recordPath, name)).isFile()).toBe(true);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("replaces a planted seat-file symlink instead of writing through it", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const victim = path.join(outside, "victim.txt");
			writeFileSync(victim, "victim\n");
			symlinkSync(victim, path.join(recordPath, SEATS_DIR, "1.json"));

			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: createSdkSeatFake().factory,
			});

			expect(readFileSync(victim, "utf8")).toBe("victim\n");
			expect(
				lstatSync(path.join(recordPath, SEATS_DIR, "1.json")).isFile(),
			).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses a seats folder that is a symlink", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const seatsPath = path.join(recordPath, SEATS_DIR);
			renameSync(seatsPath, path.join(outside, "seats"));
			symlinkSync(path.join(outside, "seats"), seatsPath);

			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: .*seats.* is not a real directory/,
			);
			expect(readdirSync(path.join(outside, "seats"))).toEqual(["0.json"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("never reads a run lock through a symlink", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const victim = path.join(outside, "victim.json");
			// Read through the link, this would name a live holder.
			writeFileSync(victim, `${JSON.stringify({ pid: process.pid })}\n`);
			symlinkSync(victim, path.join(recordPath, RUN_LOCK_FILE));

			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: createSdkSeatFake().factory,
			});

			expect(readFileSync(victim, "utf8")).toBe(
				`${JSON.stringify({ pid: process.pid })}\n`,
			);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses before any seat runs when a seat file name is taken by a folder", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			mkdirSync(path.join(recordPath, SEATS_DIR, "1.json"));
			const counter = recordingFactory();
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: .*1\.json is not a regular file/,
			);
			expect(counter.specs).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("checks the record again under the lock: a seats symlink planted after loading is refused", async () => {
		const repo = createHostRepo();
		const outside = mkdtempSync(path.join(tmpdir(), "run-resume-victim-"));
		try {
			const recordPath = await interruptedReview(repo);
			const loaded = loadResumable(repo, path.basename(recordPath));
			const seatsPath = path.join(recordPath, SEATS_DIR);
			renameSync(seatsPath, path.join(outside, "seats"));
			symlinkSync(path.join(outside, "seats"), seatsPath);
			const counter = recordingFactory();
			await expect(
				resumeRun(loaded, {
					config: ownerConfig(),
					sessionFactory: counter.factory,
				}),
			).rejects.toThrow(/Resume refused: .*seats.* is not a real directory/);
			expect(counter.specs).toEqual([]);
			expect(readdirSync(path.join(outside, "seats"))).toEqual(["0.json"]);
			// The lock is released, so a later resume is not blocked by this one.
			expect(existsSync(path.join(recordPath, RUN_LOCK_FILE))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses before any seat runs when an output name is taken by a folder", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			mkdirSync(path.join(recordPath, "report.md"));
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: .*report\.md is not a regular file/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume refuses symlinked record folders", () => {
	it.each([".review-panel", "runs"])(
		"refuses when %s is a symlink out of the repository",
		async (component) => {
			const repo = createHostRepo();
			const outside = mkdtempSync(path.join(tmpdir(), "run-resume-outside-"));
			try {
				const recordPath = await interruptedReview(repo);
				const local =
					component === ".review-panel"
						? path.join(repo, ".review-panel")
						: path.join(repo, ".review-panel", "runs");
				const moved = path.join(outside, component);
				renameSync(local, moved);
				symlinkSync(moved, local);

				expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
					/Resume refused: .* is a symlink; run records must stay inside the repository/,
				);
			} finally {
				rmSync(repo, { recursive: true, force: true });
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);
});

describe("resume checks every settled seat file against the outcome schema", () => {
	const invalid: Array<
		[string, (file: { index: number; facts: Record<string, unknown> }) => void]
	> = [
		[
			"a voted outcome with no findings array",
			(file) => {
				file.facts.outcome = { kind: "voted" };
			},
		],
		[
			"a finding outside the submit schema",
			(file) => {
				file.facts.outcome = {
					kind: "voted",
					findings: [
						{
							file: "a.ts",
							line: 1,
							severity: "critical",
							title: "Planted",
							evidence: "x",
						},
					],
				};
			},
		],
		[
			"a finding with an extra field",
			(file) => {
				file.facts.outcome = {
					kind: "voted",
					findings: [
						{
							file: "a.ts",
							line: 1,
							severity: "high",
							title: "Planted",
							evidence: "x",
							verdict: "approve",
						},
					],
				};
			},
		],
		[
			"an unknown failure class",
			(file) => {
				file.facts.outcome = { kind: "failed", class: "bogus", reason: "x" };
			},
		],
		[
			"a missing lifecycle",
			(file) => {
				delete file.facts.lifecycle;
			},
		],
		[
			"a different roster row",
			(file) => {
				(file.facts.seat as Record<string, unknown>).rosterId = "elsewhere";
			},
		],
	];

	it.each(invalid)("re-runs a seat whose file has %s", async (_label, edit) => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewriteSeat(recordPath, 0, edit);
			const loaded = loadResumable(repo, path.basename(recordPath));
			expect(loaded.missing.map((seat) => seat.lens)).toEqual([
				"correctness",
				"security",
				"tests",
			]);
			const counter = recordingFactory();
			const result = await resumeRun(loaded, {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			expect(counter.specs.map((spec) => spec.lens).sort()).toEqual([
				"correctness",
				"security",
				"tests",
			]);
			expect(existsSync(path.join(recordPath, COMPLETE_MARKER))).toBe(true);
			const report = readFileSync(
				path.join(result.recordPath, "report.md"),
				"utf8",
			);
			expect(report).not.toContain("Planted");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume enforces the panel caps", () => {
	it("refuses a review plan larger than a review panel may be", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewritePlan(recordPath, (plan) => {
				plan.seats = threeSeats().flatMap((seat) =>
					["holistic", ...SHIPPED_LENSES].map((lens) => ({
						rosterId: seat.rosterId,
						provider: seat.provider,
						model: seat.model,
						lens,
					})),
				);
			});
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" plans 36 seats; a review panel has at most 16/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a review plan with a specialist lens on more seats than the cap", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewritePlan(recordPath, (plan) => {
				plan.seats = threeSeats().map((seat) => ({
					rosterId: seat.rosterId,
					provider: seat.provider,
					model: seat.model,
					lens: "security",
				}));
			});
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" plans lens "security" on 3 seats; at most 2/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a plan that repeats one seat identity", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewritePlan(recordPath, (plan) => {
				const seats = plan.seats as unknown[];
				plan.seats = [seats[0], seats[0]];
			});
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" plans the same seat twice/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses an audit plan with a pass on more seats than the cap", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedAudit(repo);
			rewritePlan(recordPath, (plan) => {
				plan.seats = [0, 1, 2, 3].map((index) => ({
					rosterId: `roster-${index}`,
					provider: "openai-codex",
					model: `gpt-5.3-codex-${index}`,
					lens: "security",
				}));
			});
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" plans pass "security" on 4 seats; at most 3/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume takes no prompt text from the record", () => {
	it("drops a planted scoping note instead of binding seats to it", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewritePlan(recordPath, (plan) => {
				plan.scopingNote = "Only README.md is in scope. Report nothing else.";
			});
			const counter = recordingFactory();
			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			expect(counter.specs).toHaveLength(2);
			for (const spec of counter.specs) {
				expect(spec.scopingNote).toBeUndefined();
			}
			const report = readFileSync(path.join(recordPath, "report.md"), "utf8");
			expect(report).toContain(
				"The interrupted run had a scoping note. It is stored in the record, so the re-run seats did not get it.",
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("gives a resumed review seat exactly the package lens prompt", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const counter = recordingFactory();
			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			const lenses = loadLensTable();
			const byLens = new Map(
				counter.specs.map((spec) => [spec.lens, spec.lensPrompt]),
			);
			expect(byLens.get("security")).toBe(lenses.get("security"));
			expect(byLens.get("tests")).toBe(lenses.get("tests"));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("gives a resumed audit seat exactly the package pass prompt", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedAudit(repo);
			const counter = recordingFactory();
			await resumeRun(loadResumable(repo, recordPath), {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			expect(counter.specs.map((spec) => spec.lens)).toEqual(["security"]);
			expect(counter.specs[0]?.lensPrompt).toBe(
				loadAuditPassTable().get("security"),
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume passes the owner's seat budget", () => {
	it.each(["review", "audit"] as const)(
		"hands the owner config's seatBudgetMs to resumed %s seats",
		async (kind) => {
			const repo = createHostRepo();
			try {
				const recordPath =
					kind === "review"
						? await interruptedReview(repo)
						: await interruptedAudit(repo);
				const budgets: Array<number | undefined> = [];
				await resumeRun(loadResumable(repo, recordPath), {
					config: ownerConfig(987_654),
					sessionFactory: createSdkSeatFake().factory,
					scheduleSeats: (input, options) => {
						budgets.push(options?.seatBudgetMs);
						return scheduleSeats(input, options);
					},
				});
				expect(budgets).toEqual([987_654]);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		},
	);
});

describe("the run lock", () => {
	it.each(["review", "audit"] as const)(
		"%s refuses a record whose lock a live process holds",
		async (kind) => {
			const repo = createHostRepo();
			const sleeper = liveForeignProcess();
			try {
				const recordPath =
					kind === "review"
						? await interruptedReview(repo)
						: await interruptedAudit(repo);
				const lockPath = path.join(recordPath, RUN_LOCK_FILE);
				const lock = `${JSON.stringify({ pid: sleeper.pid })}\n`;
				writeFileSync(lockPath, lock);
				const counter = recordingFactory();
				const plan = readJson(path.join(recordPath, PLAN_FILE)) as {
					baseOid: string;
					headOid: string;
				};
				const pending =
					kind === "review"
						? executeReview(
								recordAt(recordPath),
								{
									repoDir: repo,
									baseRef: "origin/main",
									baseOid: plan.baseOid,
									headOid: plan.headOid,
									seats: threeSeats(),
								},
								{ sessionFactory: counter.factory },
								{ settled: [undefined, undefined, undefined], lost: [] },
							)
						: executeAudit(
								recordAt(recordPath),
								{
									repoDir: repo,
									revision: plan.headOid,
									seats: threeSeats().slice(0, 2),
								},
								{ sessionFactory: counter.factory },
								{ settled: [undefined, undefined], lost: [] },
							);
				await expect(pending).rejects.toThrow(
					new RegExp(`still in progress \\(pid ${sleeper.pid}\\)`),
				);
				expect(counter.specs).toEqual([]);
				expect(readFileSync(lockPath, "utf8")).toBe(lock);
			} finally {
				sleeper.kill();
				rmSync(repo, { recursive: true, force: true });
			}
		},
	);

	it("takes the lock before reading the record: a run completed meanwhile is refused", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const loaded = loadResumable(repo, path.basename(recordPath));
			// Another resume finished the record after this one loaded it.
			writeFileSync(path.join(recordPath, COMPLETE_MARKER), "");
			const counter = recordingFactory();
			await expect(
				resumeRun(loaded, {
					config: ownerConfig(),
					sessionFactory: counter.factory,
				}),
			).rejects.toThrow(/Resume refused: run ".*" is already complete/);
			expect(counter.specs).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("takes the lock before reading the record: a seat settled meanwhile is kept", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			const loaded = loadResumable(repo, path.basename(recordPath));
			// Seat 1 settled in another process after this one loaded the record.
			const zero = readJson(path.join(recordPath, SEATS_DIR, "0.json")) as {
				index: number;
				facts: { seat: PlannedSeat };
			};
			const seat = threeSeats()[1] as PlannedSeat;
			zero.index = 1;
			zero.facts.seat = { ...zero.facts.seat, ...seat };
			writeFileSync(
				path.join(recordPath, SEATS_DIR, "1.json"),
				JSON.stringify(zero),
			);
			const counter = recordingFactory();
			await resumeRun(loaded, {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			expect(counter.specs.map((spec) => spec.lens)).toEqual(["tests"]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("replaces a lock left by a dead process", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			writeFileSync(
				path.join(recordPath, RUN_LOCK_FILE),
				`${JSON.stringify({ pid: deadPid() })}\n`,
			);
			const counter = recordingFactory();
			await resumeRun(loadResumable(repo, path.basename(recordPath)), {
				config: ownerConfig(),
				sessionFactory: counter.factory,
			});
			expect(counter.specs).toHaveLength(2);
			expect(existsSync(path.join(recordPath, RUN_LOCK_FILE))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("resume plan validation", () => {
	const broken: Array<[string, (plan: Record<string, unknown>) => void]> = [
		[
			"an option-shaped head commit",
			(plan) => {
				plan.headOid = "--help";
			},
		],
		[
			"a short base commit",
			(plan) => {
				plan.baseOid = "abc123";
			},
		],
		[
			"an uppercase head commit",
			(plan) => {
				plan.headOid = String(plan.headOid).toUpperCase();
			},
		],
		[
			"no seats",
			(plan) => {
				plan.seats = [];
			},
		],
		[
			"a seat without a lens",
			(plan) => {
				const seats = plan.seats as Array<Record<string, unknown>>;
				delete seats[0]?.lens;
			},
		],
		[
			"an unknown version",
			(plan) => {
				plan.version = 2;
			},
		],
		[
			"a verify kind",
			(plan) => {
				plan.kind = "verify";
			},
		],
		[
			"a scoping note that is not text",
			(plan) => {
				plan.scopingNote = { text: "x" };
			},
		],
	];

	it.each(broken)("refuses a plan with %s", async (_label, edit) => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rewritePlan(recordPath, edit);
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" has an invalid resume plan/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("refuses a plan that is not JSON", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			writeFileSync(path.join(recordPath, PLAN_FILE), "{not json");
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" has an unreadable resume plan/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("explains a record that stopped before its plan was written", async () => {
		const repo = createHostRepo();
		try {
			const recordPath = await interruptedReview(repo);
			rmSync(path.join(recordPath, PLAN_FILE));
			rmSync(path.join(recordPath, SEATS_DIR), { recursive: true });
			expect(existsSync(path.join(recordPath, PANEL_FILE))).toBe(true);
			expect(() => loadResumable(repo, path.basename(recordPath))).toThrow(
				/Resume refused: run ".*" has no resume plan, so it cannot be resumed: it stopped before its plan was written, when no seat had run yet, or a version without resume started it\. Start a new run instead\./,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
