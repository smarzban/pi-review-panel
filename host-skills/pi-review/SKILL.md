---
name: pi-review
description: "Launch Pi and have it run Review panel on a PR or local change. Pi only reviews and re-reviews. You or the builder implement agreed findings, then ask the same Pi session to verify. Use when asked to review a PR, review this diff, run review panel, or /pi-review. In Herdr (HERDR_ENV=1) you MUST open a sibling pane and start Pi there. Do not call review_panel yourself."
---

# Pi-review: ask Pi to run Review panel

You do not run `review_panel`. You start **Pi** and ask it to use its `review-panel` skill.
Pi owns the tool. Pi only reviews and re-reviews. It never implements.
You judge keep vs skip. The builder (you if you are the implementer, otherwise the agent
that wrote the change) implements. The owner merges.

`pi` must be on PATH. Review panel must be installed in Pi (`pi list` shows `pi-review-panel`).
If either is missing, stop and say so.

## 1. Pick the launch path

```bash
test "${HERDR_ENV:-}" = 1
```

- **Exit 0:** you are in Herdr. Use the Herdr path. Do not start `pi` in this pane.
- **Exit 1:** you are not in Herdr. Use the print-session path.

## 2. What to ask Pi (every path)

Name the repo and the range. Uncommitted work is invisible to verify.

- PR: `base` and `head` from `gh pr view --json baseRefName,headRefOid` (or the PR URL).
- Local committed change: `base` is the merge base with main, `head` is `HEAD`.
- Dirty tree the user wants reviewed: say so, and have Pi review after they commit, or review only the committed range.

First prompt (discovery only, no edits):

```
Use the review-panel skill. Call review_panel, never {}.
Repository: <absolute repo path>
action: review
base: <base>
head: <head>
If this is a PR, put the acceptance criteria (if any) in scopingNote.
Do not implement. You only review. Return the report, coverage, and your keep/skip recommendation.
```

## 3. Herdr path (required when HERDR_ENV=1)

Keep focus in the calling pane. Preserve `$PWD`. Default to a sibling pane in this tab.

Reuse a live agent named `review-panel` if `herdr agent list` shows one. Otherwise:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Use `--direction down` when the pane is narrow or tall. Read the new pane id from
`.result.pane.pane_id`.

```bash
herdr agent start review-panel --kind pi --pane <pane-id>
herdr agent prompt review-panel "<first prompt>" --wait --timeout 900000
herdr agent read review-panel --source recent-unwrapped --lines 200
```

If wait fails or returns `blocked`, run `herdr agent get review-panel` and `herdr agent read`
before sending more input. Do not start a second Pi.

## 4. Not-Herdr path

Keep one session. Use the same `--session-id` for every turn:

```bash
pi -p --session-id review-panel --approve "<first prompt>"
```

Follow-ups use the same `--session-id`. Do not omit it and do not start a new id.

## 5. After the report

Read the report. Open the code behind anything you might keep.

- Default keep: highs, and mediums you agree are real.
- Default skip: low / advisory / nits. Leave them visible.
- You may drop a high you checked and believe is wrong. Say why. Do not fix it.

If you kept nothing, tell the owner it looks ready to land. Name coverage and dead seats.
Then ask whether to post the close-out comment. Do not post until they say yes.

If you kept findings and the user asked for a review that includes fixing (or asked to fix after
the report):

1. **The builder implements.** That is you if you wrote the change, otherwise hand the keep
   list to the implementer agent. Do not ask Pi to edit, commit, or fix.
2. Commit so `head` is a new OID. Uncommitted work is invisible to verify.
3. Send a **verify prompt to the same Pi session**. Pi reviews only:

```
Do not implement. Call review_panel action verify.
Repository: <absolute repo path>
priorRunId: <run id>
head: <new HEAD>
keptFindingIds: <ids>
Do not start a new discovery panel. Stay in this session.
```

Herdr: `herdr agent prompt review-panel "<verify prompt>" --wait --timeout 900000`
Not-Herdr: `pi -p --session-id review-panel --approve "<verify prompt>"`

## 6. Stop

At most three model passes, then ask the owner. Discovery is pass 1. Builder fix + Pi
verify is pass 2. A dirty verify may take one more builder fix + Pi verify (pass 3).
Then stop. Never review-fix-review-fix. Pi never becomes the fixer.

Recommend landing only after a clean verify (or a discovery report with nothing you would keep).
Name who voted, what you kept or skipped, and lost coverage.
Then ask whether to post the close-out comment. Do not post until they say yes.

If they say yes, send a **comment prompt to the same Pi session**. Do not call `review_panel`
yourself and do not write ready to merge on the card:

```
Do not implement. Call review_panel action comment.
Repository: <absolute repo path>
priorRunId: <review run id>
ownerApproved: true
pr: <number if known>
dismissed: [{ id, reason }] for every high/medium you dropped
lowAdvisory: leftover low ids
verifyRunId: <verify run id if any kept item was fixed>
Do not start a new discovery panel. Stay in this session.
```

Herdr: `herdr agent prompt review-panel "<comment prompt>" --wait --timeout 900000`
Not-Herdr: `pi -p --session-id review-panel --approve "<comment prompt>"`
