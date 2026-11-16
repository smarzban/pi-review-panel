# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- The review, verify and close-out comments are easier to read. Results and findings are tables, evidence is folded under a toggle, reasons stand on their own as quotes, review findings sit under High, Medium and Low headings, and seat names, vote counts, time and cost move to small text at the end.
- The verify comment gives a table row for each checked id with what the seats said, and a `### Not resolved` section with the seat's reason for each id that was not resolved, instead of listing every id with its evidence.
- A verify with `--recheck` counts its seats apart, `verify 1/1 · recheck 2/2`, instead of `1/1 voted`, which left the recheck seats out.
- Seats now get a writing rule: the title names the problem, not the fix, and the evidence says what goes wrong first, in plain words. The submit tools refuse a title over 120 characters, evidence over 800 or a verify explanation over 500, and the seat writes it again.
- The verify comment shows the caller's scoping note as `This round:` instead of `Why this round:`.
- The skill passes `--scoping-note` on a verify only when it adds something (a change from outside the panel, or why each recheck lens), not on every round.

## [1.0.0] - 2026-11-16

### Breaking

- pi-review-panel is now a standalone command, `review-panel`, that works with any coding agent; it no longer runs as a Pi tool. To upgrade: `pi remove npm:pi-review-panel`, `npm install -g pi-review-panel`, then `review-panel skill install`.
- The `pi-review` host skill is removed. Delete old copies under `~/.claude/skills/pi-review`, `~/.codex/skills/pi-review` and `~/.grok/skills/pi-review`.
- The repository audit (the `audit` action) is removed.
- Review records from 0.3.0 are refused by `verify` and `comment`; run a new review.
- Verify rounds chain: each `verify` takes the latest verify's run id and checks only what is still open. The first verify must keep or dismiss every high and medium finding ([verify rounds](docs/configuration.md#verify-rounds-chain)).
- `comment` posts only to an open pull request whose head is the card's commit.

### Added

- The `review-panel` command: `diagnose`, `suggest`, `review`, `verify`, `resume`, `comment` and `call '<json>'` ([CLI](docs/cli.md)).
- `review-panel skill install` installs one skill for Claude Code, Codex, Grok and Pi.
- Setup without Pi: `auth providers`, `auth login`, `models` and `extension install|list|remove` ([configuration](docs/configuration.md)).
- Review and verify post each round to the open pull request, and a close-out card sums up the rounds once nothing is open; `--no-pr-comment` turns posting off.
- `verify --recheck <lenses>` looks for new problems in a round's commits; what it finds becomes open ids such as `V2-F1`.
- `defaults.consolidator` groups findings that describe the same defect as `G-1`, `G-2`, ….
- `defaults.verifySeats` chooses the seats that run `verify`.
- `suggest` lists the lenses the diff points at, with reasons, before any seat runs.
- `resume` finishes an interrupted review, running only the seats that had not finished.

### Changed

- Replies say why each lost seat was lost.

### Fixed

- A repository under review can no longer change the reviewers' instructions or run its Git hooks on your machine.
- `verify` no longer trusts review records someone added to the repository; records are now signed with a key kept beside your config.
- Seats whose provider comes from an extension, such as `claude-code`, run, and `diagnose` reports them ready.
- On Windows, a seat can no longer read outside its snapshot through a Git Bash, WSL or Cygwin path.
- `diagnose` says what is wrong, and what to do, for a missing or unreadable config.

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

[Unreleased]: https://github.com/smarzban/pi-review-panel/compare/v1.0.0...main
[1.0.0]: https://github.com/smarzban/pi-review-panel/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/smarzban/pi-review-panel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/smarzban/pi-review-panel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/smarzban/pi-review-panel/releases/tag/v0.1.0
