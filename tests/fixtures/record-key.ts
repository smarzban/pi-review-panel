import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

/** The MAC of a review's `groups.json` bytes, bound to its run id. */
export function testGroupsMac(
	runId: string,
	groupsBytes: string,
	key: Buffer = TEST_RECORD_KEY,
): string {
	return createHmac("sha256", key)
		.update(`pi-review-panel/groups/v1\0${runId}\0`)
		.update(groupsBytes)
		.digest("hex");
}

/** Signs the record's current `groups.json` bytes, as the package would. */
export function signGroups(
	recordPath: string,
	key: Buffer = TEST_RECORD_KEY,
): void {
	writeFileSync(
		path.join(recordPath, "groups.mac"),
		testGroupsMac(
			path.basename(recordPath),
			readFileSync(path.join(recordPath, "groups.json"), "utf8"),
			key,
		),
	);
}
