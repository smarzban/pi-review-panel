# Internals

Maintainer notes: how the package behaves and why, in more detail than `AGENTS.md` carries.
The user-facing reference is [configuration.md](configuration.md) and [cli.md](cli.md). When
code changes one of these behaviours, change the passage here in the same commit.

## What the package does

**pi-review-panel** runs multi-model code review as one command, `review-panel`, published from the
npm package `pi-review-panel` (`diagnose` / `suggest` / `review` / `verify` / `resume` /
`comment`, plus `call '<json>'`, `auth`, `models`, `extension` and `skill`). The package ships one agent-neutral skill,
`skills/review-panel`, which every coding agent (Claude Code, Codex, Grok, Pi) uses to run the
command. A run fans N reviewer *seats* — each an exact `provider/model` paired with a package-owned
lens — over one pinned snapshot, as isolated Pi SDK sessions inside the `review-panel` process that
have only their read-only role tools and can report findings only through their submit tool
(`submit_findings` for reviewers).
Seat identity is owner authority: an outside-repository roster config
(`~/.pi-review-panel/config.json`, override `PI_REVIEW_PANEL_CONFIG`) selects exact `provider/model`
rows and package-owned lens prompts by name; the calling agent chooses only among declared names.
Runs record under `<repo>/.review-panel/runs/`, each seat as it settles. `resume` finishes an
interrupted review record, running only its unsettled seats at the recorded head, and refuses an
audit record left by an older version (the repository audit was removed). Review
signs `plan.json` and each seat file with `record-key` beside the owner config (never in
the repository); resume refuses an unsigned plan and re-runs an unsigned seat. A finished review
(first run or resume) and a finished verify also write `record.mac` just before `COMPLETE`: an
HMAC bound to the run id (the folder name), the kind and the plan's MAC, over the exact bytes the
run itself wrote to the files verify and comment read (kept on the record handle as written; the
folder is never re-read to sign). Verify and comment take a record only when that MAC and (for a
review) `plan.mac` check out with the owner's key, which they never create, the `.review-panel` and
`runs` folders are not symlinks, and the review's base and head are commits in this repository;
an unsigned, foreign, copied or pre-signing record is refused with "run a new review", before any
seat runs or post. They use only the bytes they authenticated (the close-out card and G-ids too).
Review and resume reply and post the findings the run stamped, never `findings.json` read back.
A review's groups live only in its signed `execution.json` (`grouping`); there is no
`groups.json` or `groups.mac` any more, and one left in an older record is never read.
Verify reads those trees and writes only its posting claims and signed markers into the review's
record (`round-<N>.claim`, `round-<N>.posted`, `closeout.claim-<g>`, `closeout.posted`). The output is a
presentation-only report: severity-ordered, seat-attributed, with seat failures tallied as lost
coverage. **The tool never judges.** There is no verdict, no agreement arithmetic, and no
review-derived semantic stop signal: agents judge, and the human is the merge gate.
One step may group findings: the grouping seat the owner names in config (`defaults.consolidator`)
reads the submitted findings and puts findings that describe the same defect in one group (`G-1`,
...). Grouping never drops, rewrites or re-rates a finding: each group keeps every member id, its
seat attribution, stated severity and evidence, and shows the highest severity a seat stated. Group
size is never shown as agreement or used to rank. A failed or invalid grouping leaves the ungrouped
list and is named as lost grouping.

Install with `npm install -g pi-review-panel` (puts `review-panel` on PATH), then
`review-panel skill install`, which symlinks the package's `skills/review-panel` into each agent's
skills folder (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `$CODEX_HOME` or `~/.codex`, `$GROK_HOME` or
`~/.grok`, `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, each `/skills`). An agent counts only when its
home folder exists; `--agent` names agents and creates their skills folder; a `review-panel` entry
that is not this package's link is replaced only with `--force`, which requires `--agent`; Windows gets a copy with a version
stamp; `skill uninstall` removes only this package's link or copy (a stamped copy that holds a file the
package does not ship is left alone without `--force`); an old `pi-review` skill gets a
hint, never a delete. Pi's folder comes from the environment as launched, because `main.ts` pins
`PI_CODING_AGENT_DIR` for the SDK before any command runs. The `pi` manifest lists only `skills`,
so `pi install` still loads the skill, but the npm install is the supported path. A `call` object
may omit `repository`, or pass `/`, to use the current folder's Git top-level; `--repo` or an
explicit real path wins. `audit` (command or `call` action) is refused with a message that the
repository audit was removed, not as an unknown command. Review and verify post each round to the
one open PR whose head is the run's head, by default, as a new comment (`## Review panel · review`,
`## Review panel · verify N`); a verify where every verify seat voted, each marked every kept id resolved, and none reported a
regression also posts the close-out card on its own (`## Review panel · close-out`, once per
review). The card is presentation, not a verdict: the agents judge and the owner merges.
`--no-pr-comment` (`prComment: false` in a `call` object) turns posting off for a run, and owner config
`defaults.prComment: "ownerApproved"` makes every post need `--owner-approved`. A post that
cannot be made is one reply line, never a run failure.
`comment` stays the manual path: it posts or updates one PR card after the owner says yes
(`--owner-approved`), found later by author plus heading `## Review panel`. It posts only to an
open PR whose head is the commit the card is about: the one `--pr` names, or the one open PR at
that head. Both cards list each
kept id as “resolved in verify N” (N the earliest counted round that marked it resolved after
which every later counted round that answered for it also said resolved; round numbers only from
the review record's signed `round-<N>.posted` file names; plain “resolved” for a verify that never
posted), presentation only: never the word “fixed”, no “ready to merge.” They show counts by
severity and hide zero counts, `Review seats:` and `Verified by:` (the seats that voted in each
counted round, from signed verify records; a lost seat is not named), `Lost:` only when a seat
was lost, the base ref only when it is not itself a commit id, the head as one short SHA, and
links to the review and the last 10 verify comments on the same PR when they can be found
(author, first-line heading and marker as the last line, at the `html_url` gh gave for that
comment on this PR; a comment not found has no link and never stops the post). A card counts its
own verify and the posted rounds before it (by round number, or for an unposted `comment`
`verifyRunId` by the time in each run id, which `record.mac` binds). `comment` authenticates and
uses a supplied `verifyRunId` whenever one is given, and requires one only when ids are left
resolved. Remaining high/medium ids count as resolved only when a verify
run whose `priorRunId` is this review marks them resolved. Every agent's skill runs the
`review-panel` command directly; it never starts another agent session.

Setup needs no Pi install. `auth providers` lists every provider of the bundled SDK's model
runtime (built-ins and `models.json`) with its login kinds and `getProviderAuthStatus`, after one
availability pass. `models` loads one isolated runtime per group, through the seat's own
`createIsolatedServices` (no ambient resources, only the group's extension paths): the base
group with no extension, then each extension entry of each package installed in the agent
folder (one group per entry, so a roster row names only the entry that registered its
provider), then each `--extension` file. An extension group lists only the providers it registered itself, each row
carrying that group's paths as `extraExtensionPaths`; each group load is bounded at 30 s
(`READINESS_ROW_TIMEOUT_MS`), and a failed or hung group is a `Problems:` line, never a failed
command. Availability is `getAvailable(provider)` per provider: the SDK's static catalogs and the
provider's own check, with `allowModelNetwork: false`, so no request lists models.
`extension install | list | remove` drive the SDK's `DefaultPackageManager` (the code behind
`pi install`) on the agent folder: its working folder is the agent folder and project settings
are untrusted, and only `scope: "user"`, `origin: "package"` resources are listed, so nothing
from the folder the command runs in (a reviewed repository's `.pi/`) is read, installed or
loaded. Entry paths come from `resolve()` with every missing package skipped, never installed.
The package manager runs `git` and `npm` with inherited stdio, so their output reaches stdout:
`extension install` prints the entry paths last, and only `extension list` has `--json`. When
the agent folder is `~/.pi/agent`, install and remove change Pi's own `packages`, and the
output says so. Setup commands race the run's abort signal, so the first Ctrl-C ends them at
once; the per-group timer stays referenced while it waits (an extension that awaits a promise
that never settles holds no handle, and an unreferenced timer would let Node end the process
with the top-level await unsettled). Install and remove set `GIT_TERMINAL_PROMPT=0`. `extension
install` refuses a non-local source that carries a credential (`carriesCredential`: anything
`redactSecrets` would change) before the package manager runs, because Pi's generic Git parser
keeps a scheme-less source's user info in the clone folder's host segment and a query in its
path, stores the source in `settings.json`, and git prints the folder. Every printed source and
path, `--json` included, still goes through `redactSecrets` for sources recorded earlier; the
package manager gets the source as given.

Prompt files under `prompts/` have no trailing newline (tests assert that). Extra lenses fire when
their trigger matches: `tests` means thin or missing coverage including an untested production
handoff, not “zero test files”, and also any added, rewritten, or deleted test, which the lens
checks for tests that cannot fail, are flaky by construction, or are not worth keeping, and for
deleted tests that leave a contract unproven. The example config makes `tests` an owner default.
`contracts` means OpenAPI / proto / GraphQL, not app or TOML config. Review seats must name a concrete failure and an actual consumer.

## Grouping

Grouping (`src/run/grouping.ts`) only groups. With `defaults.consolidator` set and two or more
findings, one grouping seat runs after every reviewer settles, on the same snapshot with the
read-only tools and `submit_groups`, which refuses any submission that does not place every F-id
in exactly one group. It never drops, rewrites or re-rates a finding: the groups hold ids
only, every member keeps its F-id, seat, stated severity and evidence, and a group shows the
highest severity a seat stated. Groups are numbered `G-1`, … by that severity, then the lowest
member F-id; size never ranks and is never shown as agreement. A failed, invalid or timed-out
grouping keeps the flat list and adds `Lost: grouping (<roster id>, <class>)`. The grouping seat
is not a reviewer: it is never in `outcomes`, a vote count or lost reviewer coverage. G-ids in
`keptFindingIds`, `dismissed` and `lowAdvisory` expand to F-ids before any seat runs, only from
the grouping the review's signed `execution.json` records (the one its reply showed), and only
when it grouped every F-id once; no grouping step or a lost grouping refuses G-ids. Verify itself
sees F-ids. Resume always runs the grouping step again and rewrites `execution.json`.

## Posted text

Review and verify post each round to the open PR by default, always as a new comment that is
never edited or deleted; resume never posts. The automatic close-out posts only after
a verify with no lost seat, every voting seat marking every kept id resolved, and no
regressions. An explicit `pr` must be open with the run's head as its head.
Every posted body (review, verify, the automatic close-out and the manual `comment` card) goes
through `src/tool/posted-text.ts`: seat text, record fields and refs are one line of plain
text with only what can form Markdown or HTML backslash-escaped (`\` `` ` `` `*` `_` `[` `]` `<`
`>` `|` `~` `&`, `!` before `[`, and at the start of the text `#`, `-`, `+`, `=` and the `.` or
`)` of a list number; `&` stays escaped so no entity decodes into `@`, `#` or `://`), a
zero-width joiner after every `@`, `＠` and `#`, in `GH-123` and in `://`, the dot of `www.`
backslash-escaped, and control, bidi and invisible characters replaced (an emoji keeps its
U+FE0F and in-sequence joiners); every `$` posts as `<span>$</span>`, because GitHub runs
math (which can colour, hide or resize text) on `\$` and `&#36;` too, with a zero-width
joiner between adjacent dollar spans, because a paragraph of only `<span>$</span><span>$</span>
… <span>$</span><span>$</span>` still renders as display math; parentheses, braces,
quotes and dots stay plain. A text field is cut by code points before escaping and to at most
twice its length once escaped (`POSTED_TEXT_GROWTH`), never inside an escape or a dollar span,
so its posted size has a fixed cap. The only links the tool writes are the close-out card's
links to this PR's own comments (`postedLink`), whose URL must be exactly
`https://<host>/<owner>/<repo>/pull/<n>#issuecomment-<id>`. File
names and ids are code spans with a fence longer than any backtick run inside, with nothing
escaped or joined in them, and a value with nothing visible renders as `(empty)`. Labels the
tool writes are bold (`**Seats:**`, `**F-1 [high]**`); seat text never is. No run id appears in
visible text: each body ends with one hidden `<!-- review-panel review=<id> verify=<id> -->`
marker holding only ids of the run-id character set (an id with `--`, from a base ref such as
`HEAD^`, is safe: the marker is its own HTML block, which only `-->` ends), and the close-out
duplicate check matches author, first-line heading and that exact marker as the last non-empty
line, or, for a card posted before the marker, ``Review `<id>` `` on line 2.
Bodies are cut by rows in order (`fitCommentBody`): a group that does not fit whole posts its
header, first member and a cut line, later rows are still tried, and what is left then goes to
that group's further members; a plain row, or a group that cannot fit even its first member,
ends the list, so the cut rows are always the last ones.
Bodies are capped under 65,536 characters and sent to `gh` on stdin; `gh` runs asynchronously
within one deadline per round, and an interrupt kills it.

## Posting claims and markers

Posting claims (`src/tool/round-claim.ts`) are fresh exclusive creates (`wx`) in the review's
run record, and nothing else: no claim is ever taken over, renamed or put back. A verify claims
`round-<N>.claim`, checks `round-<N>.posted` again after the create, and on a post writes
`round-<N>.posted` (`wx`) and then deletes its claim. A stale claim (older than the round
deadline plus 5 s, or made on this host by a process that is gone) stays where it is and is
skipped, so a crash can leave a gap in the verify numbering, never a duplicate (a POST `gh`
reports as failed after GitHub accepted it gives its number back; that repeat is set aside). The
close-out uses `closeout.claim-1`, `-2`, … (at most five): a stale generation sends the verify
to the PR's comments, then to the next generation; only a generation's creator posts, and a
posted card writes `closeout.posted` (`wx`), which stops every later verify. Every posted marker
(`round-<N>.posted`, `closeout.posted`, a verify's own `round.posted`) holds a MAC from the
owner's record key over the record's run id, the marker's file name and the verify that wrote
it; an unsigned or copied marker is no marker, and the verify that posts replaces it. `verify N`
counts only complete verify records signed with that key (`record.mac`) whose signed meta names
the review and that hold a signed `round.posted`. Claims are not signed: a planted stale-looking
`round-<N>.claim` is skipped and bumps `verify N`, a planted live-looking claim can stop an
automatic post, as can five planted stale-looking close-out claims (`comment` still works; never
forge one or post a second card), deleting genuine markers can repeat a `verify N`, and markers
written before signing count as none, so a PR reviewed before this change can see its `verify N`
numbering start again; these are documented limits. The close-out posts
at most once per review, with two exceptions set aside: a crash between GitHub accepting the
card and `closeout.posted` being written (the PR-comment check catches it), and a live verify
whose claim looks stale to another (paused over 65 s mid-post, a clock over 65 s behind, or a
container sharing this hostname), which can post a second card.

## Pi behaviours this repo depends on

Verified against the bundled 1.5.2 SDK.

- A system-prompt value that exists as a file is READ as that file, both from the CLI flag and
  from the SDK loader's `systemPrompt` option, and the loader appends `APPEND_SYSTEM.md` from
  `<cwd>/.pi/` and from the agent folder. A seat's cwd is the reviewed snapshot, so
  `src/seat/sdk-session.ts` sets `systemPromptOverride` and `appendSystemPromptOverride`: the
  seat's system prompt is the literal role text from `src/seat/channel-profile.ts` and nothing
  else. Keep both overrides.
- Built-in path args are normalized before use (Unicode-space fold, `@` strip, on Windows only the
  MSYS `/c/...`, WSL `/mnt/c/...` and Cygwin `/cygdrive/c/...` to `C:\...` drive rewrite, then `~`
  expand and `file://` decode), and the session cwd gets the same rewrite. Guards must apply the
  same normalization in the same order.
- `read` retries with path variants. A confinement check must confine the whole candidate set for
  `read`.
- Tool args are coerced then validated BEFORE `execute`. Declare a permissive envelope and validate
  inside `execute`.
- A tool signals an error by THROWING, or by returning a result with `isError: true` from
  `execute` (1.5.2 honors that; 0.84.1 ignored it there, though an after-tool hook could set it).
  This repo's tools throw.
- An extension `tool_call` handler can veto with `{ block: true, reason }`.
- Model patterns resolve across providers. Always pin the exact provider id plus an exact model
  id (`--provider` and `--model` on the CLI; seats resolve both by exact id through the runtime).
- The tarball ships through a narrow `files` allowlist. Internal artifacts never enter it.
- A `pi` manifest that lists only `skills` is a complete resource manifest: Pi loads those skills
  and no extension (`dist/core/package-manager.js`, `hasManifestResourceFields` and
  `addManifestEntries`).
- `DefaultPackageManager` installs a `git:` source into `<agentDir>/git/<host>/<path>` (then
  `npm install` there when it has a `package.json`), an `npm:` source into
  `<agentDir>/npm/node_modules/<name>`, and records a local folder (not copied) relative to the
  agent folder in `settings.json` `packages`. A source given to it is resolved against its own
  `cwd`, so `extension remove` passes a source exactly as `settings.json` records it, with the
  agent folder as that `cwd`. `resolve(onMissing)` installs nothing when `onMissing` answers
  `"skip"` for user-scope sources. `git` and `npm` run with `stdio: "inherit"`
  (`takeOverStdout` is not exported).
- An extension path given to the resource loader as a `git:` or `npm:` source is a temporary
  package that is refreshed from the network on every load, so a roster row names the
  installed entry file, never a source.
- Pi's extension loader resolves an extension's `@earendil-works/pi-ai` import to the SDK's own
  copy, so a `.ts` extension installed outside any checkout loads with the bundled SDK alone
  (the installed-package smoke check proves it).
