import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { validateFindings } from "../seat/schema.js";
import { isProcessAlive } from "./liveness.js";
import type {
	PanelRecord,
	PanelRecordInput,
	PlannedSeat,
	ReservedRecord,
	RunPlan,
	SeatOutcomeFacts,
} from "./types.js";

/** Filename of the durable planned-panel record at the record root (AC-25). */
export const PANEL_FILE = "panel.json";

/** Durable SDK lifecycle, replay, cancellation, and lost-coverage facts. */
export const EXECUTION_FILE = "execution.json";

/** The mechanical completeness marker at the record root (AC-31). */
export const COMPLETE_MARKER = "COMPLETE";

/**
 * What `resume` needs to finish an interrupted run: kind, frozen commits, the
 * scoping note, and the planned seat identities. No prompt text and no
 * extension paths: resume rebuilds those from the owner config and the
 * package's own lens tables.
 */
export const PLAN_FILE = "plan.json";

/** One `<planned index>.json` per seat, written the moment that seat settles. */
export const SEATS_DIR = "seats";

/** Held by the process running the record; removed when the run ends. */
export const RUN_LOCK_FILE = "run.lock";

/**
 * Held for the instant it takes to replace a stale run lock, so two
 * processes can never both replace it.
 */
export const RUN_LOCK_TAKEOVER_FILE = "run.lock.takeover";

/** Every file a run writes at the record root. */
export const RECORD_OUTPUT_FILES = [
	PANEL_FILE,
	PLAN_FILE,
	EXECUTION_FILE,
	COMPLETE_MARKER,
	"report.md",
	"findings.json",
	"meta.json",
	"cleanup-error.txt",
] as const;

/** Injectable clock: tests pin the run-id timestamp without sleeping. */
export type ReserveOptions = {
	now?: () => Date;
	/** Coordinator role disambiguates same-timestamp concurrent role panels. */
	role?: string;
};

/** Max characters of the lossy readable ref part (truncated, not refused). */
const MAX_REF_PART_LENGTH = 40;

/**
 * Hex characters of the collision-resistant digest appended to the run-id.
 * 16 hex = 64 bits: birthday-bound at ~2^64, a collision is not a practical
 * concern for any realistic number of reviews. The residual case (two refs
 * that do collide at the same millisecond) is handled by reserve()'s
 * fail-closed path (AC-3), which refuses and touches nothing.
 */
const DIGEST_HEX_LENGTH = 16;

/**
 * Reserves this run's record directory fail-closed: a pre-existing run-id
 * directory is refused without touching anything inside it (AC-3). The id is
 * `<timestamp>-<readable ref>-<digest>` (and, for coordinator role panels,
 * a readable role plus digest suffix): a zero-padded UTC timestamp for recency
 * ordering, lossy human-readable parts, and short collision-resistant digests
 * of the original identities. Concurrent role panels therefore cannot adopt
 * one another's record directory.
 */
export function reserve(
	repoDir: string,
	baseRef: string,
	options?: ReserveOptions,
): ReservedRecord {
	const now = options?.now ?? wallClock;
	const role = options?.role;
	const roleSuffix =
		role === undefined
			? ""
			: `-${sanitizeBaseRef(role)}-${digestBaseRef(role)}`;
	const runId = `${formatRunTimestamp(now())}-${sanitizeBaseRef(baseRef)}-${digestBaseRef(baseRef)}${roleSuffix}`;
	const recordPath = path.join(repoDir, ".review-panel", "runs", runId);

	// Create .review-panel and runs only as real directories. A pre-seeded symlink
	// at either component would let mkdirSync({ recursive: true }) follow it
	// and redirect durable records off-repo.
	ensureRealDirectory(path.join(repoDir, ".review-panel"));
	ensureRealDirectory(path.join(repoDir, ".review-panel", "runs"));
	try {
		// Deliberately not recursive: an existing directory throws EEXIST.
		mkdirSync(recordPath);
	} catch (error) {
		if (isExistsError(error)) {
			throw new Error(
				`run record already exists, refusing to adopt it: ${recordPath}`,
			);
		}
		throw error;
	}

	return {
		runId,
		recordPath,
		reportPath: path.join(recordPath, "report.md"),
		findingsPath: path.join(recordPath, "findings.json"),
		panelPath: path.join(recordPath, PANEL_FILE),
		executionPath: path.join(recordPath, EXECUTION_FILE),
	};
}

/**
 * Persists the exact planned panel before any pinning or scheduling (AC-25):
 * the run's identity, its baseRef, the optional scoping note verbatim, and
 * each planned seat projected to exactly `rosterId`/`lens`/`provider`/`model`
 * in planned order. No prompt text, extension paths, credentials, or endpoints
 * are serialized (AC-26). The `scopingNote` key is omitted entirely when
 * absent (AC-23). Serializes with the record owner's pretty-printed idiom
 * (2-space indent, trailing newline), matching findings.json.
 */
export function writePanel(
	record: ReservedRecord,
	input: PanelRecordInput,
): void {
	const panelRecord: PanelRecord = {
		runId: input.runId,
		baseRef: input.baseRef,
		...(input.scopingNote === undefined
			? {}
			: { scopingNote: input.scopingNote }),
		seats: input.seats.map(projectSeat),
	};
	writeRecordFile(
		record.panelPath,
		`${JSON.stringify(panelRecord, null, 2)}\n`,
	);
}

/** Projects one planned seat to its durable 4-key panel row, byte-for-byte. */
export function projectSeat(seat: PlannedSeat): PanelRecord["seats"][number] {
	return {
		rosterId: seat.rosterId,
		lens: seat.lens,
		provider: seat.provider,
		model: seat.model,
	};
}

/**
 * Persists the SDK execution facts independently from the presentation report.
 * Prompt and scoping bytes stay in this replay artifact, never report.md.
 */
export function writeExecution(
	record: ReservedRecord,
	input: {
		cancelled: boolean;
		outcomes: SeatOutcomeFacts[];
		/** Seats a resume ran again; the key is absent on a first run. */
		resumedSeats?: PlannedSeat[];
	},
): void {
	const lostCoverage = input.outcomes
		.filter((entry) => entry.outcome.kind === "failed")
		.map(
			(entry) =>
				`${entry.seat.provider}/${entry.seat.model}/${entry.seat.lens}`,
		)
		.sort();
	writeRecordFile(
		record.executionPath,
		`${JSON.stringify(
			{
				cancelled: input.cancelled,
				lostCoverage,
				...(input.resumedSeats === undefined
					? {}
					: {
							resumedSeats: input.resumedSeats.map(
								(seat) => `${seat.provider}/${seat.model}/${seat.lens}`,
							),
						}),
				outcomes: input.outcomes,
			},
			null,
			2,
		)}\n`,
	);
}

/** The record paths for an existing run directory (used by resume). */
export function recordAt(recordPath: string): ReservedRecord {
	return {
		runId: path.basename(recordPath),
		recordPath,
		reportPath: path.join(recordPath, "report.md"),
		findingsPath: path.join(recordPath, "findings.json"),
		panelPath: path.join(recordPath, PANEL_FILE),
		executionPath: path.join(recordPath, EXECUTION_FILE),
	};
}

/**
 * Writes one record file without ever following a symlink. The record lives
 * in the reviewed repository, so anything already at `target` may have been
 * planted: the text goes to a fresh temp file (created exclusively) that is
 * then renamed over `target`. A rename replaces a symlink rather than writing
 * through it, and a reader sees all or nothing. Anything at `target` that is
 * neither a regular file nor a symlink (a folder, say) is refused.
 */
export function writeRecordFile(target: string, text: string): void {
	assertReplaceable(target);
	const temp = path.join(
		path.dirname(target),
		`.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(temp, text, { flag: "wx" });
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Refuses a record entry that a rename could not safely replace. */
function assertReplaceable(target: string): void {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(target);
	} catch (error) {
		if (isNotFoundError(error)) {
			return;
		}
		throw error;
	}
	if (!stats.isFile() && !stats.isSymbolicLink()) {
		throw new Error(`${target} is not a regular file`);
	}
}

/**
 * Checks, before anything runs, that every file a run writes into an
 * existing record can be written: nothing at those names is a folder or
 * another non-file, and `seats` is a real folder when present. Symlinks pass,
 * because {@link writeRecordFile} replaces them.
 */
export function assertRecordWritable(recordPath: string): void {
	for (const name of [...RECORD_OUTPUT_FILES, RUN_LOCK_FILE]) {
		assertReplaceable(path.join(recordPath, name));
	}
	const seats = path.join(recordPath, SEATS_DIR);
	if (exists(seats) && !isRealDirectory(seats)) {
		throw new Error(`${seats} is not a real directory`);
	}
}

/**
 * Reads a regular file without following a symlink at its last component.
 * Returns undefined when it is missing, a symlink, or anything but a file.
 */
export function readRegularFile(target: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch {
		return undefined;
	}
	try {
		if (!fstatSync(fd).isFile()) {
			return undefined;
		}
		return readFileSync(fd, "utf8");
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** Persists the resume plan before the snapshot is pinned. */
export function writePlan(record: ReservedRecord, plan: RunPlan): void {
	writeRecordFile(
		path.join(record.recordPath, PLAN_FILE),
		`${JSON.stringify(plan, null, 2)}\n`,
	);
}

/** Persists one settled seat under its planned index, atomically. */
export function writeSeatOutcome(
	record: ReservedRecord,
	index: number,
	facts: SeatOutcomeFacts,
): void {
	const dir = path.join(record.recordPath, SEATS_DIR);
	ensureRealDirectory(dir);
	writeRecordFile(
		path.join(dir, `${index}.json`),
		`${JSON.stringify({ index, facts }, null, 2)}\n`,
	);
}

/**
 * Reads the settled seats of a record, by planned index. The record lives in
 * the reviewed repository, so each file is untrusted: one that is missing,
 * not a regular file, unreadable, names a different seat than the plan, or
 * does not match the outcome schema counts as unsettled, and resume runs that
 * seat again. What is returned is rebuilt from the checked fields only.
 */
export function readSettledOutcomes(
	recordPath: string,
	seats: ReadonlyArray<{
		rosterId: string;
		provider: string;
		model: string;
		lens: string;
	}>,
): Array<SeatOutcomeFacts | undefined> {
	const dir = path.join(recordPath, SEATS_DIR);
	if (!isRealDirectory(dir)) {
		return seats.map(() => undefined);
	}
	return seats.map((seat, index) => {
		const text = readRegularFile(path.join(dir, `${index}.json`));
		if (text === undefined) {
			return undefined;
		}
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isRecord(parsed) || parsed.index !== index) {
				return undefined;
			}
			return settledFacts(parsed.facts, seat);
		} catch {
			return undefined;
		}
	});
}

const FAILURE_CLASSES = new Set([
	"spawn-failure",
	"killed",
	"provider-error",
	"channel-error",
	"no-submit",
]);

/** The checked copy of one seat file's facts, or undefined if any part is off. */
function settledFacts(
	value: unknown,
	identity: { rosterId: string; provider: string; model: string; lens: string },
): SeatOutcomeFacts | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { seat, replay, lifecycle, outcome } = value;
	if (
		!isRecord(seat) ||
		seat.rosterId !== identity.rosterId ||
		seat.provider !== identity.provider ||
		seat.model !== identity.model ||
		seat.lens !== identity.lens ||
		typeof seat.lensPrompt !== "string" ||
		(seat.extraExtensionPaths !== undefined &&
			!isStringArray(seat.extraExtensionPaths)) ||
		!isRecord(replay) ||
		!isLifecycle(lifecycle) ||
		!isRecord(outcome)
	) {
		return undefined;
	}
	let checkedOutcome: SeatOutcomeFacts["outcome"];
	if (outcome.kind === "voted") {
		const findings = validateFindings(outcome.findings);
		if (!findings.ok) {
			return undefined;
		}
		checkedOutcome = { kind: "voted", findings: findings.findings };
	} else if (
		outcome.kind === "failed" &&
		typeof outcome.class === "string" &&
		FAILURE_CLASSES.has(outcome.class) &&
		typeof outcome.reason === "string"
	) {
		checkedOutcome = {
			kind: "failed",
			class: outcome.class as Extract<
				SeatOutcomeFacts["outcome"],
				{ kind: "failed" }
			>["class"],
			reason: outcome.reason,
		};
	} else {
		return undefined;
	}
	return {
		seat: {
			rosterId: identity.rosterId,
			provider: identity.provider,
			model: identity.model,
			lens: identity.lens,
			lensPrompt: seat.lensPrompt,
			...(seat.extraExtensionPaths === undefined
				? {}
				: { extraExtensionPaths: [...(seat.extraExtensionPaths as string[])] }),
		},
		replay: replay as SeatOutcomeFacts["replay"],
		lifecycle: {
			startedAtMs: lifecycle.startedAtMs,
			settledAtMs: lifecycle.settledAtMs,
			durationMs: lifecycle.durationMs,
			attempts: lifecycle.attempts,
			aborted: lifecycle.aborted,
			tokens: { ...lifecycle.tokens },
			cost: lifecycle.cost,
		},
		outcome: checkedOutcome,
	};
}

function isLifecycle(value: unknown): value is SeatOutcomeFacts["lifecycle"] {
	if (!isRecord(value) || !isRecord(value.tokens)) {
		return false;
	}
	const { tokens } = value;
	return (
		isFiniteNumber(value.startedAtMs) &&
		isFiniteNumber(value.settledAtMs) &&
		isFiniteNumber(value.durationMs) &&
		(value.attempts === 1 || value.attempts === 2) &&
		typeof value.aborted === "boolean" &&
		isFiniteNumber(value.cost) &&
		isFiniteNumber(tokens.input) &&
		isFiniteNumber(tokens.output) &&
		isFiniteNumber(tokens.cacheRead) &&
		isFiniteNumber(tokens.cacheWrite) &&
		isFiniteNumber(tokens.total)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

/**
 * Takes the record's run lock for this process. A lock held by a live
 * process refuses. A lock left by an exited process is replaced, but only
 * while holding the takeover file, which is created exclusively: of two
 * processes that both judged the same lock stale, the second either fails to
 * take the takeover file or, once it has it, finds the first one's live lock
 * and refuses. Nothing ever removes a lock it has not re-checked under the
 * takeover file. Returns the release, which removes the lock only while it is
 * still this call's own.
 */
export function acquireRunLock(recordPath: string): () => void {
	const runId = path.basename(recordPath);
	const lockPath = path.join(recordPath, RUN_LOCK_FILE);
	const token = randomBytes(8).toString("hex");
	const body = `${JSON.stringify({ pid: process.pid, token })}\n`;
	const release = () => {
		const held = readRegularFile(lockPath);
		if (held !== undefined && lockToken(held) === token) {
			rmSync(lockPath, { force: true });
		}
	};
	if (createExclusive(lockPath, body)) {
		return release;
	}
	const holder = runLockHolder(recordPath);
	if (isProcessAlive(holder)) {
		throw new Error(`run "${runId}" is still in progress (pid ${holder})`);
	}
	const takeoverPath = path.join(recordPath, RUN_LOCK_TAKEOVER_FILE);
	if (
		!createExclusive(takeoverPath, `${JSON.stringify({ pid: process.pid })}\n`)
	) {
		throw new Error(
			`run "${runId}" lock is being taken over by another process; if no review_panel run is active, delete ${takeoverPath} and try again`,
		);
	}
	try {
		// Judge again now that no one else can replace the lock.
		const current = runLockHolder(recordPath);
		if (isProcessAlive(current)) {
			throw new Error(`run "${runId}" is still in progress (pid ${current})`);
		}
		rmSync(lockPath, { force: true });
		if (!createExclusive(lockPath, body)) {
			throw new Error(`run "${runId}" lock could not be taken`);
		}
		return release;
	} finally {
		rmSync(takeoverPath, { force: true });
	}
}

/** Creates `target` only if nothing (not even a dangling symlink) is there. */
function createExclusive(target: string, text: string): boolean {
	try {
		writeFileSync(target, text, { flag: "wx" });
		return true;
	} catch (error) {
		if (isExistsError(error)) {
			return false;
		}
		throw error;
	}
}

function lockToken(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) && typeof parsed.token === "string"
			? parsed.token
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The pid named by a record's run lock, when there is a readable one. A lock
 * that is a symlink is never read through and names no one.
 */
export function runLockHolder(recordPath: string): number | undefined {
	const text = readRegularFile(path.join(recordPath, RUN_LOCK_FILE));
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && typeof parsed.pid === "number") {
			return parsed.pid;
		}
	} catch {
		// An unreadable lock names no one.
	}
	return undefined;
}

/**
 * Writes the completeness marker, last and only on successful completion;
 * nothing else writes it, so an aborted run stays unmarked (AC-31).
 */
export function complete(record: ReservedRecord): void {
	writeRecordFile(path.join(record.recordPath, COMPLETE_MARKER), "");
}

/**
 * Lossy, human-readable ref part of the run-id. Lowercase, characters outside
 * `[a-z0-9._-]` mapped to `-`, runs of `-` collapsed, truncated to
 * {@link MAX_REF_PART_LENGTH}. This part exists for humans; it does NOT carry
 * identity. The collision-resistant digest appended by {@link reserve} is what
 * makes distinct refs practically (not provably) yield distinct ids.
 */
export function sanitizeBaseRef(baseRef: string): string {
	const lowered = baseRef.toLowerCase();
	const mapped = lowered.replace(/[^a-z0-9._-]/g, "-");
	const collapsed = mapped.replace(/-{2,}/g, "-");
	return collapsed.slice(0, MAX_REF_PART_LENGTH);
}

/**
 * Collision-resistant hex digest of the original, untransformed ref string.
 * This is what makes distinct refs practically (not provably) yield distinct
 * run-ids even when their lossy readable parts collide (e.g. `Main` vs `main`,
 * `origin/main` vs `origin-main`). 16 hex characters (64 bits) make a collision
 * not a practical concern; the residual case is safe because reserve()'s
 * fail-closed path refuses and touches nothing (AC-3). Uses `node:crypto`
 * (a node builtin) so zero runtime dependencies still holds.
 */
export function digestBaseRef(baseRef: string): string {
	return createHash("sha256")
		.update(baseRef)
		.digest("hex")
		.slice(0, DIGEST_HEX_LENGTH);
}

/**
 * Zero-padded, most-significant-first UTC timestamp (ISO-8601-like shape,
 * dashes instead of colons so it is a safe directory name). Fixed-width,
 * ASCII digits only, no locale input, so byte-wise comparison of two ids
 * agrees with recency whenever their timestamps differ.
 *
 * Supported year range: 0000-9999. Years outside this range throw rather
 * than producing a variable-width field that would break lexicographic
 * ordering (e.g. year 10000 as "10000" sorts before "9999").
 */
function formatRunTimestamp(date: Date): string {
	const year = date.getUTCFullYear();
	if (year < 0 || year > 9999) {
		throw new Error(
			`year ${year} is outside the supported range 0-9999; run-ids use a fixed 4-digit year`,
		);
	}
	const yearStr = String(year).padStart(4, "0");
	const month = pad2(date.getUTCMonth() + 1);
	const day = pad2(date.getUTCDate());
	const hours = pad2(date.getUTCHours());
	const minutes = pad2(date.getUTCMinutes());
	const seconds = pad2(date.getUTCSeconds());
	const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
	return `${yearStr}-${month}-${day}T${hours}-${minutes}-${seconds}-${millis}Z`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function wallClock(): Date {
	return new Date();
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

/**
 * Ensures `dirPath` exists as a real directory: creates it when absent,
 * refuses when it is a symlink or a non-directory. Not recursive — the
 * parent must already exist (repoDir for `.review-panel`, `.review-panel` for `runs`).
 */
export function ensureRealDirectory(dirPath: string): void {
	try {
		const stats = lstatSync(dirPath);
		if (stats.isSymbolicLink()) {
			throw new Error(
				`run refused: ${dirPath} is a symlink; run records must stay inside the repository`,
			);
		}
		if (stats.isDirectory() === false) {
			throw new Error(`run refused: ${dirPath} exists and is not a directory`);
		}
		return;
	} catch (error) {
		if (isNotFoundError(error)) {
			mkdirSync(dirPath);
			return;
		}
		throw error;
	}
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/**
 * Refuses a record folder component that is a symlink or not a folder, the
 * same rule {@link reserve} applies when it creates them. Unlike reserve, it
 * never creates anything.
 */
export function assertRealDirectory(dirPath: string): void {
	const stats = lstatSync(dirPath);
	if (stats.isSymbolicLink()) {
		throw new Error(
			`${dirPath} is a symlink; run records must stay inside the repository`,
		);
	}
	if (!stats.isDirectory()) {
		throw new Error(`${dirPath} exists and is not a directory`);
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
