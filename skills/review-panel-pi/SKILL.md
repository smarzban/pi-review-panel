---
name: review-panel-pi
description: Use when asked to review a PR or diff, or audit a repository. Call review_panel with suggest, review, audit, diagnose, verify, resume, or comment. Never call it with {}. Judge findings and keep repair in the harness.
---

# review

You orchestrate one pi-review-panel review of an explicit base and head. `review_panel` is the only public tool. It writes a report. It does not repair, commit, or compute a merge decision. You judge. The owner merges.

Never call the tool with `{}`. Review already diagnoses and refuses when setup is broken. Call diagnose only when you do not know whether the box is ready. Diagnose also checks the owner's record key (beside the owner config) without creating it; review and audit refuse to start when that key is unusable, and the refusal names the key path and the fix.

## Actions

1. Optional: `{ "action": "diagnose" }` if setup is unknown. Omit `repository` when this process is already in the repo.
2. Call `{ "action": "suggest", "base", "head" }` first. It runs no seat and spends no quota. It lists each lens the diff rules suggest, with the reason and the evidence (file and line), and marks a lens already in the owner's `defaults.lenses` as already on. The tool never adds a lens by itself. If it says the suggestions are unavailable, no rule ran: choose from the trigger table.
3. Choose the lenses yourself. Accept a suggestion, add a lens from the trigger table under Lenses, or drop a suggestion, with a one-line reason for each. Then call `{ "action": "review", "base", "head", "lenses" }` with your final list of extras, plus optional `seats` and `scopingNote`. Holistic and the owner's default lenses run anyway; do not pass them again. If you chose no extra lens, omit `lenses`; the tool refuses an empty array. `lenses` and `seats` must be JSON arrays of strings (for example `["security"]`), never a stringified array.
4. Read the report. Its `Seats:` line shows which seats ran under each lens, failed seats included; `Lost:` names the failed ones. A `Suggest:` block, when there is one, lists only suggested lenses that did not run, each with its reason. Open the code behind anything you might keep. Do not re-run a lens you dropped in step 3 unless the report shows a concrete gap on its dimension that holistic left unsettled; then call `review` once with only that lens on the same base/head.
5. Fix kept items yourself in the working tree. Do not ask the tool to edit.
6. If you kept nothing, tell the owner the change looks ready to land. Name coverage. Then ask whether to post the close-out comment. Do not post until they say yes.
7. If you fixed something, commit it so `head` is a new OID. Uncommitted work is invisible: verify pins a committed snapshot and refuses when head matches the prior run. Then call `{ "action": "verify", "repository", "priorRunId", "head", "keptFindingIds", "dismissed", "lowAdvisory" }`: `dismissed` is `[{ "id", "reason" }]` for every finding you chose not to fix, with your one-line reason, and `lowAdvisory` the low ids you left as advisory, so the verify comment and the close-out carry your reasons. An unknown id refuses the verify before any seat runs. Pass `seats` with one roster alias from the config (the first `defaults.seats` row is fine) unless the kept item is high-stakes; then at most two. Do not replay the whole discovery roster. `priorRunId` is the run directory name from the review record path, or that full record path. `keptFindingIds` is your list, including any promoted low.
8. Recommend landing only when every kept item is resolved, there is no new high/medium regression on the fix, and lost coverage is named. If the reply's `PR close-out:` line says it posted, the close-out is already on the PR. Otherwise ask whether to post the close-out comment. Do not post until they say yes.
9. After a yes, if the automatic close-out was not posted (see Posting to the PR), call `{ "action": "comment", "repository", "priorRunId", "ownerApproved": true }` with `pr` when you know the number, `dismissed` as `[{ "id", "reason" }]` for every high/medium you dropped, `lowAdvisory` as the leftover low ids, and `verifyRunId` when any kept item was fixed. The tool finds the one comment whose author is you and whose body has heading `## Review panel`, then updates it. Never open a second thread. Never write ready to merge on the comment.

## Posting to the PR

Posting is on by default. When the run's head is the head of exactly one open PR, `review` posts its round there as a new comment (`## Review panel · review`), and each `verify` posts `## Review panel · verify N`: each kept id resolved, still present or inconclusive, each dismissed id with your reason, the low/advisory ids, and the regressions. A verify where every seat voted and marked every kept id resolved, with no regressions, also posts the close-out card on its own, normally once per review (`## Review panel · close-out`); a kept low counts as fixed and need not be listed in `lowAdvisory`. The reply ends with a `PR comment:` line (and a `PR close-out:` line) saying where it posted or why it did not. A post that fails is never a run failure.

- Pass `"prComment": false` to keep a run off the PR, and `pr` to name the PR when the lookup cannot find one.
- If the reply says `the owner config asks for approval first`, the owner set `defaults.prComment: "ownerApproved"`: ask the owner, and after a yes repeat with `"ownerApproved": true` on the next round.
- Audit and resume never post. After a resume, the next verify posts.
- The comments are presentation. Never write ready to merge on the comment, and never treat a posted close-out as an approval: the owner is the merge gate.

## Resume an interrupted run

If a review or audit was killed or crashed before it finished, its record has no `COMPLETE` marker. Each seat that settled before the interruption is already on disk. Call `{ "action": "resume", "priorRunId": "<run directory name>" }` to finish it. Resume takes no other argument: seats, lenses, and commits come from the record, and each seat is rebuilt from the owner config's roster row of that name. A seat whose row is gone or now names another model does not run and is lost coverage, even if it had settled. Resume only keeps seat files signed with the owner's record key (beside the owner config); an unsigned or edited seat runs again. The record's scoping note is not passed to the re-run seats; the reply says so when there was one. It pins the same head commit, runs only the seats that had not settled, and writes the report as a normal run would. The report names which seats ran again. A seat that fails on resume is lost coverage, like any failed seat. Resume refuses a complete record, an unknown run, a run that is still in progress, a head commit that no longer resolves, a record whose plan is not signed with the owner's record key (a record planted in the repository), a record whose plan exceeds the panel caps or that holds symlinked folders, and verify runs (start a new verify instead).

## Repository audit

Use audit for a periodic, advisory sweep of the whole pinned repository, not a PR or a merge check. It has no base/head range. Seats explore with `read`, `grep`, `find`, and `ls`, then record findings only through `submit_findings`.

Call `{ "action": "audit", "repository": "<absolute repo path>" }`. Omit `repository` when already in the repository. The default sweep runs `code-health`, `over-engineering`, `tests`, and `security` across the first two owner-default roster seats. Pass `passes` as a JSON array to choose a targeted menu instead, for example `{"action":"audit","passes":["docs","operability"]}`.

Add a situational pass only when the repository warrants it: `docs`, `observability`, `operability`, or `ux`. Use the default two seats per pass. Select a third exact roster seat only when the scope gives a concrete reason, and put that reason in `scopingNote`. Lost seats are lost coverage.

Read the report and the code behind any finding you might keep. The tool presents a backlog with counts, affected file areas, lost seats, and the record path. It does not write `AUDIT.md`, repair files, run CI, or post a GitHub comment for an audit. After you judge the findings, you may write `AUDIT.md` yourself as an owner-facing backlog. Do not ask the tool to do that.

To clean up low-value or flaky tests in an existing repository, run `{"action":"audit","passes":["tests"]}`. On a large repository, run it once per directory with that directory in `scopingNote`. Verify does not accept an audit run. Apply the fix, merge, and remove items you keep on a branch, open a PR, and run `review` on it: the `tests` lens checks that each deleted test leaves its contract proven.

## Lenses

Holistic seats always run. Extra lenses are optional. The holistic lens is implicit. Owner-default extras in `defaults.lenses` run on every review; the example config sets `"defaults": { "lenses": ["tests"] }`. Do not pass a default extra again. Fire every extra whose trigger matches, and none that do not.

Pass an extra only when you can point at the matching file, or at a concrete race, cache, or clock:

- `security`: new auth, crypto, subprocess, or a trust/path boundary.
- `tests`: a behavior change with thin or missing coverage, including an untested production handoff. Added test files are not enough if the new wiring is untested. Also fire it when the change adds, rewrites, or deletes tests, so the lens can check that each one can fail, is not flaky by construction, and is worth keeping, and that each deleted test leaves its contract proven.
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
