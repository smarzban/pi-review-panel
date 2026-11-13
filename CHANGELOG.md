# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A review or audit writes each seat's outcome to its run record as soon as that seat settles, so a killed or crashed run keeps the seats it already paid for.
- A new `resume` action (`{"action":"resume","priorRunId":"<run-id>"}`) finishes an interrupted review or audit record: it pins the same head commit, runs only the seats with no settled outcome, takes seat and lens names from the record but rebuilds each seat from the owner config and the package's prompts (a seat that cannot be rebuilt is lost coverage), and writes the report as a normal run would. The report names the seats it ran again. Verify runs, complete runs, and runs from earlier versions are refused. Resume treats the record as untrusted: it never follows a symlink in it or waits on a FIFO, refuses symlinked record folders and plans over the panel caps or holding control characters, re-runs any seat whose file does not match the outcome schema, checks every planned seat (settled or not) against the owner config, rebuilds a kept seat's prompt, extension paths and replay input instead of copying them, does not pass the record's scoping note to seats, runs the readiness check first, and takes the run lock before re-reading the record.
- Review and audit records are signed with the owner's record key, 32 random bytes in `record-key` beside the owner config (created on first use with mode `0600`, never in the repository). `plan.mac` is an HMAC of the exact `plan.json` bytes bound to the run id; each `seats/<n>.mac` binds the seat file's bytes to the run id, the plan MAC and the seat index. Resume refuses an unsigned plan, and re-runs any seat whose file is unsigned or forged, so a record planted in the repository cannot pass as panel coverage.
- Review and audit refuse to start when the record key is unusable: a key that is a symlink, not a regular file, readable by group or other users, owned by another user (where Node has `process.getuid`), or not 32 bytes; a key folder writable by group or other users; or a folder where the key cannot be created. `diagnose` checks the key the same way without creating it, and reports one `record key <path>` row with the cause and the fix. `docs/configuration.md` lists each cause with its fix. A run interrupted between writing `plan.json` and `plan.mac` is refused as interrupted, not as unsigned.
- Every run starts by removing this repository's leftover `review-panel-snapshot-*` worktrees whose owning process has exited, each by its exact path. A live run's snapshot, and any other worktree, is never touched; there is no repository-wide `git worktree prune`.

- A standalone `review-panel` command-line application in `cli/`, a separate npm package (not published yet) that runs the panel without Pi. It has the same actions as the tool (`diagnose`, `review`, `audit`, `verify`, `resume`, `comment`, plus `call '<json>'` for the tool's own argument object), with flags named after the tool's arguments and no `--provider` or `--model` flags. It bundles Pi SDK 1.5.2 and reuses your Pi logins when `~/.pi/agent` has `auth.json` or `models.json` (or `PI_CODING_AGENT_DIR` names a folder); otherwise it keeps its own logins in `~/.pi-review-panel/agent`. `auth login <provider>` signs in with the account (OAuth, including subscriptions) or, with `--api-key`, saves a key read from stdin or a hidden prompt; `auth logout` and `auth status` complete the set. The report goes to stdout and progress to stderr; exit codes are 0 (completed), 1 (refused or failed) and 2 (usage) and never say whether there are findings. The `pi-review-panel` Pi package is unchanged. See `cli/README.md`.

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
