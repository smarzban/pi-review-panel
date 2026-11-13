# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A review or audit writes each seat's outcome to its run record as soon as that seat settles, so a killed or crashed run keeps the seats it already paid for.
- A new `resume` action (`{"action":"resume","priorRunId":"<run-id>"}`) finishes an interrupted review or audit record: it pins the same head commit, runs only the seats with no settled outcome, takes seats and lenses from the record, and writes the report as a normal run would. The report names the seats it ran again. Verify runs, complete runs, and runs from earlier versions are refused.
- Every run starts by removing this repository's leftover `review-panel-snapshot-*` worktrees whose owning process has exited, then runs `git worktree prune`. A live run's snapshot is never removed.

### Changed

- The `@earendil-works/pi-coding-agent` peer range is now `*`, so the package installs beside any Pi host, including Pi 1.x. Tests and type checks run against Pi SDK 1.5.2.

### Fixed

- A seat whose provider is registered by one of its own `extraExtensionPaths` extensions (for example `claude-code` from `pi-claude-code`) now runs, and `diagnose` reports it ready. `diagnose` now loads each row's configured extensions and runs the provider's own auth check; it still starts no session and runs no model. Each row's check is bounded at 30 seconds, and a row that does not finish gives a timed-out row naming its extensions. A provider check that throws counts as not authenticated.

## [0.3.0] - 2026-10-26

### Added

- The `tests` lens checks tests a change adds or edits for value: tests that cannot fail, mocks that supply the asserted behavior, duplicates, unreachable inputs, whole-output snapshots, library-behavior tests, trivial-code tests, and test-only production hooks.
- The `tests` lens checks deleted tests: each must leave its contract proven by another named test, unless it was deleted with the production code it covered.
- The `tests` lens and the `tests` audit pass flag tests that are flaky by construction, always as a fix, never a removal.
- The `tests` audit pass tags low-value tests `[action: fix|merge|remove]` and reports merge or remove only with evidence; protected contracts, trust-boundary edge cases, and skipped or disagreeing tests are never removal candidates.
- The review skill documents the audit cleanup loop: audit, cleanup PR, then `review`.

### Changed

- The example config sets `defaults.lenses: ["tests"]`, so the tests lens runs on every review. Each default extra adds up to two seats; drop it to save them.
- A low-value test a change adds is medium only when the seat names the existing test that proves its contract or the guard that makes its input unreachable; otherwise low.
- `tests` is suggested for any source or `.snap` change, with one neutral reason.
- Review results no longer suggest a lens the panel already ran.

## [0.2.0] - 2026-08-26

### Added

- Added the advisory whole-repository `audit` action, with package-owned passes for code health, documentation, tests, security, over-engineering, observability, operability, and UX.
- Added the `comment` action for an owner-approved PR close-out card.
- Added the `pi-review` host skill for starting Pi from Grok, Codex, or Claude Code.

### Changed

- Audit defaults now include over-engineering instead of documentation.
- Fix verification now uses one owner-default seat when `seats` is omitted. Explicit verification may use up to two seats.

### Fixed

- Resolved local-path and filesystem-root repository handling.
- Preserved `review_panel` arguments across Pi tool calls by replacing the provider-facing union schema with a flat envelope.
- Kept close-out argument parsing permissive for empty low-advisory lists and dismissed findings with additional fields.

## [0.1.0] - 2026-08-13

### Added

- Initial `pi-review-panel` package release.
- The `review_panel` tool with `diagnose`, `review`, and `verify` actions.
- Owner-controlled reviewer rosters, package-owned lenses, pinned review snapshots, structured findings, and persisted run records.
- The `review-panel` skill and owner configuration guide.

[Unreleased]: https://github.com/smarzban/pi-review-panel/compare/v0.3.0...main
[0.3.0]: https://github.com/smarzban/pi-review-panel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smarzban/pi-review-panel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smarzban/pi-review-panel/releases/tag/v0.1.0
