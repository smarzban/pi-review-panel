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
(`diagnose` / `review` / `verify` / `comment`). The shipped skill is `review-panel`. A run fans N reviewer
*seats* — each an exact `provider/model` paired with a review *lens* — over one pinned snapshot of
the change, as read-only `pi -p` subprocesses that can report findings only through a structured
`submit_findings` channel. Seat identity is owner authority: an outside-repository roster config
(`~/.pi-review-panel/config.json`, override `PI_REVIEW_PANEL_CONFIG`) selects exact `provider/model`
rows and package-owned lens prompts by name; the calling agent chooses only among declared names.
Runs record under `<repo>/.review-panel/runs/`. Verify only reads those trees. The output is a
presentation-only report: severity-ordered, seat-attributed, with seat failures tallied as lost
coverage. **The tool never judges.** There is no verdict, no agreement arithmetic, and no
review-derived semantic stop signal: agents judge, and the human is the merge gate.

Install as a Pi package with `pi install npm:pi-review-panel` (not `npm install`). Omit
`repository`, or pass `/`, when this process is already in the repo; an explicit real
path still wins. `comment` posts or updates one PR card after the owner says yes
(`ownerApproved: true`), found later by author plus heading `## Review panel`. No Fixed
list, no “ready to merge.” Remaining high/medium ids count as fixed only when a verify
run whose `priorRunId` is this review marks them resolved. Host agents use
`host-skills/pi-review` to start Pi; they do not call `review_panel` themselves.

Prompt files under `prompts/` have no trailing newline (tests assert that). Extra lenses fire when
their trigger matches: `tests` means thin or missing coverage including an untested production
handoff, not “zero test files”; `contracts` means OpenAPI / proto / GraphQL, not app or TOML
config. Review seats must name a concrete failure and an actual consumer.

### Review invariants

- Repair implementation is orchestrator-owned. The package selects and launches no fixer.
- Verify pins a committed snapshot and refuses when head matches the prior run.
- Run-local finding IDs become unique as `<run-id>/<finding-id>`.
- Close-out comments are owner-asked only. The tool does not post when the panel first finishes.
- `0.1.0` is on npm. Bump `package.json` before the next `npm publish`; that version cannot be overwritten.
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

### Pi behaviors this repo depends on (verified against the shipped 0.84.1 build)

- A prompt flag value that exists as a file is READ as that file. System-prompt paths must be
  absolute paths to files we own, never literal text.
- Built-in path args are normalized before use (`@` strip, `~` expand). Guards must apply the same
  normalization.
- `read` retries with path variants. A confinement check must confine the whole candidate set for
  `read`.
- Tool args are coerced then validated BEFORE `execute`. Declare a permissive envelope and validate
  inside `execute`.
- A tool signals an error only by THROWING.
- An extension `tool_call` handler can veto with `{ block: true, reason }`.
- Model patterns resolve across providers. Always pin `--provider` plus an exact model id.
- The tarball ships through a narrow `files` allowlist. Internal artifacts never enter it.
- Pi bundles some packages for extensions; those go in `peerDependencies` with `"*"`.
- A distributed package installs production-only, so `devDependencies` are absent at runtime.
  Anything imported by shipped source belongs in `dependencies` or `peerDependencies`.
