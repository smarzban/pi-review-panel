import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * The owner's record key: 32 random bytes in this file, in the folder of the
 * owner config (`~/.pi-review-panel/` by default, or the folder of
 * `$PI_REVIEW_PANEL_CONFIG`). Never inside the reviewed repository. Run
 * records live in the repository, so anyone who can put files there can plant
 * one; only a record whose plan and seat files carry this key's MAC is taken
 * as this owner's own.
 */
export const RECORD_KEY_FILE = "record-key";

const KEY_BYTES = 32;
const MAC_PATTERN = /^[0-9a-f]{64}$/;

/** Where the record key lives for the owner config at `configPath`. */
export function recordKeyPath(configPath: string): string {
	return path.join(path.dirname(configPath), RECORD_KEY_FILE);
}

export type LoadRecordKeyOptions = {
	/** Create the key when it is missing. Only a first review or audit does. */
	create: boolean;
	/** The reviewed repository; a key inside it is refused. */
	repoDir: string;
};

/**
 * Reads the record key, creating it on first use when `create` is set. The
 * key is created exclusively with mode 0600 (written to a temp file opened
 * `wx`, then hard-linked into place, so no reader ever sees a partial key).
 * A key that is a symlink, not a regular file, readable by group or other,
 * not exactly 32 bytes, or inside the reviewed repository is refused.
 */
export function loadRecordKey(
	keyPath: string,
	options: LoadRecordKeyOptions,
): Buffer {
	assertOutsideRepository(keyPath, options.repoDir);
	let stats: ReturnType<typeof lstatSync> | undefined;
	try {
		stats = lstatSync(keyPath);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw new Error(
				`record key ${keyPath} cannot be read: ${messageOf(error)}`,
			);
		}
	}
	if (stats === undefined) {
		if (!options.create) {
			throw new Error(
				`there is no record key at ${keyPath}; the first review or audit run creates it, so no record here was signed by this owner's review_panel`,
			);
		}
		createKey(keyPath);
	}
	return readKey(keyPath);
}

function createKey(keyPath: string): void {
	const temp = `${keyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
		try {
			linkSync(temp, keyPath);
		} catch (error) {
			// Another process created it first; read theirs.
			if (!isCode(error, "EEXIST")) {
				throw error;
			}
		}
	} catch (error) {
		throw new Error(
			`record key ${keyPath} could not be created: ${messageOf(error)}`,
		);
	} finally {
		rmSync(temp, { force: true });
	}
}

function readKey(keyPath: string): Buffer {
	let fd: number;
	try {
		fd = openSync(
			keyPath,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
	} catch (error) {
		throw new Error(
			isCode(error, "ELOOP")
				? `record key ${keyPath} is a symlink and is refused`
				: `record key ${keyPath} cannot be read: ${messageOf(error)}`,
		);
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			throw new Error(
				`record key ${keyPath} is not a regular file and is refused`,
			);
		}
		if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
			throw new Error(
				`record key ${keyPath} is readable by group or other users and is refused; make it mode 0600`,
			);
		}
		if (stats.size !== KEY_BYTES) {
			throw new Error(
				`record key ${keyPath} is not ${KEY_BYTES} bytes and is refused`,
			);
		}
		const key = Buffer.alloc(KEY_BYTES);
		if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) {
			throw new Error(`record key ${keyPath} could not be read in full`);
		}
		return key;
	} finally {
		closeSync(fd);
	}
}

function assertOutsideRepository(keyPath: string, repoDir: string): void {
	const repo = path.resolve(repoDir);
	const keyDir = path.dirname(path.resolve(keyPath));
	let realRepo = repo;
	let realKeyDir = keyDir;
	try {
		realRepo = realpathSync(repo);
		realKeyDir = realpathSync(keyDir);
	} catch (error) {
		throw new Error(
			`record key folder ${keyDir} cannot be resolved: ${messageOf(error)}`,
		);
	}
	if (isInside(repo, keyDir) || isInside(realRepo, realKeyDir)) {
		throw new Error(
			`record key ${keyPath} is inside the reviewed repository "${repoDir}" and is refused`,
		);
	}
}

/** The MAC of a record's exact `plan.json` bytes, bound to its run id. */
export function planMac(key: Buffer, runId: string, planBytes: string): string {
	return createHmac("sha256", key)
		.update(`pi-review-panel/plan/v1\0${runId}\0`)
		.update(planBytes)
		.digest("hex");
}

/**
 * The MAC of one seat file's exact bytes, bound to the run id, the plan's
 * MAC and the seat's planned index: a genuine seat file cannot be moved to
 * another index, another plan or another run.
 */
export function seatMac(
	key: Buffer,
	runId: string,
	plan: string,
	index: number,
	seatBytes: string,
): string {
	return createHmac("sha256", key)
		.update(`pi-review-panel/seat/v1\0${runId}\0${plan}\0${index}\0`)
		.update(seatBytes)
		.digest("hex");
}

/** True only when `given` is a well-formed MAC equal to `expected`. */
export function macMatches(
	expected: string,
	given: string | undefined,
): boolean {
	if (given === undefined || !MAC_PATTERN.test(given)) {
		return false;
	}
	return timingSafeEqual(
		Buffer.from(expected, "hex"),
		Buffer.from(given, "hex"),
	);
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
