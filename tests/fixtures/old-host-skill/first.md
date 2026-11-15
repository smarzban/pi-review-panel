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
2. Otherwise, in a pi-review-panel checkout with a built CLI, use
   `node cli/dist/cli/src/main.js` in place of `review-panel` below.
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

- PR: `base` and `head` from `gh pr view --json baseRefName,headRefOid`.
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
  handoff. Also any added, rewritten or deleted test.
- `contracts`: OpenAPI, proto or GraphQL files. A TOML or app config schema is not a contract.
- `privacy`: privacy/PII-named paths.
- `migrations`: SQL or migration paths.
- `subtle-correctness`: races, caches, clocks, stale reads, not generic logic bugs.
- `correctness`: generic logic and edge cases, with no concurrency, cache or time angle.
- `specification-conformance`: only with the accepted requirements in `--scoping-note`.
- `infrastructure`: CI, Docker or Terraform.
- `simplification` / `performance`: only when the change is clearly that.

Silently skipping a warranted security lens is a miss.

## 5. Read and judge

Exit 0 is never a pass. Exit codes say only whether the command completed (0), was refused
or failed (1), or was misused (2). They never say whether there are findings. Read the
report.

Its `Seats:` line shows which seats ran under each lens; `Lost:` names failed seats. A dead
seat is lost coverage, never a clean review. Open the code behind every finding you might
keep. Seat severity is an opinion:

- Default keep: highs, and mediums you agree are real.
- Default skip: low, advisory, nits. They stay visible in the report.
- You may promote a low you checked and found real. Say why in one line.
- You may drop a high you checked and believe is wrong. Say why. Do not fix it.

Give the owner each finding with keep or skip and the reason, plus coverage and lost seats.

## 6. Fix and verify

"Review this PR" does not authorize edits. Fix only when the owner asked for fixing.

1. The builder fixes the kept findings and commits, so `head` is a new commit.
2. Verify only the kept ids, with the review's run id (its run directory name):

```bash
review-panel verify --prior-run-id <run> --head <new head> --kept-finding-ids F-1,F-2
```

Do not start a new discovery review on the same change.

## 7. Resume

If a review or audit was interrupted, finish it instead of starting over:

```bash
review-panel resume --prior-run-id <run>
```

## 8. Stop and comment

At most three model passes, then ask the owner. Discovery is pass 1. Fix + verify is pass 2.
A dirty verify may take one more fix + verify (pass 3). Then stop. Never review-fix-review-fix.

When nothing you kept is left open, tell the owner the change looks ready to land, and name
who voted, what you kept or skipped, and lost coverage. Then ask whether to post the
close-out comment. Do not post until they say yes. After a yes:

```bash
review-panel comment --prior-run-id <review run> --owner-approved --pr <n> \
  --verify-run-id <verify run> --low-advisory F-3 --dismissed '[{"id":"F-4","reason":"..."}]'
```

Pass `--verify-run-id` only when a kept item was fixed, and `--dismissed` for every high or
medium you dropped. It updates the one existing panel card instead of opening a second one.