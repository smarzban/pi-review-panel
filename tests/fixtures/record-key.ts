import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The record key every test run signs and checks with. Tests never touch the
 * owner's real key beside `~/.pi-review-panel/config.json`.
 */
export const TEST_RECORD_KEY = Buffer.alloc(32, 7);

/**
 * The MAC formulas, written out independently of `src/` so a test pins the
 * format: a record signed here verifies only if the package signs the same
 * bytes, bound to the same run id, plan MAC and seat index.
 */
export function testPlanMac(
	runId: string,
	planBytes: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	return createHmac("sha256", key)
		.update(`pi-review-panel/plan/v1\0${runId}\0`)
		.update(planBytes)
		.digest("hex");
}

export function testSeatMac(
	runId: string,
	planMac: string,
	index: number,
	seatBytes: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	return createHmac("sha256", key)
		.update(`pi-review-panel/seat/v1\0${runId}\0${planMac}\0${index}\0`)
		.update(seatBytes)
		.digest("hex");
}

/** Signs the record's current `plan.json` bytes, as the package would. */
export function signPlan(
	recordPath: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	const runId = path.basename(recordPath);
	const mac = testPlanMac(
		runId,
		readFileSync(path.join(recordPath, "plan.json"), "utf8"),
		key,
	);
	writeFileSync(path.join(recordPath, "plan.mac"), mac);
	return mac;
}

/** Signs one seat file's current bytes against the record's signed plan. */
export function signSeat(
	recordPath: string,
	index: number,
	key: Buffer = TEST_RECORD_KEY,
): void {
	const runId = path.basename(recordPath);
	const planMac = testPlanMac(
		runId,
		readFileSync(path.join(recordPath, "plan.json"), "utf8"),
		key,
	);
	const seatPath = path.join(recordPath, "seats", `${index}.json`);
	writeFileSync(
		path.join(recordPath, "seats", `${index}.mac`),
		testSeatMac(runId, planMac, index, readFileSync(seatPath, "utf8"), key),
	);
}

/**
 * The MAC of a review's `groups.json` bytes, bound to its run id, the plan's
 * MAC and the SHA-256 of the exact `findings.json` bytes it grouped.
 */
export function testGroupsMac(
	runId: string,
	planMac: string,
	findingsBytes: string,
	groupsBytes: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	const findingsHash = createHash("sha256").update(findingsBytes).digest("hex");
	return createHmac("sha256", key)
		.update(
			`pi-review-panel/groups/v2\0${runId}\0${planMac}\0${findingsHash}\0`,
		)
		.update(groupsBytes)
		.digest("hex");
}

/**
 * Signs the record's current `groups.json` bytes, as the package would, over
 * its current `plan.json` and `findings.json` (empty when there is none yet,
 * as in an interrupted record).
 */
export function signGroups(
	recordPath: string,
	key: Buffer = TEST_RECORD_KEY,
): void {
	const runId = path.basename(recordPath);
	const findingsPath = path.join(recordPath, "findings.json");
	writeFileSync(
		path.join(recordPath, "groups.mac"),
		testGroupsMac(
			runId,
			testPlanMac(
				runId,
				readFileSync(path.join(recordPath, "plan.json"), "utf8"),
				key,
			),
			existsSync(findingsPath) ? readFileSync(findingsPath, "utf8") : "",
			readFileSync(path.join(recordPath, "groups.json"), "utf8"),
			key,
		),
	);
}

/** The files a review record's completion MAC covers, in MAC order. */
export const TEST_REVIEW_SIGNED_FILES = [
	"plan.json",
	"panel.json",
	"meta.json",
	"findings.json",
	"execution.json",
] as const;

/** The files a verify record's completion MAC covers, in MAC order. */
export const TEST_VERIFY_SIGNED_FILES = [
	"panel.json",
	"meta.json",
	"verification.json",
] as const;

/**
 * The completion MAC of a record (`record.mac`): bound to the run id, the
 * record kind and the plan's MAC (empty for a verify record, which has no
 * plan), over each covered file's name and the SHA-256 of its exact bytes.
 */
export function testRecordMac(
	runId: string,
	kind: "review" | "verify",
	planMac: string,
	files: ReadonlyArray<readonly [string, string]>,
	key: Buffer = TEST_RECORD_KEY,
): string {
	const mac = createHmac("sha256", key).update(
		`pi-review-panel/record/v1\0${runId}\0${kind}\0${planMac}\0`,
	);
	for (const [name, bytes] of files) {
		mac.update(
			`${name}\0${createHash("sha256").update(bytes).digest("hex")}\0`,
		);
	}
	return mac.digest("hex");
}

function readOrWrite(target: string, fallback: () => string): string {
	if (!existsSync(target)) {
		writeFileSync(target, fallback());
	}
	return readFileSync(target, "utf8");
}

/**
 * Signs a hand-built complete review record as the package would at
 * completion: writes any covered file the test left out (a plan from
 * `meta.json`, an empty panel, an empty execution), signs `plan.json`, then
 * writes `record.mac` over the covered files.
 */
export function signReviewRecord(
	recordPath: string,
	key: Buffer = TEST_RECORD_KEY,
): void {
	const runId = path.basename(recordPath);
	const meta = JSON.parse(
		readFileSync(path.join(recordPath, "meta.json"), "utf8"),
	) as { baseRef?: string; baseOid?: string; headOid?: string };
	readOrWrite(path.join(recordPath, "panel.json"), () =>
		JSON.stringify({ runId, baseRef: meta.baseRef ?? "main", seats: [] }),
	);
	readOrWrite(path.join(recordPath, "execution.json"), () =>
		JSON.stringify({ cancelled: false, lostCoverage: [], outcomes: [] }),
	);
	readOrWrite(path.join(recordPath, "plan.json"), () =>
		JSON.stringify({
			version: 1,
			kind: "review",
			runId,
			baseRef: meta.baseRef ?? "main",
			baseOid: meta.baseOid,
			headOid: meta.headOid,
			seats: [],
		}),
	);
	const planMac = signPlan(recordPath, key);
	writeFileSync(
		path.join(recordPath, "record.mac"),
		testRecordMac(
			runId,
			"review",
			planMac,
			TEST_REVIEW_SIGNED_FILES.map((name) => [
				name,
				readFileSync(path.join(recordPath, name), "utf8"),
			]),
			key,
		),
	);
}

/**
 * Signs a hand-built complete verify record as the package would: writes a
 * `panel.json` or `meta.json` the test left out, then `record.mac`.
 */
export function signVerifyRecord(
	recordPath: string,
	key: Buffer = TEST_RECORD_KEY,
): void {
	const runId = path.basename(recordPath);
	readOrWrite(path.join(recordPath, "panel.json"), () =>
		JSON.stringify({ runId, baseRef: "main", seats: [] }),
	);
	// A real verify's meta names its review, as its verification does.
	readOrWrite(path.join(recordPath, "meta.json"), () => {
		const verification = existsSync(path.join(recordPath, "verification.json"))
			? (JSON.parse(
					readFileSync(path.join(recordPath, "verification.json"), "utf8"),
				) as { priorRunId?: unknown })
			: {};
		return JSON.stringify({
			runId,
			kind: "verify",
			...(typeof verification.priorRunId === "string"
				? { priorRunId: verification.priorRunId }
				: {}),
		});
	});
	writeFileSync(
		path.join(recordPath, "record.mac"),
		testRecordMac(
			runId,
			"verify",
			"",
			TEST_VERIFY_SIGNED_FILES.map((name) => [
				name,
				readFileSync(path.join(recordPath, name), "utf8"),
			]),
			key,
		),
	);
}

/**
 * The MAC of a posted marker (`round-<N>.posted` or `closeout.posted` in a
 * review's record, `round.posted` in a verify's), bound to the record's run
 * id, the marker's file name and the verify that wrote it.
 */
export function testPostedMac(
	recordRunId: string,
	name: string,
	verifyRunId: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	return createHmac("sha256", key)
		.update(
			`pi-review-panel/posted/v1\0${recordRunId}\0${name}\0${verifyRunId}\0`,
		)
		.digest("hex");
}

/** Writes a posted marker signed as the package would. */
export function writeSignedMarker(
	recordPath: string,
	name: string,
	verifyRunId: string,
	extra: Record<string, unknown> = {},
	key: Buffer = TEST_RECORD_KEY,
): void {
	writeFileSync(
		path.join(recordPath, name),
		`${JSON.stringify({
			verifyRunId,
			postedAt: Date.now(),
			...extra,
			mac: testPostedMac(path.basename(recordPath), name, verifyRunId, key),
		})}\n`,
	);
}
