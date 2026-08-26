# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/smarzban/pi-review-panel/compare/v0.2.0...main
[0.2.0]: https://github.com/smarzban/pi-review-panel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smarzban/pi-review-panel/releases/tag/v0.1.0
