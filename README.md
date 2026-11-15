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
  verify post a new comment there, and a verify where every seat voted and
  resolved every kept id, with no regressions, also posts the close-out card: counts, dismissals with
  reasons, leftover lows. No Fixed list. No “ready to merge.” Turn it off per run
  with `--no-pr-comment`, or set `defaults.prComment: "ownerApproved"` so every
  post needs the owner's yes.

## Install

You need Node 26 or newer, `git`, and `gh` (for posting rounds to a pull request).

```bash
npm install -g pi-review-panel     # puts the `review-panel` command on PATH
review-panel skill install         # links the one skill into each coding agent
```

`skill install` links the `review-panel` skill into every coding agent it finds:
Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`), Grok (`~/.grok/skills`)
and Pi (`~/.pi/agent/skills`), each honouring the agent's own folder variable. It never
creates a folder for an agent you do not have, and never replaces a `review-panel` folder
that is not its own link without `--force`, which only works together with `--agent`. Details and options are in the
[CLI guide](docs/cli.md#install).

Create `~/.pi-review-panel/config.json` with the seats you want. Shape and location
rules are in the [owner configuration guide](docs/configuration.md). The command runs
the seats itself with the bundled Pi SDK, reusing your Pi logins in `~/.pi/agent` when
you have them; otherwise sign in with `review-panel auth login <provider>`. Then:

```bash
review-panel diagnose
```

In any of those agents, ask:

```
/review-panel Review this change.
```

or, for a periodic repository sweep, `/review-panel Audit this repository.` The agent
runs the command, reads the report, and judges each finding.

**Upgrading from 0.3.0 (Pi tool):** the `review_panel` Pi tool is gone. Run
`pi remove npm:pi-review-panel`, then the two commands above.

## How a run goes

```bash
review-panel diagnose
review-panel suggest --base origin/main --head HEAD
```

`suggest` runs no seat, but it reads the owner config for `defaults.lenses`. It
lists the lenses the diff's rules point at, each with its reason and evidence,
and marks the owner's default lenses as already on. The calling agent chooses
the lenses, with a reason for each, and passes the extras to review. The tool
never adds a lens by itself. When the diff cannot be read, it says
"Suggestions unavailable" with the cause; no rule ran, so choose from the
skill's trigger table.

```bash
review-panel review --base origin/main --head HEAD --lenses security
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

When the owner names a grouping seat in `defaults.consolidator`, findings that
describe the same defect are shown once, as a group (`G-1`, …), with every
member's own id, seat, severity and evidence. Grouping never drops, rewrites or
re-rates a finding, and group size is never shown as agreement. Verify and
comment take G-ids as well as F-ids (see
[Grouped findings](docs/configuration.md#grouped-findings)).

```bash
review-panel audit
```

An audit pins the whole `HEAD` tree. Its baseline passes are code health,
over-engineering, tests, and security across two owner-default seats. Pass
`--passes` for a situational sweep such as docs, observability, or operability. It reports an advisory
backlog only: counts, file areas, lost seats, and a record path. The tool does
not write `AUDIT.md` or post an audit comment.

```bash
review-panel verify --prior-run-id <run-id> --head HEAD --kept-finding-ids F-1
```

Pass the reasons for findings you chose not to fix, so the verify comment and the
close-out carry them:

```bash
review-panel verify --prior-run-id <run-id> --head HEAD --kept-finding-ids F-1 \
  --dismissed '[{"id":"F-2","reason":"by design"}]' --low-advisory F-3
```

Review and verify post their round to the open PR whose head is the run's head
(see [Posting rounds](docs/configuration.md#posting-rounds-to-the-pull-request)).
`comment` is the manual close-out card, posted or updated only after the owner says yes:

```bash
review-panel comment --prior-run-id <run-id> --owner-approved --pr 29
```

```bash
review-panel resume --prior-run-id <run-id>
```

A review or audit that was killed keeps every seat that had finished. `resume`
runs only the missing seats against the same head commit and writes the report.

Holistic seats always run. Optional `--lenses` add extras. Optional `--scoping-note`
focuses a large diff. Every command and flag is in the [CLI guide](docs/cli.md).

Records land under `.review-panel/runs/`. The reply is coverage, findings
or dispositions, and lost seats. The tool computes no merge decision.

## Status

Unreleased: one `review-panel` command and one skill, published from the
`pi-review-panel` npm package (0.3.0 on npm is still the Pi tool). Diagnose,
suggest, review, audit, verify, resume, and comment are the public path. The
package ships a built `dist/` (built at pack time, never committed) and depends
on the Pi SDK it runs seats with.
