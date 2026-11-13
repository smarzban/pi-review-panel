import { loadResumable } from "../../../src/run/resume.js";
import { TEST_RECORD_KEY } from "../record-key.js";

/**
 * Runs `loadResumable(repo, runId)` once and prints what happened as one JSON
 * line: `{ "refused": message }` or `{ "loaded": true }`. Run in a child so a
 * call that blocks for ever can be killed without hanging the test runner.
 */
const [repo, runId] = process.argv.slice(2);
try {
	loadResumable(repo as string, runId as string, TEST_RECORD_KEY);
	process.stdout.write(`${JSON.stringify({ loaded: true })}\n`);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ refused: error instanceof Error ? error.message : String(error) })}\n`,
	);
}
