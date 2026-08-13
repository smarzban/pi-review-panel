---
name: review-panel
description: Use when asked to review a PR or diff. Call review_panel with action review (or diagnose/verify). Never call it with {}. Holistic is implicit; add extras only when a trigger matches. Judge, fix in the harness, verify kept ids, stop after three model passes.
---

# review

You orchestrate one pi-review-panel review of an explicit base and head. `review_panel` is the only public tool. It writes a report. It does not repair, commit, or compute a merge decision. You judge. The owner merges.

Never call the tool with `{}`. Review already diagnoses and refuses when setup is broken. Call diagnose only when you do not know whether the box is ready.

## Actions

1. Optional: `{ "action": "diagnose", "repository": "/absolute/path" }` if setup is unknown.
2. Call `{ "action": "review", "repository", "base", "head" }` with optional `lenses`, `seats`, and `scopingNote`. `lenses` and `seats` must be JSON arrays of strings (for example `["security"]`), never a stringified array.
3. Read the report and the suggested extra lenses. Open the code behind anything you might keep.
4. If suggest flagged a lens you skipped and holistic was thin on that dimension, call `review` again with only that lens on the same base/head.
5. Fix kept items yourself in the working tree. Do not ask the tool to edit.
6. If you kept nothing, tell the owner the change looks ready to land. Name coverage.
7. If you fixed something, commit it so `head` is a new OID. Uncommitted work is invisible: verify pins a committed snapshot and refuses when head matches the prior run. Then call `{ "action": "verify", "repository", "priorRunId", "head", "keptFindingIds" }`. Pass `seats` with one roster alias from the config (the first `defaults.seats` row is fine) unless the kept item is high-stakes; then at most two. Do not replay the whole discovery roster. `priorRunId` is the run directory name from the review record path, or that full record path. `keptFindingIds` is your list, including any promoted low.
8. Recommend landing only when every kept item is resolved, there is no new high/medium regression on the fix, and lost coverage is named.

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
