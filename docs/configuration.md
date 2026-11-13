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
  - `prComment` (optional): how review and verify rounds reach the open pull request. `"auto"`,
    the default when the field is absent, posts each round. `"ownerApproved"` posts a round only
    when the call also passes `ownerApproved: true` (CLI `--owner-approved`); without it the reply
    ends with `PR comment: not posted (the owner config asks for approval first)`. Any other value
    refuses the config. See [Posting rounds to the pull request](#posting-rounds-to-the-pull-request).
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
commits, the scoping note, and the planned seat rows (`rosterId`, `lens`, `provider`, `model`, as in
`panel.json`). It holds no prompt text and no extension paths. Each seat's outcome is written to
`seats/<planned index>.json` the moment that seat settles, by a temp file and a rename. A seat torn
down because the run was cancelled is not written there. While a run is going, `run.lock` names its
process; the run removes it when it ends.

### The record key

The record lives in the reviewed repository, which anyone who can get a file into the checkout (a
pushed branch, an applied patch) can write to. So the package signs the files resume relies on
with a key only the owner holds:

- The key is `record-key`, 32 random bytes, in the folder of the owner config:
  `~/.pi-review-panel/record-key` by default, or beside `$PI_REVIEW_PANEL_CONFIG` when that is set.
  It never lives in the reviewed repository, and nothing secret is written to the record.
- The first review or audit creates it, exclusively and with mode `0600`. Resume never creates it.
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
  It cannot see, without writing, a filesystem that refuses hard links; the first review or audit
  then refuses with "could not be created".
- A review or audit writes `plan.mac`, an HMAC-SHA256 of the exact `plan.json` bytes bound to the
  run id. Each seat file gets `seats/<planned index>.mac`, an HMAC of its exact bytes bound to the run
  id, the plan's MAC and the seat's index. So a signed file cannot be edited, moved to another index,
  or copied in from another run.
- Deleting the key makes every interrupted record unresumable; a new one is created by the next
  review or audit. To keep resuming records across machines, copy the key with the config.

### When the record key is refused

Review, audit and resume refuse to start without a usable key, and `diagnose` reports the same
cause as a `record key <path>` row. Resume also refuses when there is no key at all, since it never
creates one. Each cause and its fix:

| `diagnose` or the refusal says | Fix |
| --- | --- |
| `cannot be created: its folder … is not writable by you`, or `could not be created: EACCES` / `EROFS` | `chmod u+w` the folder if you own it. If it is read-only by design (a read-only mount, a Nix or home-manager store link, a sandbox home), set `PI_REVIEW_PANEL_CONFIG` to a `config.json` in a writable folder, mode `0700`, that only you can write. The key is created beside it. |
| `could not be created` on a writable folder (for example `EPERM` from `link`) | The folder's filesystem refuses hard links (some FUSE or SMB mounts). Move the config to a local folder with `PI_REVIEW_PANEL_CONFIG`. |
| `is refused: its folder … is writable by other users` | If you own the folder and it is not sticky, `chmod go-w <folder>`; the fix text says so only then. For a shared sticky folder such as `/tmp`, or one you do not own, never `chmod` it: point `PI_REVIEW_PANEL_CONFIG` at a `config.json` in a folder you own, mode `0700`. |
| Warning only: `its folder … is writable by its group` | Nothing blocks. If anyone else is in that group, `chmod g-w <folder>` (or move the config, as above, when you do not own the folder). |
| `is a symlink and is refused` (stow, chezmoi or a store link) | Replace the link with a regular file: `cp -L` the key's bytes into place, then `chmod 600` it. Or delete the link; the next review or audit creates a new key. |
| `is readable by group or other users and is refused` (a key copied with a `0644` umask, or a `0444` store file) | `chmod 600 <key>`. If others may have read it, delete it instead. |
| `is not owned by you and is refused` | Delete it, and the next review or audit creates one you own. `chown` it only if you know where it came from. |
| `is not 32 bytes and is refused`, or `is not a regular file and is refused` | Delete what is at the key path; the next review or audit creates a new key. |
| `is inside the reviewed repository` | Point `PI_REVIEW_PANEL_CONFIG` at a config outside the repository. |

A new key cannot check records signed with the old one, so those interrupted runs can no longer be
resumed. Start them again as new runs.

### Resuming

`{"action":"resume","priorRunId":"<run-id>"}` finishes an interrupted record in place. It runs the
same readiness check as review and audit first. It takes no seats, lenses, or commits: those come
from `plan.json`. What resume trusts, and what it rebuilds:

- **The plan must carry a valid signature.** A `plan.json` whose `plan.mac` does not match the
  owner's key is refused before it is read: this owner's review_panel did not write it. A
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
  and the seat budget come from the config. The prompt comes from the package's own lens or
  audit-pass table. A seat that fails this check does not run and is not kept, even if it had
  settled; it is reported as lost coverage.
- **The scoping note is not passed on.** The scoping note in `plan.json` does not reach the re-run
  seats, since resume takes no prompt text from the record. The report and the tool's reply say so
  when the record had one.
- **The panel caps still apply.** A plan with more seats than a review panel (16) or an audit (24)
  may have, a review lens other than `holistic` on more than 2 seats, an audit pass on more than 3,
  or one seat twice, is refused.
- **Resume never follows a symlink, and never waits on a FIFO.** Record files are opened without
  following a symlink and without blocking, and anything but a regular file is not read. Each output
  is written to a new temp file that is renamed over the old name, so a planted symlink is replaced,
  not written through. A symlinked `.review-panel`, `runs` or `seats` folder, or a folder where an
  output file belongs, is refused before any seat runs.

The signatures cover what resume reads. `verify` and `comment` still read a complete record
without checking a signature.

Resume takes the run lock before it re-reads the record, pins the recorded head commit, runs only
the planned seats with no settled outcome, then writes `execution.json`, `report.md`,
`findings.json`, `meta.json`, and `COMPLETE` as a first run would. The report has a "Resumed run"
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
no review_panel run is active. A run publishes `run.lock` whole (written to a temp file, then
hard-linked into place), so it never exists empty. On a filesystem without hard links (FAT, exFAT,
some network mounts) it is written in place instead: it can be empty or half-written for a
moment, and stays that way if the process is killed in that moment (a failed write or close
removes it). A `run.lock` that names no pid is therefore one another process is still writing, or
one a crashed process left unfinished: it is refused, never taken over, and the message says to
delete it when no review_panel run is active.

## Posting rounds to the pull request

When a review or verify run's head commit is the head of exactly one open pull request, the tool
posts that round to it as a new comment when the run finishes. It finds the PR with
`gh api repos/{owner}/{repo}/commits/<head-oid>/pulls`, keeping open PRs whose head is that commit;
`pr` (CLI `--pr`) names one instead. The same rule holds for public and private repositories.

- A review posts `## Review panel · review`: the reply's summary, `Seats:`, `Lost:`, findings and
  `Suggest:`, with the run id instead of the local record path.
- Each verify posts `## Review panel · verify N`. N starts one past the earlier verifies of the
  same review whose comment reached the PR (each records that in its run record). The number is
  then claimed in the review's run record, by these rules:
  - The verify skips every N with a `round-<N>.posted`, then creates `round-<N>.claim`
    exclusively (`wx`), holding the verify run id, its process id, the host name and when.
  - After the create it checks `round-<N>.posted` again: another verify can post N and settle
    between the first check and the create. If it is there now, the verify deletes its claim and
    tries N+1.
  - Once the comment is on the PR, the verify writes `round-<N>.posted` exclusively and then
    deletes its claim. If the post fails, it deletes its claim and the reply says so
    (`… ; verify 1 is left for the next verify`), so a waiting or later verify takes that number.
  - A claim another verify still holds is waited on. The verify stops waiting while 30 s of the
    round's 60 s deadline are still left, so a claim it wins always has time for its POST. When it
    gives up it posts no comment for that round, and the reply says
    `PR comment: not posted (another verify is still posting verify N)`.
  - A stale claim, left by a verify that crashed, is never taken over, renamed or removed. It
    stays where it is and the verify tries N+1. A claim is stale when it is older than the round
    deadline plus 5 s (65 s), or when it was made on this host and its process is gone. A claim
    from another host (a shared or synced folder, a container and its host) is judged by age
    alone. A claim with unreadable content is judged by its age on disk.
  - Mutual exclusion comes only from the exclusive create, so two verifies never post the same
    number. A crash can leave a gap in the numbering (`verify 3` after `verify 1`), never a
    duplicate.
  It lists each kept id as resolved, still present or inconclusive with the panel's one-line
  evidence, each `dismissed` id with its reason, each `lowAdvisory` id as not kept, and the
  regressions as new findings. Verify checks `dismissed` and `lowAdvisory` against the review
  record before any seat runs.
- When every verify seat voted (none was lost), each marked every kept id resolved, and none
  reported a regression, the verify also posts the close-out card as a separate comment,
  `## Review panel · close-out`, built from the review, that verify and its `dismissed` and
  `lowAdvisory`. A kept finding of any severity counts as fixed; a kept low need not be listed in
  `lowAdvisory`. Otherwise only the verify comment is posted, and the reply says why, such as
  `PR close-out: not posted (seats disagree on F-2)` or
  `PR close-out: not posted (lost verify coverage: glm/fix-verification)`. The card's `Lost:` line
  names the review's lost seats; it never names a verify seat, because a lost verify seat stops
  the automatic card.
- The close-out posts at most once per review, by these rules:
  - A `closeout.posted` in the review's run record means it is posted. The verify does not ask the
    PR, and the reply says `PR close-out: not posted (this review's close-out is already posted)`.
  - Otherwise the verify creates `closeout.claim-1` exclusively (`wx`), with the same contents as a
    round claim, and checks `closeout.posted` again after the create. Only the creator of a claim
    posts. Before posting it checks the PR's comments for a close-out of this review by the same
    author (the manual card does not count; its heading differs). If one is there it writes
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
- When the card cannot be built (for example a high or medium finding that was neither kept nor
  dismissed with a reason), the reply says why.
- An explicit `pr` must be an open pull request whose head is the run's head. Otherwise nothing is
  posted and the reply says why, such as `PR comment: not posted (PR #7 is not open)`.
- Every post is a new comment. Nothing edits or deletes an earlier one. Audit and resume never post.
- `prComment: false` (CLI `--no-pr-comment`) turns posting off for one run.
- No open PR, more than one, `gh` missing, signed out or failing: nothing is posted, and the reply
  ends with one line saying why, such as `PR comment: not posted (no open PR has this head)`. A
  failed post never fails the run and never changes an exit code.
- Every posted body (the review and verify comments, the automatic close-out and the manual
  `comment` card) uses one sanitizer. Text a seat wrote, dismissed reasons, record fields and refs
  become one line of plain text: line breaks fold to spaces; `` \ ` * _ [ ] ( ) # ! < > | ~ & $ ``
  are backslash-escaped, so no HTML, image, Markdown link, emphasis or heading forms; a zero-width
  joiner follows every `@` and `＠`, every `#` (so `#123` and `owner/repo#123` do not link), the
  `-` in `GH-123`, and the `:` of `://`; the dot of every `www.` is backslash-escaped, so neither a
  URL nor a `www.` address becomes a link (checked with cmark-gfm, GitHub's Markdown engine).
  Control, bidi and invisible characters become U+FFFD, except that an emoji keeps its
  presentation selector (U+FE0F) and the joiners inside an emoji sequence, so `⚠️` posts as
  itself. File names and ids are code spans whose fence is longer than any backtick run inside, so
  they cannot be closed early; nothing is escaped or joined inside them, because GitHub forms no
  mention, reference or link in a code span, and a copied path stays exact. The body is cut by whole rows below
  GitHub's 65,536-character limit (saying how many were cut) and goes to `gh` on stdin.
- `gh` runs asynchronously, so a slow call never blocks Pi; each call has a 30 s limit and one
  round's calls share a 60 s deadline. Interrupting the run (Esc in Pi, Ctrl-C in the CLI) kills a
  running `gh` call. The reply then says `PR comment: not posted (the run was interrupted)`. When
  the interrupt comes after a verify claimed its round number, the claim is given back and the
  reply says so: `PR comment: not posted (the run was interrupted; verify N is left for the next
  verify)`. Comment listings read every page.

The `comment` action is the manual path. After the owner says yes (`ownerApproved: true`), it posts
or updates its own card with the heading `## Review panel`, separate from the automatic
`## Review panel · close-out` comment. Its card is cut by whole rows below the same limit.

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


