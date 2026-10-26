# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
