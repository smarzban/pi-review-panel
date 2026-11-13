# Owner configuration guide

pi-review-panel reads one JSON config file, entirely outside the reviewed repository, and turns it into
the roster of seats that review each change. This guide is the normative setup path: the shape is
exact, unknown fields refuse, and validation is all-or-nothing.

## Copyable example

Save these exact bytes as your config file (the entry below names the file location rules):

<!-- config-example -->
```json
{
  "roster": [
    {"id":"terra","provider":"openai-codex","model":"gpt-5.6-terra"},
    {"id":"claude","provider":"anthropic","model":"claude-opus-5","extraExtensionPaths":["/absolute/provider-extension.ts"]},
    {"id":"glm","provider":"ollama","model":"glm-5.3"}
  ],
  "defaults": {
    "seats":["terra","claude","glm"],
    "lenses":["tests"],
    "seatBudgetMs":1200000
  }
}
```

## Config file location

- Default: `~/.pi-review-panel/config.json` under your home directory.
- Override: set the `PI_REVIEW_PANEL_CONFIG` environment variable to an **absolute** path. A relative
  override refuses.
- The override (and the default) must resolve **outside the reviewed repository**. A path inside
  the repo refuses, and so does a symlink whose target is inside the repo: the resolved (real) path
  is checked, not just the lexical one. A path equal to the repository root counts as inside, both
  directly and as a symlink target. There is no config source inside the repository.
- The file must exist and be valid JSON, and every refusal names the path and the cause:
  - A missing file refuses with a paste-ready example config embedded in the message.
  - A path that exists but cannot be accessed for any reason other than absence (for example a
    permission failure) refuses with the operating-system cause.
  - A path that cannot be resolved to its canonical target (for example a broken symlink) refuses
    with the resolution cause.
  - If the reviewed repository root itself cannot be resolved, that refuses too, naming the
    repository path.
  - An unparsable file or a config that fails validation refuses the run whole.

## What the config means

- `roster`: one row per seat, each with:
  - `id`: a unique, non-empty name you use to select the seat.
  - `provider` and `model`: the exact Pi identifiers of the seat (see Pi identity below).
  - `extraExtensionPaths` (optional): absolute paths to extension files the seat loads, for example
    a provider or authentication extension.
- `defaults`: the run's default selections:
  - `seats`: roster ids, each must name a real roster row, no repeats.
  - `lenses`: package-owned lens names (see below), no repeats.
  - `seatBudgetMs` (optional): per-seat wall-clock budget in milliseconds, an integer from 1 through
    2147483647. Omitted uses the built-in default of 1200000 ms (20 minutes).
- Unknown fields refuse at every level: the root, each roster row, and `defaults` each reject keys
  they do not declare. Any single error refuses the whole config; there is no partial acceptance.

## Pi identity and authentication

A seat runs as a Pi SDK session inside the Pi process that called `review_panel`, not as a separate
`pi` process. `provider` and `model` are resolved by exact id through Pi's model runtime, after the
row's own extensions load. They must be Pi identifiers you have already configured and authenticated
in Pi itself; the roster does not create or configure providers. pi-review-panel stores **no**
credentials, endpoints, or provider definitions anywhere: the config file, the run record, and the
audit `panel.json` carry none of that. A seat suppresses Pi's ambient extensions, skills, prompt
templates, and themes, and loads no context files, so the only extension files it loads are the
exact absolute paths named in that roster row's `extraExtensionPaths`; beside them runs only the
package's own in-process guard that confines tool paths to the seat's snapshot. If a seat needs a
provider or authentication extension, name it there. Only the seat's role tools are active:
read-only `read`, `grep`, `find`, and `ls`, `git_diff` in every role except a repository audit,
and one submit tool. Results are reported only through that submit tool.

A row's `provider` may come from one of its own `extraExtensionPaths`, for example `claude-code`
from `pi-claude-code`. The seat loads that row's extensions first, then registers the providers they
declare, and only then resolves the model and its authentication. Another row's extension never
makes a provider visible to this row.

The `diagnose` action checks each roster row the same way, so it loads and runs the code of every
configured extension, including the provider's own authentication check (for `claude-code`, asking
the Claude Code CLI whether it is logged in). It still starts no reviewer session and runs no model.
An extension that fails to load, or whose provider registration Pi rejects, gives a row that names
it. A provider check that throws counts as not authenticated. Each row's check is bounded at 30
seconds; a row that does not finish in that time gives a timed-out row naming its extensions, and
`diagnose` moves on to the next row. Because `review` and `audit` run `diagnose` first, the bound
also keeps one stuck extension from stalling them.

## Package-owned prompts

Holistic review is implicit: a bare review runs `holistic` on every `defaults.seats` alias.
`defaults.lenses` is optional and names always-on specialist extras only (`security`, `tests`,
`contracts`, and the other shipped extras). The example names `tests`, so every review checks that
new tests can fail and are worth keeping, and that deleted tests leave their contract proven. Each
default extra adds up to two seats per review; drop it to save them. The caller may add extras per
review. The
package owns every prompt file; the config cannot add or override prompt text.

Public callers select no provider, model, prompt, or extension path. They choose only declared
roster aliases and shipped extra names.

## Selection and expansion

The public tool is `review_panel`. A `review` call always plans holistic × `defaults.seats` (or
the caller `seats` override). Optional `defaults.lenses` and caller `lenses` are specialist extras
and each extra runs on at most the first two selected seats. Duplicate effective
provider/model/lens identities and an empty or oversized panel refuse before reviewer work starts.

Unknown fields refuse.

## panel.json audit artifact

Immediately after the run is reserved, and before any snapshot pinning or seat scheduling, the run
writes `.review-panel/runs/<run-id>/panel.json`: the machine-readable record of what was planned. It
records `runId`, `baseRef`, the optional `scopingNote` verbatim, and the ordered seat rows projected
to exactly `rosterId`, `lens`, `provider`, `model`. It contains no prompt text, extension paths,
credentials, or endpoints. Because it is written before the work begins, an aborted run retains it.

## Interrupted runs and `resume`

A review or audit also writes `plan.json` before pinning: its kind, the frozen base and head
commits, the scoping note, the seat budget, and the full planned seats. Like the replay specs in
`execution.json`, it holds lens prompt text and extension paths, so treat it as a replay artifact.
Each seat's outcome is written to `seats/<planned index>.json` the moment that seat settles, by a
temp file and a rename. A seat torn down because the run was cancelled is not written there. While
a run is going, `run.lock` names its process; the run removes it when it ends.

`{"action":"resume","priorRunId":"<run-id>"}` finishes an interrupted record in place. It takes no
seats, lenses, or commits: those come from `plan.json`. It pins the recorded head commit, runs only
the planned seats with no settled outcome, then writes `execution.json`, `report.md`,
`findings.json`, `meta.json`, and `COMPLETE` as a first run would. The report has a "Resumed run"
section naming the seats kept and the seats run again, and `execution.json` lists the re-run seats
under `resumedSeats`. A seat file that is unreadable or names a different seat counts as unsettled.
Resume refuses a complete record, an unknown run, a record whose `run.lock` names a live process,
a record with no `plan.json` (runs from earlier versions), a head or base commit that no longer
resolves, and verify runs: verify runs one or two seats in sequence, so a fresh verify costs the
same as a resume.

## Snapshot cleanup

Each run reviews a detached worktree in the system temp folder named `review-panel-snapshot-*`, with
a `<name>.owner.json` file beside it naming the process and repository that made it. At the start of
every run the package removes this repository's snapshots whose owner process has exited, then runs
`git worktree prune`. A snapshot whose owner is alive, or that belongs to another repository, is
never removed. A snapshot with no owner file (made by an earlier version) is removed only once it is
more than 24 hours old.


