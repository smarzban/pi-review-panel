# AGENTS.md

## Routing guideline

Stranger litmus test: would this instruction make sense to a stranger who cloned this repo? If
no, it belongs in AGENTS.local.md.

A gitignored AGENTS.local.md may exist beside this file; if present, read and follow it before starting work.

Pointer files carry no content: edits go to AGENTS.md or AGENTS.local.md, never CLAUDE.md — it is a
frozen one-line pointer and says so in-file.

@AGENTS.local.md

## Project overview

**pi-review-panel** runs multi-model code review as one command, `review-panel`, published from the
npm package `pi-review-panel` (`diagnose` / `suggest` / `review` / `verify` / `resume` /
`comment`, plus `call '<json>'`, `auth`, `models`, `extension` and `skill`). The package ships one agent-neutral skill,
`skills/review-panel`, which every coding agent (Claude Code, Codex, Grok, Pi) uses to run the
command; the skill never starts another agent session.

A run fans reviewer *seats* (an exact `provider/model` paired with a package-owned lens) over one
pinned snapshot, as isolated Pi SDK sessions with read-only tools and one submit tool. The owner
config outside the repository (`~/.pi-review-panel/config.json`, override
`PI_REVIEW_PANEL_CONFIG`) names the roster and defaults; the calling agent chooses only among
declared names. Runs record under `<repo>/.review-panel/runs/`, signed with the owner's
`record-key` beside the config.

Read before changing behaviour:

- [docs/internals.md](docs/internals.md): what the package does in detail, grouping, posted text,
  posting claims and markers, and the Pi behaviours the code depends on. Update it in the same
  commit as the behaviour.
- [docs/configuration.md](docs/configuration.md) and [docs/cli.md](docs/cli.md): the user-facing
  reference. They ship in the package.
- `constitution.md`: the rules a change may not break.

Before touching these, read the matching section of `docs/internals.md`:

- `src/tool/posted-text.ts` or any text posted to a PR → "Posted text" (the escaping rules).
- `src/tool/round-claim.ts`, `round-post.ts` or a `.claim` / `.posted` file → "Posting claims and markers".
- `src/seat/`, or anything that calls the Pi SDK → "Pi behaviours this repo depends on".
- `src/run/grouping.ts` or G-ids → "Grouping".
- `src/run/verify-chain.ts`, `run-verify.ts`, or a verify record's `meta.json` / `verification.json`
  → "Verify chain".

### Review invariants

- **The tool never judges.** No verdict, no agreement arithmetic, no review-derived stop signal:
  agents judge, and the human is the merge gate. Cards never say "fixed" or "ready to merge".
- Repair is orchestrator-owned. The package selects and launches no fixer.
- Seat identity is owner authority. No flag or argument names a provider or a model.
- The reviewed repository is untrusted. Nothing in it may reach a seat's system prompt, run as
  code (hooks included), or pass as a record: verify and comment take only records signed with
  the owner's key, and use only the bytes they authenticated.
- Grouping only groups: it never drops, rewrites or re-rates a finding, and group size is never
  shown as agreement or used to rank.
- A dead seat is lost coverage, named in the report, never a clean vote.
- Verify pins a committed snapshot and refuses when head matches the prior run.
- Verify rounds chain: each verify chains from the latest signed verify of the review (the review
  itself only for the first), diffs from that verify's head, and checks only what is still open.
  The open set comes only from signed records; an id a round resolved, dismissed or left as
  low/advisory is not judged again. A fork, a gap, a foreign or unsigned link, or a prior that is
  not the latest is refused before any seat runs.
- `verify --recheck` is opt-in: its seats come only from the owner's `defaults.seats`, cover
  only the round's diff, and what they find (`V<N>-F<k>`) is an open id from the signed record
  like any other. A lost recheck seat is lost coverage, never "nothing new". The final check
  runs no recheck seat.
- Run-local finding IDs become unique as `<run-id>/<finding-id>`.
- Review and verify post each round to the open PR at the run's head by default, always as a new
  comment (a final check posts its round only when it blocks the `--close-out` card; the card
  names it otherwise); resume never posts; `comment` posts the card (`--owner-approved`) when nothing is open or the owner stops the rounds, and posts only to an
  open PR at the card's head. A post that cannot be made is one reply line, never a run failure.
- The close-out card is never posted automatically: only by `verify --close-out` when nothing is
  open after a verify with no lost seat, or by `comment`, which lists what is still open. Both
  first run one final check (one owner seat, review head → final head, every resolved id under
  the undo guard), a signed link of the chain; what it finds is a regression, open. It blocks the
  `--close-out` card, and `comment`'s card only when nothing was open before the check. A review
  with no findings and no verify after it has no card: `comment` refuses it.
- Every posted body goes through `src/tool/posted-text.ts`; seat text is one line of inert plain
  text. Posting claims are exclusive creates and are never taken over.
- Fixed operational bounds may halt work, but they never make a quality claim.
- Tests never reach GitHub: a failing fake `gh` stands first on PATH in the vitest config.
- Prompt files under `prompts/` have no trailing newline, and every review lens ends with the
  same closing rule (tests assert both).

## Build / test / verify

- Typecheck: `npm run typecheck` (tsc --noEmit)
- Test: `npm test` (vitest run)
- Lint/format: `npm run check` (biome check .)
- Canonical verify: `npm run typecheck && npm test && npm run check`
- Before merging, verify from a clean install: `npm ci && npm run typecheck && npm test && npm run check`.
- `npm test` rebuilds `dist/` first (a Vitest global setup), because some tests run the built bin and
  the packed tarball.
- Build: `npm run build` (`scripts/build.mjs`) compiles `src/` into `dist/src/` without bundling and
  copies `prompts/` to `dist/prompts/`. `npm pack --dry-run` must list `dist/`, `skills/review-panel`
  and the shipped docs, and no `src/`, `tests/` or other internal file.
- Whenever `package.json` changes, refresh the lock (`npm install --package-lock-only`) and commit it in the same change.
- Read CI before merging. `gh run list --limit 3`. Reviewers are read-only and structurally cannot run the suite.

## Release

- `0.3.0` is on npm (the old Pi tool). Bump `package.json` before the next `npm publish`; that
  version cannot be overwritten. The next release is breaking: Pi users run
  `pi remove npm:pi-review-panel`, then `npm install -g pi-review-panel` and
  `review-panel skill install`.
- Bump `package.json`, add a `## [x.y.z]` CHANGELOG section, merge, then push tag `vx.y.z`.
  `publish.yml` checks the tag matches the version and its commit is on `main`, runs verify and
  the installed-package smoke check, publishes to npm (`prepack` builds `dist/`), and creates the
  GitHub release from that CHANGELOG section.

## Conventions

- Conventional Commits with a task or area scope: `feat(review): …`, `docs(config): …`.
- Feature branches (`feat/<feature>`). Never commit product code straight to `main`.
- Test-first, always. A failing test precedes the code that satisfies it.
- One runtime dependency: the Pi SDK (`@earendil-works/pi-coding-agent`), pinned to an exact version,
  which runs the seats. Everything else is node builtins. No peer dependencies.
- `dist/` is built at pack time (`prepack`) and never committed. The bin is
  `dist/src/cli/main.js`; Node does not strip types under `node_modules`, so the package cannot ship
  TypeScript to run.
- The core (`src/actions`, `src/run`, `src/seat`, `src/config`, `src/tool`) never imports the Pi SDK
  statically; only `src/cli` and a dynamic `import()` load it.
- The tarball ships through a narrow `files` allowlist. Internal artifacts never enter it.
- A distributed package installs production-only, so `devDependencies` are absent at runtime.
  Anything imported by shipped code belongs in `dependencies`.
- A `pi` manifest that lists only `skills` is a complete resource manifest: Pi loads those skills
  and no extension.
