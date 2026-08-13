# AGENTS.md

## Routing guideline

Stranger litmus test: would this instruction make sense to a stranger who cloned this repo? If
no, it belongs in AGENTS.local.md.

A gitignored AGENTS.local.md may exist beside this file; if present, read and follow it before starting work.

Pointer files carry no content: edits go to AGENTS.md or AGENTS.local.md, never CLAUDE.md — it is a
frozen one-line pointer and says so in-file.

@AGENTS.local.md

## Project overview

**pi-review-panel** runs multi-model code review as a pi package. A run fans N reviewer *seats* —
each an exact `provider/model` paired with a review *lens* — over one pinned snapshot of the
change, as read-only `pi -p` subprocesses that can report findings only through a structured
`submit_findings` channel. Seat identity is owner authority: an outside-repository roster config
selects exact `provider/model` rows and package-owned lens prompts by name; the calling agent
chooses only among declared names. The output is a presentation-only report: severity-ordered,
seat-attributed, with seat failures tallied as lost coverage. **The tool never judges.** There is
no verdict, no agreement arithmetic, and no review-derived semantic stop signal: agents judge,
and the human is the merge gate.

### Review invariants

- Repair implementation is orchestrator-owned. The package selects and launches no fixer.
- Verify pins a committed snapshot and refuses when head matches the prior run.
- Run-local finding IDs become unique as `<run-id>/<finding-id>`.
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
