---
name: review-panel
description: "Run the review-panel CLI on a PR or a local change, read its report, and judge each finding keep or skip. Use when asked to review a PR, review this diff, run review panel, or /review-panel. You run the CLI yourself; never start Pi. The tool never judges, and exit 0 is never a pass."
---

# Review panel from the command line

You run the `review-panel` CLI yourself, read its report, and judge every finding. The tool
writes a report. It never judges, repairs, commits or decides a merge. You judge keep or
skip. The builder (you if you wrote the change, otherwise the agent that did) implements.
The owner merges.

Never start Pi and never open another pane or session for the review. Never name or override
seats: they come only from the owner config. Never run `review-panel auth login` or
`auth logout` unless the owner asks; a missing login is the owner's to fix.

## 1. Find the CLI

1. `review-panel --version` works: use `review-panel`.
2. Otherwise, if the owner has a pi-review-panel checkout with a built CLI, use
   `node <checkout>/cli/dist/cli/src/main.js` in place of `review-panel` below, with
   `<checkout>` written out as the checkout's absolute path in every command. A relative path
   breaks, because the commands run from the reviewed repository. If your shell keeps
   variables between commands, you may set one to the checkout's absolute path (not to the
   whole `node …` command, which some shells will not split into words).
3. Otherwise stop and give the owner the install-from-source steps in `cli/README.md`
   (`cd cli && npm ci && npm run build && npm link`).

Run every command from inside the reviewed repository, or pass `--repo <path>`.

## 2. Check setup

```bash
review-panel diagnose
```

If it does not say `ready`, stop and show the owner its remediation rows. Do not work around
them.

## 3. Pick the range

Uncommitted work is invisible to the panel.

- PR: run `git fetch origin` first. Then `base` is `origin/<baseRefName>` and `head` is
  `headRefOid`, from `gh pr view --json baseRefName,headRefOid`. If the head commit is
  missing, `git fetch origin pull/<n>/head` fetches it without switching the owner's branch.
  A local base branch may be stale.
- Local committed change: `base` is the merge base with main, `head` is `HEAD`.
- Dirty tree: ask the owner to commit first, or review only the committed range.

## 4. Suggest, choose lenses, review

```bash
review-panel suggest --base <base> --head <head>
```

Suggest runs no seat and spends no quota. It lists each lens the diff rules suggest, with
reason and evidence, and marks the owner's default lenses as already on. If it says the
suggestions are unavailable, choose from the table below.

Choose the lenses yourself. Accept a suggestion, add a lens from the table, or drop a
suggestion, with a one-line reason for each. Holistic and the owner's default lenses run
anyway; do not pass them again. Then:

```bash
review-panel review --base <base> --head <head> --lenses <your,extras>
```

Leave out `--lenses` when you chose no extra lens. For a large diff (tens of files or
thousands of lines), add `--scoping-note "<the files that matter>"`. For a PR with
acceptance criteria, put them in `--scoping-note` and add `specification-conformance`.

Fire every extra whose trigger matches, and none that do not. Point at the matching file, or
at a concrete race, cache or clock:

- `security`: new auth, crypto, subprocess, or a trust/path boundary.
- `tests`: a behavior change with thin or missing coverage, including an untested production
  handoff. Added test files are not enough if the new wiring is untested. Also fire it when
  the change adds, rewrites, or deletes tests, so the lens can check that each one can fail,
  is not flaky by construction, and is worth keeping, and that each deleted test leaves its
  contract proven.
- `contracts`: OpenAPI, proto, or GraphQL files. A TOML or app config schema is not a contract.
- `privacy`: privacy/PII-named paths.
- `migrations`: SQL or migration paths.
- `subtle-correctness`: races, caches, clocks, stale reads, not generic logic bugs.
- `correctness`: generic logic and edge cases. Use this instead of subtle-correctness when
  there is no concurrency/cache/time angle.
- `specification-conformance`: only if you put the accepted requirements in `--scoping-note`
  (the AC list or a readable spec path). An empty spec-seat vote is not a pass.
- `infrastructure`: CI, Docker, or Terraform.
- `simplification` / `performance`: not first-pass unless the change is clearly that.

Silently skipping a warranted security lens is a miss.

## 5. Read and judge

Exit 0 is never a pass. Exit codes say only whether the command completed (0), was refused
or failed (1), or was misused (2). They never say whether there are findings. Read the
report.

Its `Seats:` line shows which seats ran under each lens; `Lost:` names failed seats. A dead
seat is lost coverage, never a clean review. A `Suggest:` block, when there is one, lists
only suggested lenses that did not run, each with its reason. Do not re-run a lens you
dropped unless the report shows a concrete gap on its dimension that holistic left
unsettled; then run `review` once with only that lens on the same base and head.

Open the code behind every finding you might keep. Seat severity is an opinion:

- Default keep: highs, and mediums you agree are real.
- Default skip: low, advisory, nits. They stay visible in the report.
- You may promote a low to a kept blocker if you opened the code and it is real. Say why in
  one line.
- You may drop a high you checked and believe is wrong. Say why. Do not fix it.

Give the owner each finding with keep or skip and the reason, plus coverage and lost seats.

## 6. Fix and verify

"Review this PR" does not authorize edits. Fix only when the owner asked for fixing.

1. The builder fixes the kept findings and commits, so `head` is a new commit.
2. Verify only the kept ids, including any promoted low. `<run>` is the review's run id: the
   last folder of the report's `Record:` line. The full record path on that line also works;
   a relative path does not.

```bash
review-panel verify --prior-run-id <run> --head <new head> --kept-finding-ids F-1,F-2 \
  --low-advisory F-3 --dismissed '[{"id":"F-4","reason":"..."}]'
```

Pass `--dismissed` with your one-line reason for every finding you chose not to fix, and
`--low-advisory` for the lows you left as advisory, so the verify comment and the close-out
carry your reasons. An unknown id refuses the verify before any seat runs.

Do not start a new full discovery review on the same change.

### Posting to the PR

Posting is on by default. When the run's head is the head of exactly one open PR, `review`
posts its round there as a new comment, and each `verify` posts what was fixed, what was not
and why, and what is new. A verify where every seat voted and marked every kept id resolved,
with no regressions, also posts the close-out card on its own, once per review; a kept low counts
as fixed and need not be listed in `--low-advisory`. The report ends with a `PR comment:` line
(and a `PR close-out:` line) saying where it posted or why it did not; a failed post never
changes the exit code.

- Add `--no-pr-comment` to keep a run off the PR, and `--pr <n>` to name the PR.
- If the report says `the owner config asks for approval first`, ask the owner, and after a
  yes add `--owner-approved` to the next round.
- Audit and resume never post.

## 7. Resume

If a review or audit was interrupted, finish it instead of starting over:

```bash
review-panel resume --prior-run-id <run>
```

## 8. Stop and comment

At most three model passes, then ask the owner. Discovery is pass 1. Fix + verify is pass 2.
If that verify shows a still-present item or a bug the fix introduced, one more fix + verify
is pass 3. A dirty third pass stops and asks the owner. Never review-fix-review-fix.

Recommend landing only when every kept item is resolved, there is no new high/medium
regression on the fix, and lost coverage is named; or when the discovery report had nothing
you would keep. Name who voted, who failed, and what you kept or skipped. When the automatic
close-out was not posted (the report's `PR close-out:` line says why, or nothing was kept), ask
whether to post the close-out comment. Do not post until they say yes. After a yes:

```bash
review-panel comment --prior-run-id <review run> --owner-approved --pr <n> \
  --verify-run-id <verify run> --low-advisory F-3 --dismissed '[{"id":"F-4","reason":"..."}]'
```

Run ids here come from each report's `Record:` line, as in step 6. Pass `--verify-run-id`
only when a kept item was fixed, and `--dismissed` for every high or
medium you dropped. It updates the one existing panel card instead of opening a second one.