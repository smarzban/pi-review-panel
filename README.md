# Review panel

One model reviewing your PR is an opinion.

A **panel** is several exact models, on one pinned snapshot, that can report
findings only through a structured channel — and a tool that is **forbidden**
from saying the change is good.

Most AI reviewers try to be the judge. They score the diff. They invent
agreement. They print “ready to merge.” That is why you stopped trusting them.

Review panel does not judge. It seats the models you named, runs the lenses the
change warrants, and hands you evidence. You keep or skip. You fix. It verifies
the keep list. **You merge.**

## Why this, not another “please review this”

**Nothing else in this stack is a panel.** A chat review is prose. A
single-model CLI is one voice plus a correctness score. CI is the suite —
reviewers here cannot run it, and they must not pretend they did.

What you get instead:

- **Several models, not one.** You pin exact `provider/model` seats. A dead
  seat is lost coverage, never a silent empty pass.
- **One snapshot.** Every seat sees the same committed `base…head`. Uncommitted
  work is invisible on purpose.
- **Findings, not vibes.** A finding exists only if a seat submitted it. The
  tool never parses a paragraph into a bug.
- **Lenses when the change earns them.** Holistic always runs. Security, tests,
  contracts, and the rest fire only when a trigger matches. No hardcoded “always
  pick these two.”
- **No verdict.** No risk score. No “patch is correct.” Severity is an opinion
  you may drop or promote.
- **Verify the keep list.** After you fix, a new HEAD is checked against the
  ids you kept — not a second full discovery circus.
- **One owner-asked PR comment.** Counts, dismissals with reasons, leftover
  lows. No Fixed list. No “ready to merge.” You have to say yes before it posts.

## Install

You need Pi. Add this package to Pi’s `packages` list and restart Pi:

```json
{
  "packages": ["git:github.com/smarzban/pi-review-panel"]
}
```

Or clone this repo and add the local path instead.

Create `~/.pi-review-panel/config.json` with the seats you already have
authenticated in Pi. Shape and location rules are in the
[owner configuration guide](docs/configuration.md).

Then, in Pi:

```
Use the review-panel skill. Review this change.
```

From Grok, Codex, or Claude Code, install `host-skills/pi-review` and run
`/pi-review`. That starts Pi. Pi owns the tool. The host does not call
`review_panel` itself.

## How a run goes

```json
{"action":"diagnose","repository":"/Users/you/the-repo"}
```

```json
{"action":"review","repository":"/Users/you/the-repo","base":"origin/main","head":"HEAD"}
```

```json
{"action":"verify","repository":"/Users/you/the-repo","priorRunId":"<run-id>","head":"HEAD","keptFindingIds":["F-1"]}
```

```json
{"action":"comment","repository":"/Users/you/the-repo","priorRunId":"<run-id>","ownerApproved":true,"pr":29}
```

Holistic seats always run. Optional `lenses` add extras. Optional `scopingNote`
focuses a large diff.

Records land under `.review-panel/runs/`. The public card is coverage, findings
or dispositions, and lost seats. It is not a merge decision.

## Status

0.1.0. Diagnose, review, verify, and comment are the public path. Pi loads the
TypeScript directly — no `dist/`, no runtime dependencies beyond Pi.
