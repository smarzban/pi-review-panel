---
name: review-panel
description: Use when asked to review a PR or diff, or audit a repository. Call review_panel with review, audit, diagnose, verify, or comment. Never call it with {}. Judge findings and keep repair in the harness.
---

# review

You orchestrate one pi-review-panel review of an explicit base and head. `review_panel` is the only public tool. It writes a report. It does not repair, commit, or compute a merge decision. You judge. The owner merges.

Never call the tool with `{}`. Review already diagnoses and refuses when setup is broken. Call diagnose only when you do not know whether the box is ready.

## Actions

1. Optional: `{ "action": "diagnose" }` if setup is unknown. Omit `repository` when this process is already in the repo.
2. Call `{ "action": "review", "base", "head" }` with optional `lenses`, `seats`, and `scopingNote`. `lenses` and `seats` must be JSON arrays of strings (for example `["security"]`), never a stringified array.
3. Read the report and the suggested extra lenses. Open the code behind anything you might keep.
4. If suggest flagged a lens you skipped and holistic was thin on that dimension, call `review` again with only that lens on the same base/head.
5. Fix kept items yourself in the working tree. Do not ask the tool to edit.
6. If you kept nothing, tell the owner the change looks ready to land. Name coverage. Then ask whether to post the close-out comment. Do not post until they say yes.
7. If you fixed something, commit it so `head` is a new OID. Uncommitted work is invisible: verify pins a committed snapshot and refuses when head matches the prior run. Then call `{ "action": "verify", "repository", "priorRunId", "head", "keptFindingIds" }`. Pass `seats` with one roster alias from the config (the first `defaults.seats` row is fine) unless the kept item is high-stakes; then at most two. Do not replay the whole discovery roster. `priorRunId` is the run directory name from the review record path, or that full record path. `keptFindingIds` is your list, including any promoted low.
8. Recommend landing only when every kept item is resolved, there is no new high/medium regression on the fix, and lost coverage is named. Then ask whether to post the close-out comment. Do not post until they say yes.
9. After a yes, call `{ "action": "comment", "repository", "priorRunId", "ownerApproved": true }` with `pr` when you know the number, `dismissed` as `[{ "id", "reason" }]` for every high/medium you dropped, `lowAdvisory` as the leftover low ids, and `verifyRunId` when any kept item was fixed. The tool finds the one comment whose author is you and whose body has heading `## Review panel`, then updates it. Never open a second thread. Never write ready to merge on the comment.

## Repository audit

Use audit for a periodic, advisory sweep of the whole pinned repository, not a PR or a merge check. It has no base/head range. Seats explore with `read`, `grep`, `find`, and `ls`, then record findings only through `submit_findings`.

Call `{ "action": "audit", "repository": "<absolute repo path>" }`. Omit `repository` when already in the repository. The default sweep runs `code-health`, `over-engineering`, `tests`, and `security` across the first two owner-default roster seats. Pass `passes` as a JSON array to choose a targeted menu instead, for example `{"action":"audit","passes":["docs","operability"]}`.

Add a situational pass only when the repository warrants it: `docs`, `observability`, `operability`, or `ux`. Use the default two seats per pass. Select a third exact roster seat only when the scope gives a concrete reason, and put that reason in `scopingNote`. Lost seats are lost coverage.

Read the report and the code behind any finding you might keep. The tool presents a backlog with counts, affected file areas, lost seats, and the record path. It does not write `AUDIT.md`, repair files, run CI, or post a GitHub comment for an audit. After you judge the findings, you may write `AUDIT.md` yourself as an owner-facing backlog. Do not ask the tool to do that.

## Lenses

Holistic seats always run. Extra lenses are optional. The holistic lens is implicit. Most PRs fire 0 extras. Fire every extra whose trigger matches, and none that do not.

Pass an extra only when you can point at the matching file, or at a concrete race, cache, or clock:

- `security`: new auth, crypto, subprocess, or a trust/path boundary.
- `tests`: a behavior change with thin or missing coverage, including an untested production handoff. Added test files are not enough if the new wiring is untested.
- `contracts`: OpenAPI, proto, or GraphQL files. A TOML or app config schema is not a contract.
- `privacy`: privacy/PII-named paths.
- `migrations`: SQL or migration paths.
- `subtle-correctness`: races, caches, clocks, stale reads — not generic logic bugs.
- `correctness`: generic logic and edge cases. Use this instead of subtle-correctness when there is no concurrency/cache/time angle.
- `specification-conformance`: only if you put the accepted requirements in `scopingNote` (the AC list or a readable spec path). An empty spec-seat vote is not a pass.
- `infrastructure`: CI, Docker, or Terraform.
- `simplification` / `performance`: not first-pass unless the change is clearly that.

Silently skipping a warranted security lens is a miss.
Large diffs (tens of files or thousands of lines): pass a `scopingNote` naming the files that matter.

## Judgment

Seat severity is an opinion.

- Default keep: highs, and mediums you agree are real.
- Default skip: low / advisory / nits. They stay visible in the report.
- You may promote a low to a kept blocker if you opened the code and it is real. Say why in one line.
- You may drop a high you checked and believe is wrong. Say why. Do not fix it.

## Stop rule

At most three model passes, then ask the owner. Discovery is pass 1. Fix + verify is pass 2. If that verify shows a still-present item or a bug the fix introduced, one more fix + verify is pass 3. A dirty third pass stops and asks the owner. Never enter review-fix-review-fix. Do not start another full discovery panel on the same change.

## Merge advice

After a clean verify (or a discovery report with nothing you would keep), you may tell the owner the change looks ready to land. Name who voted, who failed, and what you kept or skipped. A dead seat is lost coverage, never a silent empty review.

"Review this PR" does not authorize edits. Fix only when the owner asked for a review that includes fixing, or they asked you to fix after the report.
