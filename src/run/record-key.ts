import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
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
	/**
	 * Test seam only: runs after the new key's temp file is written and before
	 * it is linked into place, so a test can interleave a second creator.
	 */
	beforeLink?: () => void;
};

/**
 * Why the record key cannot be used, with what to do about it. `message` is
 * the cause and names the key path.
 */
export class RecordKeyError extends Error {
	readonly fix: string;

	constructor(cause: string, fix: string) {
		super(cause);
		this.name = "RecordKeyError";
		this.fix = fix;
	}
}

/** One unusable-key finding for `diagnose`: the cause and its fix. */
export type RecordKeyProblem = { cause: string; fix: string };

/**
 * Reads the record key, creating it on first use when `create` is set. The
 * key is created exclusively with mode 0600 (written to a temp file opened
 * `wx`, then hard-linked into place, so no reader ever sees a partial key).
 * Refused, with a `RecordKeyError`: a key inside the reviewed repository; a
 * key folder writable by group or other users; a key that is a symlink, not
 * a regular file, readable by group or other, not owned by this user, or not
 * exactly 32 bytes.
 */
export function loadRecordKey(
	keyPath: string,
	options: LoadRecordKeyOptions,
): Buffer {
	const present = inspectFolderAndPresence(keyPath, options.repoDir);
	if (!present) {
		if (!options.create) {
			throw new RecordKeyError(
				`there is no record key at ${keyPath}; the first review or audit run creates it, so no record here was signed by this owner's review_panel`,
				"Start a new review or audit instead; it creates the key.",
			);
		}
		createKey(keyPath, options.beforeLink);
	}
	return readKey(keyPath);
}

/**
 * Checks the record key the way review and audit use it, without writing
 * anything: no key, no temp file. An existing key is opened read-only and
 * checked in full. A missing key must be creatable: its folder must let this
 * user write and search it (`access(2)`, which also sees a read-only mount
 * and ACLs). What this cannot see without writing: a filesystem that refuses
 * hard links, and a check by the effective rather than the real user id.
 * A missing config folder is no problem here: with no folder there is no
 * config, which diagnose already reports.
 */
export function checkRecordKey(
	keyPath: string,
	options: { repoDir: string },
): RecordKeyProblem | undefined {
	try {
		if (!existsAsFolder(path.dirname(path.resolve(keyPath)))) {
			return undefined;
		}
		if (!inspectFolderAndPresence(keyPath, options.repoDir)) {
			assertCreatable(keyPath);
			return undefined;
		}
		readKey(keyPath);
		return undefined;
	} catch (error) {
		return {
			cause: messageOf(error),
			fix:
				error instanceof RecordKeyError
					? error.fix
					: "Fix the record key folder, or point PI_REVIEW_PANEL_CONFIG at a config in a folder only you can write.",
		};
	}
}

/**
 * The checks every use shares: the key is outside the repository, its folder
 * is safe; then whether a key (or anything) is at the path.
 */
function inspectFolderAndPresence(keyPath: string, repoDir: string): boolean {
	assertOutsideRepository(keyPath, repoDir);
	assertSafeFolder(keyPath);
	try {
		lstatSync(keyPath);
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return false;
		}
		throw new RecordKeyError(
			`record key ${keyPath} cannot be read: ${messageOf(error)}`,
			`Make ${path.dirname(keyPath)} readable and searchable by you (chmod u+rx).`,
		);
	}
}

function existsAsFolder(dir: string): boolean {
	try {
		statSync(dir);
		return true;
	} catch (error) {
		if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) {
			return false;
		}
		return true;
	}
}

/**
 * Another local user who can write the key folder could replace the key with
 * one they hold, then sign a planted record. So a folder writable by group or
 * other users is refused, sticky bit or not. A symlinked folder is fine: it
 * is the folder it resolves to that is checked.
 */
function assertSafeFolder(keyPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	const dir = path.dirname(path.resolve(keyPath));
	let mode: number;
	try {
		mode = statSync(dir).mode;
	} catch (error) {
		throw new RecordKeyError(
			`record key ${keyPath} cannot be checked: its folder ${dir} cannot be read: ${messageOf(error)}`,
			`Create ${dir}, or point PI_REVIEW_PANEL_CONFIG at a config in a folder only you can write.`,
		);
	}
	if ((mode & 0o022) !== 0) {
		throw new RecordKeyError(
			`record key ${keyPath} is refused: its folder ${dir} is writable by group or other users`,
			`Run chmod go-w ${dir}, or point PI_REVIEW_PANEL_CONFIG at a config in a folder only you can write.`,
		);
	}
}

function assertCreatable(keyPath: string): void {
	const dir = path.dirname(path.resolve(keyPath));
	try {
		accessSync(dir, constants.W_OK | constants.X_OK);
	} catch (error) {
		throw new RecordKeyError(
			`record key ${keyPath} cannot be created: its folder ${dir} is not writable by you (${messageOf(error)})`,
			notWritableFix(dir),
		);
	}
}

function notWritableFix(dir: string): string {
	return `Run chmod u+w ${dir} if you own it. If it is read-only by design (a read-only mount, a Nix or home-manager store link), set PI_REVIEW_PANEL_CONFIG to a config.json in a writable folder only you can write, mode 0700.`;
}

function createKey(keyPath: string, beforeLink?: () => void): void {
	const temp = `${keyPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
		beforeLink?.();
		try {
			linkSync(temp, keyPath);
		} catch (error) {
			// Another process created it first; read theirs.
			if (!isCode(error, "EEXIST")) {
				throw error;
			}
		}
	} catch (error) {
		throw new RecordKeyError(
			`record key ${keyPath} could not be created: ${messageOf(error)}`,
			`${notWritableFix(path.dirname(keyPath))} The folder's filesystem must also support hard links.`,
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
		throw isCode(error, "ELOOP")
			? new RecordKeyError(
					`record key ${keyPath} is a symlink and is refused`,
					`Replace the symlink with a regular file: copy the key's bytes in (cp -L), then chmod 600 ${keyPath}. Or delete it, and the next review or audit creates a new one (records signed with the old key can no longer be resumed).`,
				)
			: new RecordKeyError(
					`record key ${keyPath} cannot be read: ${messageOf(error)}`,
					`Make it readable by you (chmod 600 ${keyPath}), or delete it so the next review or audit creates a new one.`,
				);
	}
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			throw new RecordKeyError(
				`record key ${keyPath} is not a regular file and is refused`,
				`Remove what is at ${keyPath}; the next review or audit creates the key.`,
			);
		}
		const uid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (uid !== undefined && stats.uid !== uid) {
			throw new RecordKeyError(
				`record key ${keyPath} is not owned by you and is refused`,
				`Delete it, and the next review or audit creates one you own; or chown it to your user if you know where it came from.`,
			);
		}
		if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
			throw new RecordKeyError(
				`record key ${keyPath} is readable by group or other users and is refused`,
				`Run chmod 600 ${keyPath}. If others may have read it, delete it instead; the next review or audit creates a new one.`,
			);
		}
		if (stats.size !== KEY_BYTES) {
			throw new RecordKeyError(
				`record key ${keyPath} is not ${KEY_BYTES} bytes and is refused`,
				`Delete ${keyPath}; the next review or audit creates a new one (records signed with the old key can no longer be resumed).`,
			);
		}
		const key = Buffer.alloc(KEY_BYTES);
		if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) {
			throw new RecordKeyError(
				`record key ${keyPath} could not be read in full`,
				`Delete ${keyPath}; the next review or audit creates a new one.`,
			);
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
		throw new RecordKeyError(
			`record key ${keyPath} cannot be checked: its folder ${keyDir} cannot be resolved: ${messageOf(error)}`,
			`Create ${keyDir}, or point PI_REVIEW_PANEL_CONFIG at a config in a folder only you can write.`,
		);
	}
	if (isInside(repo, keyDir) || isInside(realRepo, realKeyDir)) {
		throw new RecordKeyError(
			`record key ${keyPath} is inside the reviewed repository "${repoDir}" and is refused`,
			"Point PI_REVIEW_PANEL_CONFIG at a config.json outside the repository, in a folder only you can write.",
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
