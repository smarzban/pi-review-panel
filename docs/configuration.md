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
    "verifySeats":["claude"],
    "consolidator":"claude",
    "lenses":["tests"],
    "seatBudgetMs":1200000
  }
}
```

## Setting up without Pi

The `review-panel` command bundles the Pi SDK, so it needs no Pi install. From an empty home
folder, the whole setup is:

```sh
npm install -g pi-review-panel
review-panel skill install                        # the skill, for each coding agent you have
review-panel auth providers                       # every provider, how it logs in, whether it is logged in
review-panel auth login anthropic                 # an account sign-in (OAuth or a subscription)
review-panel auth login baseten --api-key < key   # or an API key, read from stdin
review-panel models                               # the models those logins give: exact provider and model ids
```

1. `auth providers` lists each provider with its login: `account` (a sign-in in a browser or
   with a device code, including subscriptions), `API key`, or both, and whether it is logged
   in now. A provider whose login is `none` is set up outside the command, with an environment
   variable or `models.json` in the agent folder.
2. `auth login <provider>` signs in (`--api-key` saves a key instead). Logins go to the agent
   folder in use (see [the CLI guide](cli.md#logins-and-the-agent-folder)): without Pi that
   is `~/.pi-review-panel/agent`.
3. `models` lists every model the logins give, one row each with the `provider` and `model`
   ids to copy, the context window, the output limit and whether it thinks. `models
   <provider>` lists all of one provider's models, logged in or not; `--search <text>` narrows
   the list; `--all` lists every model. It ends with a ready-to-copy roster row for the first
   model. The list comes from the bundled SDK's own catalog and `models.json`, and asks no
   provider for its models.
4. A provider that a Pi extension registers, such as `claude-code`, needs that extension.
   Install it into the agent folder:

   ```sh
   review-panel extension install git:github.com/earendil-works/pi-claude-code
   ```

   It uses the bundled SDK's own package manager (the code behind `pi install`), so the
   package lands where Pi would put it (`<agent folder>/git/<host>/<path>`, or
   `<agent folder>/npm/node_modules/<name>` for an `npm:` source) and is recorded in the agent folder's `settings.json`. It prints the
   package's extension entry paths last; one of them goes in the roster row's
   `extraExtensionPaths`. `review-panel extension list` prints them again, and `review-panel
   models` then lists the extension's models with a roster row that already names the path.
   Installing alone gives no seat the extension: a seat loads only the paths in its own row.
   When the agent folder in use is Pi's own `~/.pi/agent`, Pi loads the package in every Pi
   session too, as after `pi install`. Log in to the extension's provider the way the
   extension documents (for `claude-code`, the Claude Code CLI's own login).
5. Write the config (below), with one roster row per seat, then run `review-panel diagnose` in
   a repository. It loads each row's extensions, checks each model and login, and says
   `ready` or what to fix.

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
    a provider or authentication extension. `review-panel extension install` and
    `extension list` print them, and `review-panel models` prints a whole row that names them.
- `defaults`: the run's default selections:
  - `seats`: roster ids, each must name a real roster row, no repeats.
  - `lenses`: package-owned lens names (see below), no repeats.
  - `seatBudgetMs` (optional): per-seat wall-clock budget in milliseconds, an integer from 1 through
    2147483647. Omitted uses the built-in default of 1200000 ms (20 minutes).
  - `verifySeats` (optional): the roster ids that run `verify`, 1 or 2 of them, no repeats. Each
    must name a roster row; it need not be in `seats`. Omitted runs verify on the first `seats`
    entry only. A caller's `seats` (CLI `--seats`) still wins over it. An invalid value refuses the
    config, and `diagnose` names the field and the problem.
  - `consolidator` (optional): one roster id, the grouping seat. It must name a roster row; it need
    not be in `seats`. When it is set and a review submits two or more findings, one more seat runs
    after every reviewer has settled and groups the findings that describe the same defect. See
    [Grouped findings](#grouped-findings). Omitted means no grouping step and today's flat list.
    An invalid value refuses the config, and `diagnose` names the field and the problem.
  - `prComment` (optional): how review and verify rounds reach the open pull request. `"auto"`,
    the default when the field is absent, posts each round. `"ownerApproved"` posts a round only
    when the call also passes `ownerApproved: true` (CLI `--owner-approved`); without it the reply
    ends with `PR comment: not posted (the owner config asks for approval first)`. Any other value
    refuses the config. See [Posting rounds to the pull request](#posting-rounds-to-the-pull-request).
- Unknown fields refuse at every level: the root, each roster row, and `defaults` each reject keys
  they do not declare. Any single error refuses the whole config; there is no partial acceptance.

## Pi identity and authentication

A seat runs as a Pi SDK session inside the `review-panel` process (the CLI bundles the Pi SDK), not
as a separate `pi` process. `provider` and `model` are resolved by exact id through Pi's model
runtime, after the row's own extensions load. They must be Pi identifiers that are configured and
logged in to in the agent folder the CLI uses: your Pi folder `~/.pi/agent` when it holds a login,
otherwise `~/.pi-review-panel/agent`, where `review-panel auth login <provider>` signs in (see
[the CLI guide](cli.md#logins-and-the-agent-folder)). The roster does not create or configure
providers. pi-review-panel stores **no**
credentials, endpoints, or provider definitions anywhere: the config file, the run record, and
`panel.json` carry none of that. A seat suppresses Pi's ambient extensions, skills, prompt
templates, and themes, and loads no context files, so the only extension files it loads are the
exact absolute paths named in that roster row's `extraExtensionPaths`; beside them runs only the
package's own in-process guard that confines tool paths to the seat's snapshot. If a seat needs a
provider or authentication extension, name it there. Only the seat's role tools are active:
read-only `read`, `grep`, `find`, `ls` and `git_diff`, and one submit tool. Results are reported only through that submit tool.

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
`diagnose` moves on to the next row. Because `review` runs `diagnose` first, the bound
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

The public command is `review-panel`. A `review` always plans holistic × `defaults.seats` (or
the caller `seats` override). Optional `defaults.lenses` and caller `lenses` are specialist extras
and each extra runs on at most the first two selected seats. Duplicate effective
provider/model/lens identities and an empty or oversized panel refuse before reviewer work starts.

Unknown fields refuse.

## panel.json, the planned panel

Immediately after the run is reserved, and before any snapshot pinning or seat scheduling, the run
writes `.review-panel/runs/<run-id>/panel.json`: the machine-readable record of what was planned. It
records `runId`, `baseRef`, the optional `scopingNote` verbatim, and the ordered seat rows projected
to exactly `rosterId`, `lens`, `provider`, `model`. It contains no prompt text, extension paths,
credentials, or endpoints. Because it is written before the work begins, an aborted run retains it.

## Grouped findings

Several seats often report one defect, at lines a few apart or in different words, so matching on
file and line misses them. When the owner names a grouping seat in `defaults.consolidator` and a
review submits two or more findings, one more seat runs after every reviewer has settled: an
in-process seat on the same pinned snapshot with only the read-only tools, the package-owned
`grouping` role prompt, and one submit tool, `submit_groups`. It reads every stamped finding (id,
seat, severity, file, line, title, evidence), given as data, not instructions, and submits groups:
lists of F-ids, with every F-id in exactly one group. A finding with no duplicate is a group of one.
A submission with an unknown, missing or repeated id is refused, and the seat may submit again. It
runs within the same per-seat budget (`seatBudgetMs`).

Grouping only groups. It never drops a finding, never edits its text and never changes its
severity: every member keeps its F-id, its seat, its stated severity and its evidence. Groups are
numbered `G-1`, `G-2`, … by the highest severity a seat stated in the group, then by the lowest
member F-id. A group shows that highest severity, labelled as stated by a seat, and the title of its
lowest member F-id. Group size is never shown as agreement or used to rank.

The reply, `report.md` and the PR review comment show the grouped list: one header row per group,
then a row per member with its F-id, severity, own title, seat, `file:line` and evidence. A group of one shows
as one row with both ids. The summary line counts both (`8 findings in 5 groups`), and the Seats
line names the grouping seat (`grouping (claude)`). A group too long for the PR comment posts its header and the
members that fit, then a line counting the members left out (all of them are in `report.md`), and
the groups after it still post when they fit. `findings.json` stays the flat stamped list.
The groups are recorded in one place, `execution.json`, under `grouping`: the grouping seat, its
timing and its outcome, which for a grouping that worked holds `groups`, each
`{ "id": "G-1", "findingIds": ["F-1", "F-3"] }`. `record.mac` signs it with the rest of the
finished record, so it is the grouping the reply and the PR comment showed. No other file holds
groups: the `groups.json` and `groups.mac` that earlier releases wrote are neither written nor read,
and one left in an older record is ignored. The reply's time and cost include the grouping seat.

If the grouping seat fails, times out, runs out of budget or never submits a valid grouping, the
review keeps the flat list and adds one line, `Lost: grouping (<roster id>, <failure class>)`.
`execution.json` records the grouping as lost, with no groups.

`verify` (`keptFindingIds`, `dismissed`, `lowAdvisory`) and `comment` (`dismissed`, `lowAdvisory`)
accept G-ids as well as F-ids. A G-id stands for all of its member F-ids, and a G-id in `dismissed`
gives its reason to each member. The G-ids are checked before any seat runs against the grouping
the review's signed `execution.json` records: it must have grouped exactly the F-ids in
`findings.json`, each once. A review with no grouping step or a lost grouping has no G-ids, so they
are refused, and the message says why and asks for F-ids. An id that names neither a
finding nor a group is refused as before, and so is a list that names one F-id twice, such as
a G-id and one of its own members. Verify itself still checks F-ids, so the verify comment
and the close-out card list F-ids.

## Interrupted runs and `resume`

A review also writes `plan.json` before pinning: its kind, the frozen base and head
commits, the scoping note, and the planned seat rows (`rosterId`, `lens`, `provider`, `model`, as in
`panel.json`). It holds no prompt text and no extension paths. Each seat's outcome is written to
`seats/<planned index>.json` the moment that seat settles, by a temp file and a rename. A seat torn
down because the run was cancelled is not written there; a seat that had already submitted when
the run was cancelled is, so `resume` does not run it again. While a run is going, `run.lock` names its
process; the run removes it when it ends.

### The record key

The record lives in the reviewed repository, which anyone who can get a file into the checkout (a
pushed branch, an applied patch) can write to. So the package signs the files resume relies on
with a key only the owner holds:

- The key is `record-key`, 32 random bytes, in the folder of the owner config:
  `~/.pi-review-panel/record-key` by default, or beside `$PI_REVIEW_PANEL_CONFIG` when that is set.
  It never lives in the reviewed repository, and nothing secret is written to the record.
- The first review creates it, exclusively and with mode `0600`. Resume never creates it.
- It signs `plan.json` (`plan.mac`), each seat file (`seats/<n>.mac`), and every finished review
  and verify record (`record.mac`, written just before `COMPLETE`, which covers a review's
  grouping in `execution.json`). It also signs the posted markers of PR rounds (see
  [Posting rounds to the pull request](#posting-rounds-to-the-pull-request)).
- A key that is a symlink, not a regular file, readable by group or other users, owned by another
  user, not exactly 32 bytes, or inside the reviewed repository is refused, and so is the run that
  needs it. So is a key folder that other users can write, sticky bit or not: whoever can write the
  folder can swap the key for one they hold. A folder only its group can write (`0775`, made by the
  `umask 002` default on Fedora, RHEL, Debian and Ubuntu) is accepted, because a key someone else
  swaps in is owned by them and the owner check refuses it; `diagnose` shows it as a warning that
  does not change readiness. The owner check is skipped where Node has no `process.getuid`
  (Windows), and the mode checks are skipped on Windows.
- `diagnose` checks the key the same way, and never creates it. With no key yet, it checks that the
  folder lets you write and search it (`access(2)`, which also sees a read-only mount and ACLs).
  It cannot see, without writing, a filesystem that refuses hard links; the first review
  then refuses with "could not be created".
- A review writes `plan.mac`, an HMAC-SHA256 of the exact `plan.json` bytes bound to the
  run id. Each seat file gets `seats/<planned index>.mac`, an HMAC of its exact bytes bound to the run
  id, the plan's MAC and the seat's index. So a signed file cannot be edited, moved to another index,
  or copied in from another run.
- A finished review writes `record.mac`, an HMAC-SHA256 bound to the run id (the record's folder
  name), the record kind and the plan's MAC, over the name and SHA-256 of the exact bytes the run
  itself wrote to `plan.json`, `panel.json`, `meta.json`, `findings.json` and `execution.json`
  (a resume signs the `plan.json` bytes whose `plan.mac` it checked). A finished verify writes one
  over `panel.json`, `meta.json` and `verification.json`, with no plan. The run keeps each file's
  text as it writes it and signs that, never what is in the folder at the end, so a file a
  repository writer replaces while the seats run is not signed. These are the files `verify` and
  `comment` read; see [Verify and comment take only signed records](#verify-and-comment-take-only-signed-records).
- Deleting the key makes every interrupted record unresumable and every finished record unusable by
  `verify` and `comment`; a new one is created by the next review. To keep using records
  across machines, copy the key with the config.

### When the record key is refused

Review, resume, verify and comment refuse to start without a usable key, and `diagnose`
reports the same cause as a `record key <path>` row. Resume, verify and comment also refuse when
there is no key at all, since they never create one. Each cause and its fix:

| `diagnose` or the refusal says | Fix |
| --- | --- |
| `cannot be created: its folder … is not writable by you`, or `could not be created: EACCES` / `EROFS` | `chmod u+w` the folder if you own it. If it is read-only by design (a read-only mount, a Nix or home-manager store link, a sandbox home), set `PI_REVIEW_PANEL_CONFIG` to a `config.json` in a writable folder, mode `0700`, that only you can write. The key is created beside it. |
| `could not be created` on a writable folder (for example `EPERM` from `link`) | The folder's filesystem refuses hard links (some FUSE or SMB mounts). Move the config to a local folder with `PI_REVIEW_PANEL_CONFIG`. |
| `is refused: its folder … is writable by other users` | If you own the folder and it is not sticky, `chmod go-w <folder>`; the fix text says so only then. For a shared sticky folder such as `/tmp`, or one you do not own, never `chmod` it: point `PI_REVIEW_PANEL_CONFIG` at a `config.json` in a folder you own, mode `0700`. |
| Warning only: `its folder … is writable by its group` | Nothing blocks. If anyone else is in that group, `chmod g-w <folder>` (or move the config, as above, when you do not own the folder). |
| `is a symlink and is refused` (stow, chezmoi or a store link) | Replace the link with a regular file: `cp -L` the key's bytes into place, then `chmod 600` it. Or delete the link; the next review creates a new key. |
| `is readable by group or other users and is refused` (a key copied with a `0644` umask, or a `0444` store file) | `chmod 600 <key>`. If others may have read it, delete it instead. |
| `is not owned by you and is refused` | Delete it, and the next review creates one you own. `chown` it only if you know where it came from. |
| `is not 32 bytes and is refused`, or `is not a regular file and is refused` | Delete what is at the key path; the next review creates a new key. |
| `is inside the reviewed repository` | Point `PI_REVIEW_PANEL_CONFIG` at a config outside the repository. |

A new key cannot check records signed with the old one, so those interrupted runs can no longer be
resumed, and those finished reviews can no longer be verified or commented on. Start them again as
new runs.

### Resuming

`review-panel resume --prior-run-id <run-id>` finishes an interrupted record in place. It runs the
same readiness check as review first. It takes no seats, lenses, or commits: those come
from `plan.json`. What resume trusts, and what it rebuilds:

- **The plan must carry a valid signature.** A `plan.json` whose `plan.mac` does not match the
  owner's key is refused before it is read: this owner's review-panel did not write it. A
  `plan.json` with no `plan.mac` at all is refused as a run interrupted before its plan was signed
  (`plan.json` is written first); no seat had run, so start a new run. A
  signed plan must also have the expected shape. Its `baseRef` and seat names must hold no control
  characters, so record text cannot add a heading or a fake finding to the report or the reply.
- **A seat file is kept only when it is signed, names its seat, and has a valid outcome.** It needs a
  valid MAC, must name the planned roster row, provider, model and lens, and must match the outcome
  schema (findings exactly as `submit_findings` accepts them). Anything else counts as unsettled,
  and that seat runs again: an unsigned or forged file, an unreadable file, or a symlink.
- **Only the timing and the outcome are taken from a kept seat file.** Its seat, prompt, extension
  paths and replay input in `execution.json` are rebuilt from the owner config and the package.
- **Every planned seat is checked against the owner config, settled or not.** The roster row with
  that `rosterId` must still exist and name the same `provider` and `model`. `extraExtensionPaths`
  and the seat budget come from the config. The prompt comes from the package's own lens
  table. A seat that fails this check does not run and is not kept, even if it had
  settled; it is reported as lost coverage.
- **The scoping note is not passed on.** The scoping note in `plan.json` does not reach the re-run
  seats, since resume takes no prompt text from the record. The report and the tool's reply say so
  when the record had one.
- **The panel caps still apply.** A plan with more seats than a review panel (16) may have, a
  review lens other than `holistic` on more than 2 seats, or one seat twice, is refused.
- **An audit record is refused.** Earlier versions also wrote signed plans for a repository audit.
  Audit was removed, so resume refuses such a record ("audit records can no longer be resumed")
  before any seat runs.
- **Resume never follows a symlink, and never waits on a FIFO.** Record files are opened without
  following a symlink and without blocking, and anything but a regular file is not read. Each output
  is written to a new temp file that is renamed over the old name, so a planted symlink is replaced,
  not written through. A symlinked `.review-panel`, `runs` or `seats` folder, or a folder where an
  output file belongs, is refused before any seat runs.

The signatures cover what resume reads, what `verify` and `comment` read, and the grouping that
G-ids are read from.

Resume takes the run lock before it re-reads the record, pins the recorded head commit, runs only
the planned seats with no settled outcome, then writes `panel.json` (from the signed plan),
`execution.json`, `report.md`, `findings.json`, `meta.json`, `record.mac` and `COMPLETE` as a first
run would, so a resumed review can be verified. With a `consolidator` set, the
grouping step runs again at the end over the finished list, and the grouping `execution.json`
records (none, without a `consolidator`) always matches the final F-ids. The report has a "Resumed run"
section naming the seats kept, the seats run again and the seats lost, and `execution.json` lists
the re-run seats under `resumedSeats`. Resume refuses a complete record, an unknown run, a record
whose `run.lock` names a live process, a record with no `plan.json` (a run that stopped before its
plan was written, when no seat had run, or one from an earlier version), a head or base commit
that no longer resolves, and verify runs: verify runs one or two seats in sequence, so a fresh
verify costs the same as a resume.

A `run.lock` left by a process that has exited is replaced. The replacement happens only while
holding `run.lock.takeover`, created exclusively, so two resumes can never both take over the same
lock. If a process dies in that instant, the next resume refuses and names the file to delete. A
`run.lock` whose pid now belongs to an unrelated live process also refuses; delete `run.lock` when
no review-panel run is active. A run publishes `run.lock` whole (written to a temp file, then
hard-linked into place), so it never exists empty. On a filesystem without hard links (FAT, exFAT,
some network mounts) it is written in place instead: it can be empty or half-written for a
moment, and stays that way if the process is killed in that moment (a failed write or close
removes it). A `run.lock` that names no pid is therefore one another process is still writing, or
one a crashed process left unfinished: it is refused, never taken over, and the message says to
delete it when no review-panel run is active.

### Verify and comment take only signed records

`verify` and `comment` read a finished review record (and `comment` a finished verify record) from
the reviewed repository, where anyone who can get a file into the checkout could plant one marked
`COMPLETE`. So they take a record as the owner's own only when it is signed with the owner's record
key:

- They read the record key, and never create it. No key, or a key that is refused for any reason
  above, refuses the call with the key's cause and fix.
- The record must sit in this repository's own `.review-panel/runs`: a `.review-panel` or `runs`
  folder that is a symlink is refused, by run name and by record path.
- A review record needs a `plan.json` of kind `review` with a valid `plan.mac`, and a `record.mac`
  that matches the exact bytes of its `plan.json`, `panel.json`, `meta.json`, `findings.json` and
  `execution.json`, bound to its own run id. A verify record named by `comment`'s `verifyRunId`
  needs a `record.mac` over its `panel.json`, `meta.json` and `verification.json`. Each file is
  read once, and only those signed bytes are used: verify builds the automatic close-out card from
  the review it checked before any seat ran, and checks G-ids against those signed findings, so a
  file changed while the seats run changes nothing posted. Review and resume reply and post the
  findings the run itself stamped, never `findings.json` read back after the record was sealed.
- The key is per owner, not per repository, so a review record's `meta.json` must also name a base
  and a head commit this repository holds; a signed record copied in from another repository is
  refused with "not a commit in this repository". A record from another clone of the same
  repository still passes, and a shallow checkout that lacks the record's base commit refuses the
  owner's own record (fetch more history, or run a new review).
- Anything else is refused: an unsigned record, one signed with another key, a signed record copied
  to another run id, or a signed file copied in from another run. The refusal says the record is not
  signed by this owner's record key and to run a new review. Verify refuses before any seat runs,
  and comment before anything is posted.
- Records written before records were signed have no `record.mac`, and cannot be told apart from
  planted ones, so they are refused too: run a new review.

When a call names a G-id, it expands only from the grouping in the review's signed
`execution.json`; G-ids are refused, asking for F-ids, when that grouping is absent or lost.

A review reads no earlier record. The verify round number and the close-out read only signed records and
signed markers (see [Posting rounds to the pull request](#posting-rounds-to-the-pull-request)).

## Posting rounds to the pull request

When a review or verify run's head commit is the head of exactly one open pull request, the tool
posts that round to it as a new comment when the run finishes. It finds the PR with
`gh api repos/{owner}/{repo}/commits/<head-oid>/pulls`, keeping open PRs whose head is that commit;
`pr` (CLI `--pr`) names one instead. The same rule holds for public and private repositories.

- A review posts `## Review panel · review`: the commit range, the reply's summary, `Seats:`,
  `Lost:`, findings and `Suggest:`, without the local record path. Labels the tool writes are bold;
  seat text never is. No run id appears in visible text: every posted body (review, verify, the
  automatic close-out and the manual `comment` card) ends with one hidden HTML comment carrying the
  ids that apply, such as `<!-- review-panel review=<review run id> verify=<verify run id> -->`.
  An id outside the run-id characters (`A-Z a-z 0-9 . _ -`) is left out of the marker. A review
  comment starts like this:

  ```
  ## Review panel · review
  `origin/main` (`b89f012`) → `0a68179`
  6/6 voted · 8 findings · 1m 58s · $1.1017
  **Seats:** holistic (sol, opus), tests (sol, opus), security (sol, opus)

  - **F-1 [high]** Escape the Seats line (`src/tool/review-presentation.ts:511`) — sol/holistic
    **Evidence:** renderSeatsLine joins roster ids without escaping …
  ```
- Each verify posts `## Review panel · verify N`. N starts one past the earlier verifies of the
  same review whose comment reached the PR: complete verify records signed with the owner's record
  key (`record.mac`) whose signed `meta.json` names this review, each holding a signed
  `round.posted`. The number is then claimed in the review's run record, by these rules:
  - Every posted marker (`round-<N>.posted` and `closeout.posted` in the review's record,
    `round.posted` in a verify's) holds the verify run id and a MAC from the owner's record key
    bound to the record's run id, the marker's file name and that verify. A marker without a valid
    MAC (planted in the repository, copied from another record or round, or written before markers
    were signed) counts as no marker, and the verify that posts that round or card replaces it
    with a signed one.
  - The verify skips every N with a signed `round-<N>.posted`, then creates `round-<N>.claim`
    exclusively (`wx`), holding the verify run id, its process id, the host name and when.
  - After the create it checks `round-<N>.posted` again: another verify can post N and settle
    between the first check and the create. If it is there now, the verify deletes its claim and
    tries N+1.
  - Once the comment is on the PR, the verify writes `round-<N>.posted` exclusively and then
    deletes its claim. If the post fails, it deletes its claim and the reply says so
    (`… ; verify 1 is left for the next verify`), so a waiting or later verify takes that number.
  - A claim another verify still holds is waited on. The verify stops waiting while 30 s of the
    round's 60 s deadline are still left, and once it has waited it takes no claim after that
    point, so a claim it wins after waiting always has time for its POST. When it gives up it
    posts no comment for that round, and the reply says
    `PR comment: not posted (another verify is still posting verify N)`.
  - A stale claim, left by a verify that crashed, is never taken over, renamed or removed. It
    stays where it is and the verify tries N+1. A claim is stale when it is older than the round
    deadline plus 5 s (65 s), or when it was made on this host and its process is gone. A claim
    from another host (a shared network folder, a container and its host) is judged by age
    alone. A folder synced by Dropbox, iCloud or Syncthing is not supported: an exclusive create
    does not exclude anything across a sync. A claim with unreadable content is judged by its age on disk.
  - Mutual exclusion comes only from the exclusive create, so two verifies never hold the same
    number at once. A crash can leave a gap in the numbering (`verify 3` after `verify 1`), never a
    duplicate. One case is set aside: when `gh` reports a POST as failed (it timed out or was
    interrupted) after GitHub had already accepted it, the number is given back and the next
    verify posts it again.
  It lists each kept id as resolved, still present or inconclusive with the panel's one-line
  evidence, each `dismissed` id with its reason, each `lowAdvisory` id as not kept, and the
  regressions as new findings. Verify checks `dismissed` and `lowAdvisory` against the review
  record before any seat runs.
- When every verify seat voted (none was lost), each marked every kept id resolved, and none
  reported a regression, the verify also posts the close-out card as a separate comment,
  `## Review panel · close-out`, built from the review, that verify and its `dismissed` and
  `lowAdvisory`. A kept finding of any severity counts as resolved; a kept low need not be listed in
  `lowAdvisory`. Otherwise only the verify comment is posted, and the reply says why, such as
  `PR close-out: not posted (seats disagree on F-2)` or
  `PR close-out: not posted (lost verify coverage: glm/fix-verification)`. The card has a `Lost:`
  line only when a review seat was lost; it never names a verify seat, because a lost verify seat
  stops the automatic card. See [The close-out card](#the-close-out-card) for what it shows.
- The close-out posts at most once per review, by these rules and with the exceptions below:
  - A signed `closeout.posted` in the review's run record means it is posted. The verify does not
    ask the PR, and the reply says
    `PR close-out: not posted (this review's close-out is already posted)`. An unsigned one does
    not stop the card: the verify goes on to claim it, checks the PR's comments as below, and
    replaces the marker once the card is posted or found.
  - Otherwise the verify creates `closeout.claim-1` exclusively (`wx`), with the same contents as a
    round claim, and checks `closeout.posted` again after the create. Only the creator of a claim
    posts. Before posting it checks the PR's comments for a close-out of this review by the same
    author: the first line is `## Review panel · close-out` and the last non-empty line is exactly
    that review's hidden marker (the manual card does not count; its heading differs). Seat text
    cannot make that line, because posted text escapes `<`. A review whose id cannot be in a marker
    is never found this way. If one is there it writes
    `closeout.posted` and posts nothing: `PR close-out: not posted (a close-out for this review is
    already on PR #12)`.
  - A posted card writes `closeout.posted` exclusively, then deletes the claim. A failed post
    deletes the claim, so a later verify can post it.
  - A live claim means another verify is posting it:
    `PR close-out: not posted (another verify is posting this review's close-out)`.
  - A stale claim (the same rule as for rounds) is never taken over. The verify checks the PR's
    comments for the card. If it is there, the verify writes `closeout.posted` and stops. If not,
    it tries `closeout.claim-2`, and so on up to `closeout.claim-5`. When all five are stale and
    the card is not on the PR, nothing is posted, and the reply says
    `PR close-out: not posted (closeout.claim-1 to closeout.claim-5 were all left by verifies that
    stopped; delete them from the review's run record to post it)`.
  - One case is set aside: a verify that crashes after GitHub accepted the card but before it
    wrote `closeout.posted`. The PR-comment check catches it, so the next verify finds the card
    and posts no second one.
  - Another is set aside: a verify that is still posting but whose claim looks stale to another
    verify can lead to a second card. That happens when it pauses for over 65 s mid-post, when
    its machine's clock runs over 65 s behind the other's, or when it runs in a container that
    shares the host's hostname in its own process namespace.
- What someone who can write files into the checkout can still do, and what they cannot:
  - Planting a record or a marker changes nothing: only signed ones count toward `verify N`, skip
    a round or stop the close-out.
  - Claims are not signed, so planted claims still act as claims. A planted `round-<N>.claim` that
    looks stale is skipped, so planting `round-1.claim` to `round-K.claim` makes the next verify
    post `verify K+1`. One that looks live (a `claimedAt` in the future, or another host's
    process) holds that round: the verify waits and then posts no comment for it. A planted
    `closeout.claim-<g>` that looks live makes the verify say another verify is posting the
    close-out; five that look stale end as "all left by verifies that stopped". A planted claim
    can bump the number or stop an automatic post, never forge a post or post a second card; the
    reply says why, and `comment` still posts the card on the owner's yes.
  - Deleting a genuine marker undoes it: a deleted `closeout.posted` is caught by the PR-comment
    check, so no second card posts, but with both a review's `round-<N>.posted` and the verify's
    `round.posted` deleted, the next verify can post `verify N` again.
  - Markers written before markers were signed are ignored in the same way.
- When the card cannot be built (for example a high or medium finding that was neither kept nor
  dismissed with a reason), the reply says why.
- An explicit `pr` must be an open pull request whose head is the run's head. Otherwise nothing is
  posted and the reply says why, such as `PR comment: not posted (PR #7 is not open)`.
- Every post is a new comment. Nothing edits or deletes an earlier one. Resume never posts.
- `prComment: false` (CLI `--no-pr-comment`) turns posting off for one run.
- No open PR, more than one, `gh` missing, signed out or failing: nothing is posted, and the reply
  ends with one line saying why, such as `PR comment: not posted (no open PR has this head)`. A
  failed post never fails the run and never changes an exit code.
- Every posted body (the review and verify comments, the automatic close-out and the manual
  `comment` card) uses one sanitizer. Text a seat wrote, dismissed reasons, record fields and refs
  become one line of plain text: line breaks fold to spaces; only what can form Markdown or HTML is
  backslash-escaped: `` \ ` * _ [ ] < > | ~ & ``, `!` before `[`, and at the start of the text
  `#`, `-`, `+`, `=` and the `.` or `)` of a list number, so no HTML, image, Markdown link,
  emphasis, list or heading forms. `&` stays escaped because GitHub decodes an entity such as
  `&commat;` or `&num;` after the text is parsed, which would bring back the `@` or `#` the joiners
  broke. Every `$` posts as `<span>$</span>`: GitHub renders `$…$` as math, which can colour,
  hide or resize text, and it does so on `\$` and `&#36;` too (checked with `gh api markdown`).
  A dollar inside an element stays a plain dollar, except that a paragraph of nothing but
  `<span>$</span><span>$</span>…<span>$</span><span>$</span>` still renders as display math, so
  a zero-width joiner goes between adjacent dollar spans. Each text field is cut to its length in
  characters (300 for a title, 1,000 for evidence) before escaping, and to at most twice that
  once escaped, never inside an escape or a dollar span; so a title of dollars posts 40 of them,
  and a few such findings cannot crowd the rest of a body out. Parentheses, braces, quotes
  and dots stay plain; a zero-width
  joiner follows every `@` and `＠`, every `#` (so `#123` and `owner/repo#123` do not link), the
  `-` in `GH-123`, and the `:` of `://`; the dot of every `www.` is backslash-escaped, so neither a
  URL nor a `www.` address becomes a link (checked with cmark-gfm, GitHub's Markdown engine).
  Control, bidi and invisible characters become U+FFFD, except that an emoji keeps its
  presentation selector (U+FE0F) and the joiners inside an emoji sequence, so `⚠️` posts as
  itself. File names and ids are code spans whose fence is longer than any backtick run inside, so
  they cannot be closed early; nothing is escaped or joined inside them, because GitHub forms no
  mention, reference or link in a code span, and a copied path stays exact. The body is cut by
  rows, in order, below GitHub's 65,536-character limit (saying how many were cut) and goes to
  `gh` on stdin. A plain row that does not fit ends the list. A group that does not fit whole
  posts its header, its first member and a line counting the members cut (all are in
  `report.md`), and the rows after it are still tried in order; once every row is placed, the
  space left goes to the further members of each group posted in part, in order. So a later
  group can post whole while an earlier one posts in part. A group that cannot fit even its
  header and first member ends the list like a plain row: the rows cut are always the last ones,
  and a lower row never posts in place of a higher one that was cut.
- `gh` runs asynchronously, so a slow call never blocks Pi; each call has a 30 s limit and one
  round's calls share a 60 s deadline. Interrupting the run (Esc in Pi, Ctrl-C in the CLI) kills a
  running `gh` call. The reply then says `PR comment: not posted (the run was interrupted)`. When
  the interrupt comes after a verify claimed its round number, the claim is given back and the
  reply says so: `PR comment: not posted (the run was interrupted; verify N is left for the next
  verify)`. Comment listings read every page.

The `comment` action is the manual path. After the owner says yes (`ownerApproved: true`), it posts
or updates its own card with the heading `## Review panel`, separate from the automatic
`## Review panel · close-out` comment. Its card is cut by whole rows below the same limit.

### The close-out card

Both cards, the automatic close-out and the manual `comment` card, read like this:

```
## Review panel · close-out

**4 findings** (4 medium) · **4 resolved** in 1 verify round
**Review seats:** holistic (sol, opus), tests (sol, opus), security (sol, opus), correctness (sol, opus)
**Verified by:** fix-verification (sol)
`origin/main` (`5852b7e`) → `baf4d30` · [review](…) · [verify 1](…)

- **F-1 [medium]** <title> · resolved in verify 1
- …

<!-- review-panel review=… verify=… -->
```

- The counts line names the findings submitted with their counts by severity (high, medium,
  low), the findings resolved and in how many verify rounds, and then the dismissed and
  low/advisory counts. A count of zero is left out.
- `Review seats:` is the review's seats grouped by lens, in the reply's format. `Verified by:` is
  the seats that voted in each counted verify round, each once, grouped the same way; a verify
  seat that was lost is not named.
- `Lost:` appears only when a seat was lost. The `### Dismissed` section (each id with its title
  and reason) and the `### Low / advisory (not kept)` section appear only when they have ids.
- The range shows the base ref only when it is not itself a commit id (a full or abbreviated SHA
  of the base); the head is one short SHA: the commit the card's verify checked, or for a
  `comment` card with no `verifyRunId`, the review's head. `comment` checks and uses a
  `verifyRunId` whenever one is given, even when every finding is dismissed or left as
  low/advisory, and requires one only when ids are left resolved. `comment`'s `head` (`--head`) is
  still accepted and no longer shown.
- Each kept finding is listed, by severity, as `resolved in verify N`. A round marks an id
  resolved when every voting seat that answered for it said resolved; N is the earliest counted
  round that did so after which every later counted round that answered for the id also said
  resolved (so resolved in verify 1, split in verify 2 and resolved in verify 3 reads verify 3).
  A verify round's number is the `verify N` its comment posted as, read only from the file name of
  the review record's signed `round-<N>.posted` (never from a field inside it); its voting seats
  and dispositions come from its own signed verify record. The card counts its own verify and the
  posted rounds before it. A verify that never posted (for example, run with `--no-pr-comment`
  and then named in `comment`'s `verifyRunId`) counts as a round with no number, after the posted
  rounds reserved before it (by the time in each run id, which `record.mac` binds; a run id with no
  time cannot be placed), and its ids read plain `resolved`. The card never says “fixed”.
- The range line links to the review comment and to each counted verify's comment on the same
  PR, when they can be found among the PR's comments: by this author, first line the round's
  heading (`## Review panel · review` or `## Review panel · verify N`), last non-empty line exactly
  that round's hidden marker. The link goes to the `html_url` gh gave for that comment, and only
  when it is exactly this PR's comment URL (`https://<host>/<owner>/<repo>/pull/<n>#issuecomment-<id>`).
  The automatic card links its own verify comment by the URL gh gave when it was posted. A comment
  that cannot be found gets no link, and the card still posts. Only the last 10 verify comments
  are linked, after a `…`, so the range line stays short however many rounds there were.
- When the list is too long, rows are cut from the end, with the usual line counting them; the
  counts stay in the head and the hidden marker stays last.

## Snapshot cleanup

Each run reviews a detached worktree in the system temp folder. It sits in a private holder folder
named `review-panel-snapshot-*` (mode `0700`, so no other user can put anything in it), beside an
`owner.json` file (mode `0600`) naming the process and repository that made it. The owner file is
created exclusively, never through a symlink, before the worktree is added. At the start of every
run the package removes this repository's snapshots whose owner process has exited, each by its
exact path (`git worktree remove --force`; when the folder is already gone, only that worktree's
own registration is dropped). It never runs a repository-wide `git worktree prune`, so another
worktree whose folder is away for a while keeps its registration. A snapshot whose owner is alive,
or that belongs to another repository, is never removed.

The temp folder can be shared with other users (`/tmp` on Linux), so the sweep trusts nothing it
finds there on sight. It touches only folders you own directly in the temp folder, and never
follows a symlink. It reads an owner file only inside a holder you own that no one else can write
and that is not itself a worktree, and only when the file is a regular file you own with a single link. A `<name>.owner.json` file
beside a folder is never read. A snapshot with no trusted owner file (made by an earlier version)
is removed only when it is registered as a worktree of this repository and is more than 24 hours
old.


