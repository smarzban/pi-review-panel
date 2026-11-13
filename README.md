# Review panel

One model reviewing your PR is an opinion.

A **panel** is several exact models, on one pinned snapshot, that can report
findings only through a structured channel, and a tool that is **forbidden**
from saying the change is good. It reviews a committed change or runs an
advisory whole-repository audit.

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
- **One snapshot.** Review seats see the same committed `base…head`; audit
  seats see one committed `HEAD` tree. Uncommitted work is invisible on purpose.
- **Findings, not vibes.** A finding exists only if a seat submitted it. The
  tool never parses a paragraph into a bug.
- **Lenses when the change earns them.** Holistic always runs. Security, tests,
  contracts, and the rest fire when a trigger matches, or when the owner names them in `defaults.lenses`.
  The example config names `tests`, so every review checks test value.
- **No verdict.** No risk score. No “patch is correct.” Severity is an opinion
  you may drop or promote.
- **Verify the keep list.** After you fix, a new HEAD is checked against the
  ids you kept — not a second full discovery circus.
- **Each round on the PR.** When the head is an open PR, the review and each
  verify post a new comment there, and a verify that finds every kept id resolved
  with no regressions also posts the close-out card: counts, dismissals with
  reasons, leftover lows. No Fixed list. No “ready to merge.” Turn it off per run
  with `prComment: false`, or set `defaults.prComment: "ownerApproved"` so every
  post needs the owner's yes.

## Install

You need Pi. Install from npm and restart Pi:

```bash
pi install npm:pi-review-panel
```

That adds `npm:pi-review-panel` to Pi’s `packages` list. You can also put the
source there yourself:

```json
{
  "packages": ["npm:pi-review-panel"]
}
```

From git instead: `pi install git:github.com/smarzban/pi-review-panel`. A local
clone path works too.

Create `~/.pi-review-panel/config.json` with the seats you already have
authenticated in Pi. Shape and location rules are in the
[owner configuration guide](docs/configuration.md).

Then, in Pi:

```
Use the review-panel-pi skill. Review this change.
```

For a periodic repository sweep instead:

```
Use the review-panel-pi skill. Audit this repository.
```

From Grok, Codex, or Claude Code, install the [`review-panel` CLI](cli/README.md)
and the `host-skills/review-panel` skill, then run `/review-panel`. The host agent runs
the CLI itself, reads the report, and judges each finding. It does not start Pi.

## How a run goes

```json
{"action":"diagnose","repository":"/Users/you/the-repo"}
```

```json
{"action":"suggest","repository":"/Users/you/the-repo","base":"origin/main","head":"HEAD"}
```

`suggest` runs no seat, but it reads the owner config for `defaults.lenses`. It
lists the lenses the diff's rules point at, each with its reason and evidence,
and marks the owner's default lenses as already on. The calling agent chooses
the lenses, with a reason for each, and passes the extras to review. The tool
never adds a lens by itself. When the diff cannot be read, it says
"Suggestions unavailable" with the cause; no rule ran, so choose from the
skill's trigger table.

```json
{"action":"review","repository":"/Users/you/the-repo","base":"origin/main","head":"HEAD","lenses":["security"]}
```

A review reply starts like this:

```
# Review panel
4/4 voted · 8 findings · 2m 57s · $1.6012
Seats: holistic (sol, opus), tests (sol, opus)
Record: `…/.review-panel/runs/…`
```

`Seats:` groups the seats by lens, failed seats included; a `Lost:` line under
it names any that failed. After the findings, a `Suggest:` block lists suggested
lenses that did not run, one per line with its reason and first evidence. Each
file name is shown as a code span, with any control or invisible format
character replaced:

```
Suggest:
- security: added line(s) touch auth/crypto/subprocess/deserialization (`src/run/record-key.ts:42`, +2 more)
```

```json
{"action":"audit","repository":"/Users/you/the-repo"}
```

An audit pins the whole `HEAD` tree. Its baseline passes are code health,
over-engineering, tests, and security across two owner-default seats. Pass
`passes` for a situational sweep such as docs, observability, or operability. It reports an advisory
backlog only: counts, file areas, lost seats, and a record path. The tool does
not write `AUDIT.md` or post an audit comment.

```json
{"action":"verify","repository":"/Users/you/the-repo","priorRunId":"<run-id>","head":"HEAD","keptFindingIds":["F-1"]}
```

Pass the reasons for findings you chose not to fix, so the verify comment and the
close-out carry them:

```json
{"action":"verify","repository":"/Users/you/the-repo","priorRunId":"<run-id>","head":"HEAD","keptFindingIds":["F-1"],"dismissed":[{"id":"F-2","reason":"by design"}],"lowAdvisory":["F-3"]}
```

Review and verify post their round to the open PR whose head is the run's head
(see [Posting rounds](docs/configuration.md#posting-rounds-to-the-pull-request)).
`comment` is the manual close-out card, posted or updated only after the owner says yes:

```json
{"action":"comment","repository":"/Users/you/the-repo","priorRunId":"<run-id>","ownerApproved":true,"pr":29}
```

```json
{"action":"resume","repository":"/Users/you/the-repo","priorRunId":"<run-id>"}
```

A review or audit that was killed keeps every seat that had finished. `resume`
runs only the missing seats against the same head commit and writes the report.

Holistic seats always run. Optional `lenses` add extras. Optional `scopingNote`
focuses a large diff.

Records land under `.review-panel/runs/`. The reply is coverage, findings
or dispositions, and lost seats. The tool computes no merge decision.

## Status

0.3.0. Install as `npm:pi-review-panel`. Diagnose, suggest, review, audit, verify,
resume, and comment are the public path. Pi loads the TypeScript directly, no `dist/`, no
runtime dependencies beyond Pi.
