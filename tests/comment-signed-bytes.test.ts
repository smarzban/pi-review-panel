import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { commentAction } from "../src/actions/actions.js";
import type { PostCloseoutInput } from "../src/tool/closeout-post.js";
import {
	signReviewRecord,
	signVerifyRecord,
	TEST_RECORD_KEY,
} from "./fixtures/record-key.js";

/**
 * `comment` reads the review record once, authenticated, and builds the card
 * from those bytes (panel P-3). The swap below runs at a fixed point after
 * that read and before the card is assembled: the check of the verify run,
 * which comment makes only after loading the review.
 */
const swap = vi.hoisted(() => ({ run: () => {} }));

vi.mock("../src/tool/closeout-from-run.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/tool/closeout-from-run.js")>();
	return {
		...actual,
		assertFixedResolved: (
			...args: Parameters<typeof actual.assertFixedResolved>
		) => {
			swap.run();
			return actual.assertFixedResolved(...args);
		},
	};
});

const SEAT = {
	rosterId: "terra",
	lens: "holistic",
	provider: "openai-codex",
	model: "gpt-5.6-terra",
};

function writeRecords(repo: string): string {
	const runs = path.join(repo, ".review-panel", "runs");
	const review = path.join(runs, "review-1");
	mkdirSync(review, { recursive: true });
	writeFileSync(
		path.join(review, "panel.json"),
		JSON.stringify({ runId: "review-1", baseRef: "main", seats: [SEAT] }),
	);
	writeFileSync(
		path.join(review, "meta.json"),
		JSON.stringify({
			runId: "review-1",
			baseRef: "main",
			baseOid: execFileSync("git", ["rev-parse", "HEAD~1"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
			headOid: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
		}),
	);
	writeFileSync(
		path.join(review, "findings.json"),
		JSON.stringify([
			{
				id: "F-1",
				seat: { provider: SEAT.provider, model: SEAT.model, lens: SEAT.lens },
				finding: {
					file: "src/a.ts",
					line: 1,
					severity: "high",
					title: "F-1 title",
					evidence: "evidence",
				},
			},
		]),
	);
	writeFileSync(path.join(review, "COMPLETE"), "");
	signReviewRecord(review);
	const verify = path.join(runs, "v-1");
	mkdirSync(verify, { recursive: true });
	writeFileSync(
		path.join(verify, "verification.json"),
		JSON.stringify({
			priorRunId: "review-1",
			keptFindingIds: ["F-1"],
			outcomes: [
				{
					outcome: {
						kind: "voted",
						result: { items: [{ id: "F-1", disposition: "resolved" }] },
					},
				},
			],
		}),
	);
	writeFileSync(path.join(verify, "COMPLETE"), "");
	signVerifyRecord(verify);
	return review;
}

describe("comment builds its card from the authenticated review bytes (panel P-3)", () => {
	it("keeps the original seats and lost coverage when panel.json and execution.json change after the read", async () => {
		const repo = realpathSync(
			mkdtempSync(path.join(tmpdir(), "comment-signed-bytes-")),
		);
		const run = (args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		run(["init", "-b", "main", "--quiet"]);
		run(["config", "user.email", "comment@example.test"]);
		run(["config", "user.name", "Comment Test"]);
		run(["commit", "--allow-empty", "-m", "base", "--quiet"]);
		run(["commit", "--allow-empty", "-m", "head", "--quiet"]);
		try {
			const review = writeRecords(repo);
			swap.run = () => {
				writeFileSync(
					path.join(review, "panel.json"),
					JSON.stringify({
						runId: "review-1",
						baseRef: "main",
						seats: [
							{
								rosterId: "planted",
								lens: "plantedlens",
								provider: "evil",
								model: "evil",
							},
						],
					}),
				);
				writeFileSync(
					path.join(review, "execution.json"),
					JSON.stringify({
						cancelled: false,
						lostCoverage: [],
						outcomes: [
							{
								seat: { rosterId: "planted", lens: "plantedlens" },
								outcome: { kind: "failed" },
							},
						],
					}),
				);
			};
			const bodies: string[] = [];
			await commentAction(
				{
					repoDir: repo,
					ownerApproved: true,
					priorRunId: "review-1",
					verifyRunId: "v-1",
					dismissed: [],
					lowAdvisory: [],
				},
				{
					deps: {
						env: {},
						home: "/tmp/comment-signed-bytes-home",
						recordKey: () => TEST_RECORD_KEY,
						postComment: (input: PostCloseoutInput) => {
							bodies.push(input.body);
							return {
								action: "created" as const,
								commentId: 1,
								pr: 7,
								url: "https://github.com/owner/demo/pull/7#issuecomment-1",
							};
						},
					},
				},
			);
			expect(bodies).toHaveLength(1);
			expect(bodies[0]).toContain("**Seats:** holistic (terra)");
			expect(bodies[0]).toContain("**Lost:** none");
			expect(bodies[0]).not.toContain("planted");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
