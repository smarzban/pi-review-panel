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
    {"id":"claude","provider":"anthropic","model":"claude-opus-5","extraExtensionPaths":["/absolute/provider-extension.ts"]}
  ],
  "defaults": {
    "seats":["terra","claude"],
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

`provider` and `model` are passed verbatim to Pi as `--provider` and `--model`. They must be Pi
identifiers you have already configured and authenticated in Pi itself; the roster does not create
or configure providers. pi-review-panel stores **no** credentials, endpoints, or provider definitions
anywhere: the config file, the run record, and the audit `panel.json` carry none of that. A seat run
uses `--no-extensions`, so the only extensions it loads are the shipped Review panel seat extension plus
the exact absolute paths named in that roster row's `extraExtensionPaths`. If a seat needs a
provider or authentication extension, name it there.

## Package-owned prompts

Holistic review is implicit: a bare review runs `holistic` on every `defaults.seats` alias.
`defaults.lenses` is optional and names always-on specialist extras only (`security`, `tests`,
`contracts`, and the other shipped extras). Omit it. The caller may add extras per review. The
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


