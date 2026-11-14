# AGENTS.md

## Routing guideline

Stranger litmus test: would this instruction make sense to a stranger who cloned this repo? If
no, it belongs in AGENTS.local.md.

A gitignored AGENTS.local.md may exist beside this file; if present, read and follow it before starting work.

Pointer files carry no content: edits go to AGENTS.md or AGENTS.local.md, never CLAUDE.md — it is a
frozen one-line pointer and says so in-file.

@AGENTS.local.md

## Project overview

**pi-review-panel** runs multi-model code review as a pi package. The public tool is `review_panel`
(`diagnose` / `suggest` / `review` / `audit` / `verify` / `resume` / `comment`). The shipped Pi skill is `review-panel-pi`. A run
fans N reviewer *seats* — each an exact `provider/model` paired with a package-owned lens — over
one pinned snapshot, as isolated in-process Pi SDK sessions that have only their read-only role
tools and can report findings only through their submit tool (`submit_findings` for reviewers).
Seat identity is owner authority: an outside-repository roster config
(`~/.pi-review-panel/config.json`, override `PI_REVIEW_PANEL_CONFIG`) selects exact `provider/model`
rows and package-owned lens prompts by name; the calling agent chooses only among declared names.
Runs record under `<repo>/.review-panel/runs/`, each seat as it settles. `resume` finishes an
interrupted review or audit record, running only its unsettled seats at the recorded head. Review
and audit sign `plan.json` and each seat file with `record-key` beside the owner config (never in
the repository); resume refuses an unsigned plan and re-runs an unsigned seat. Verify reads
those trees and writes only its posting claims and markers into the review's record
(`round-<N>.claim`, `round-<N>.posted`, `closeout.claim-<g>`, `closeout.posted`). The output is a
presentation-only report: severity-ordered, seat-attributed, with seat failures tallied as lost
coverage. **The tool never judges.** There is no verdict, no agreement arithmetic, and no
review-derived semantic stop signal: agents judge, and the human is the merge gate.

Install as a Pi package with `pi install npm:pi-review-panel` (not `npm install`). Omit
`repository`, or pass `/`, when this process is already in the repo; an explicit real
path still wins. `audit` is a periodic whole-repository advisory sweep against one pinned `HEAD`
snapshot (no base/head range). Default passes are code-health, over-engineering, tests, and security
across the first two owner-default seats. It does not write `AUDIT.md`, repair, run CI, or post a
GitHub comment. Review and verify post each round to the one open PR whose head is the
run's head, by default, as a new comment (`## Review panel · review`, `## Review panel · verify N`);
a verify where every verify seat voted, each marked every kept id resolved, and none reported a
regression also posts the close-out card on its own (`## Review panel · close-out`, once per
review). The card is presentation, not a verdict: the agents judge and the owner merges.
`prComment: false` (CLI `--no-pr-comment`) turns posting off for a run, and owner config
`defaults.prComment: "ownerApproved"` makes every post need `ownerApproved: true`. A post that
cannot be made is one reply line, never a run failure.
`comment` stays the manual path: it posts or updates one PR card after the owner says yes
(`ownerApproved: true`), found later by author plus heading `## Review panel`. No Fixed
list, no “ready to merge.” Remaining high/medium ids count as fixed only when a verify
run whose `priorRunId` is this review marks them resolved. Host agents (Grok,
Codex, Claude Code) use `host-skills/review-panel`, which runs the standalone `review-panel` CLI
(`cli/`) directly and never starts Pi.

Prompt files under `prompts/` have no trailing newline (tests assert that). Extra lenses fire when
their trigger matches: `tests` means thin or missing coverage including an untested production
handoff, not “zero test files”, and also any added, rewritten, or deleted test, which the lens
checks for tests that cannot fail, are flaky by construction, or are not worth keeping, and for
deleted tests that leave a contract unproven. The example config makes `tests` an owner default.
`contracts` means OpenAPI / proto / GraphQL, not app or TOML config. Review seats must name a concrete failure and an actual consumer.

### Review invariants

- Repair implementation is orchestrator-owned. The package selects and launches no fixer.
- Verify pins a committed snapshot and refuses when head matches the prior run.
- Run-local finding IDs become unique as `<run-id>/<finding-id>`.
- Review and verify post each round to the open PR by default, always as a new comment that is
  never edited or deleted; audit and resume never post. The automatic close-out posts only after
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
  math (which can colour, hide or resize text) on `\$` and `&#36;` too; parentheses, braces,
  quotes and dots stay plain. File
  names and ids are code spans with a fence longer than any backtick run inside, with nothing
  escaped or joined in them, and a value with nothing visible renders as `(empty)`. Labels the
  tool writes are bold (`**Seats:**`, `**F-1 [high]**`); seat text never is. No run id appears in
  visible text: each body ends with one hidden `<!-- review-panel review=<id> verify=<id> -->`
  marker holding only ids of the run-id character set (an id with `--`, from a base ref such as
  `HEAD^`, is safe: the marker is its own HTML block, which only `-->` ends), and the close-out
  duplicate check matches author, first-line heading and that exact marker as the last non-empty
  line, or, for a card posted before the marker, ``Review `<id>` `` on line 2.
  Bodies are capped under 65,536 characters and sent to `gh` on stdin; `gh` runs asynchronously
  within one deadline per round, and an interrupt kills it.
- Posting claims (`src/tool/round-claim.ts`) are fresh exclusive creates (`wx`) in the review's
  run record, and nothing else: no claim is ever taken over, renamed or put back. A verify claims
  `round-<N>.claim`, checks `round-<N>.posted` again after the create, and on a post writes
  `round-<N>.posted` (`wx`) and then deletes its claim. A stale claim (older than the round
  deadline plus 5 s, or made on this host by a process that is gone) stays where it is and is
  skipped, so a crash can leave a gap in the verify numbering, never a duplicate (a POST `gh`
  reports as failed after GitHub accepted it gives its number back; that repeat is set aside). The
  close-out uses `closeout.claim-1`, `-2`, … (at most five): a stale generation sends the verify
  to the PR's comments, then to the next generation; only a generation's creator posts, and a
  posted card writes `closeout.posted` (`wx`), which stops every later verify. The close-out posts
  at most once per review, with two exceptions set aside: a crash between GitHub accepting the
  card and `closeout.posted` being written (the PR-comment check catches it), and a live verify
  whose claim looks stale to another (paused over 65 s mid-post, a clock over 65 s behind, or a
  container sharing this hostname), which can post a second card.
- Tests never reach GitHub: a failing fake `gh` stands first on PATH in both vitest configs.
- `0.3.0` is on npm. Bump `package.json` before the next `npm publish`; that version cannot be overwritten.
- Release: bump `package.json`, add a `## [x.y.z]` CHANGELOG section, merge, then push tag `vx.y.z`.
  `publish.yml` checks the tag matches the version, publishes to npm, and creates the GitHub release
  from that CHANGELOG section.
- Fixed operational bounds may halt work, but they never make a quality claim.

## Build / test / verify

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Test: `npm test` (vitest run)
- Lint/format: `npm run check` (biome check .)
- Canonical verify: `npm run typecheck && npm test && npm run check`
- Before merging, verify from a clean install: `npm ci && npm run typecheck && npm test && npm run check`.
- Whenever `package.json` changes, refresh the lock (`npm install --package-lock-only`) and commit it in the same change.
- Read CI before merging. `gh run list --limit 3`. Reviewers are read-only and structurally cannot run the suite.

## Conventions

- Conventional Commits with a task or area scope: `feat(review): …`, `docs(config): …`.
- Feature branches (`feat/<feature>`). Never commit product code straight to `main`.
- Test-first, always. A failing test precedes the code that satisfies it.
- Zero runtime dependencies. The pi harness and any bundled core it imports (currently `typebox`)
  are peer dependencies; everything else is node builtins.
- No build step, no committed `dist/`. Pi loads the extension TypeScript directly.

### Pi behaviors this repo depends on (verified against the shipped 1.5.2 build)

- A system-prompt value that exists as a file is READ as that file, both from the CLI flag and
  from the SDK loader's `systemPrompt` option. Seats pass literal role text through that option
  (`src/seat/channel-profile.ts`), so it must never name an existing file; pass a prompt file only
  as an absolute path to a file we own.
- Built-in path args are normalized before use (Unicode-space fold, `@` strip, `~` expand,
  `file://` decode, and on Windows the MSYS-style `/c/...` to `C:\...` drive rewrite). Guards must
  apply the same normalization. The seat guard does not yet mirror the Windows drive rewrite (T491).
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
- Pi bundles some packages for extensions; those go in `peerDependencies` with `"*"`.
- A distributed package installs production-only, so `devDependencies` are absent at runtime.
  Anything imported by shipped source belongs in `dependencies` or `peerDependencies`.
