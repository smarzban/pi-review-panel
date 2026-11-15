# The review-panel command

`review-panel` runs the [pi-review-panel](../README.md) multi-model review panel from a
terminal or from any coding agent. It bundles the Pi SDK (`@earendil-works/pi-coding-agent`
1.5.2) to run the seats in-process, reads the owner config, and writes run records under
`<repo>/.review-panel/runs/`.

The panel never judges. The command prints a report. No exit code says
whether there are findings.

## Install

It needs Node 26 or newer, `git`, and `gh` for posting rounds to a pull request and for
`comment`.

```sh
npm install -g pi-review-panel     # puts `review-panel` on your PATH
review-panel skill install         # links the review-panel skill into each coding agent
review-panel --help
```

`review-panel skill install` links the package's one skill, `skills/review-panel`, into the
personal skills folder of every coding agent it finds:

| Agent | Skills folder | Moved by |
|---|---|---|
| Claude Code | `~/.claude/skills` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/skills` | `CODEX_HOME` |
| Grok | `~/.grok/skills` | `GROK_HOME` |
| Pi | `~/.pi/agent/skills` | `PI_CODING_AGENT_DIR` |

- An agent counts when its home folder (`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi/agent`, or
  the folder its variable names) exists. Nothing is created for an agent that is not there.
- `--agent claude,codex,grok,pi` installs for only those agents, and creates a missing
  agent's skills folder.
- `--dry-run` prints what it would do and changes nothing.
- Upgrades replace two entries without `--force`:
  - a link into another npm install of `pi-review-panel` (a path ending in
    `node_modules/pi-review-panel/skills/review-panel`: an earlier Node version or npm prefix,
    or the npx cache, even when that install is gone). `skill uninstall` removes such a link
    too.
  - an unedited hand copy of the old `host-skills/review-panel` skill from this repository
    (never in a release): a `review-panel` folder holding only a `SKILL.md` that is byte for
    byte one of the versions shipped there.
- Any other `review-panel` entry (your own folder, an edited copy of the old skill, or a link
  to somewhere else, such as your own checkout) is left alone
  and named; `--force` replaces it, and only together with `--agent`: `--force` alone is a
  usage error, so it can never delete a folder in an agent you did not name. Every hint names
  the agent, for example `review-panel skill install --agent claude --force`.
- On Windows the skill is copied, with a version stamp, instead of linked. Run
  `skill install` again after an upgrade to refresh the copy.
- `review-panel skill uninstall [--agent …] [--dry-run]` removes only this package's own
  link or copy.
- An old `pi-review` skill is named with a hint to remove it; it is never deleted for you.
- `review-panel diagnose` shows the skill's state in each agent: linked, not installed, a
  broken or foreign link, or a stale copy.

Because the link points into the installed package, `npm update -g pi-review-panel` updates
the skill too. Invoke it as `/review-panel`, or ask the agent to review a PR or the current
diff.

Grok also reads skills from `~/.claude/skills`, so with both linked it may list the skill
twice. To keep one, uninstall it from Grok: `review-panel skill uninstall --agent grok`.

The package still carries a `pi` manifest that lists only `skills`, so
`pi install npm:pi-review-panel` loads the same skill into Pi. It does not put
`review-panel` on PATH, which the skill needs, so use the two commands above instead; do not
use both, or Pi sees the skill twice.

### Install from a checkout

```sh
git clone https://github.com/smarzban/pi-review-panel.git
cd pi-review-panel
npm ci
npm run build     # dist/, never committed
npm link          # puts `review-panel` on your PATH, from this checkout
review-panel skill install
```

Without `npm link`, run `node dist/src/cli/main.js`. To install a copy that does not depend
on the checkout, run `npm pack` (it builds first), then
`npm install -g ./pi-review-panel-<version>.tgz`.

## Setup

1. Write the owner config at `~/.pi-review-panel/config.json`, or set
   `PI_REVIEW_PANEL_CONFIG` to an absolute path. It names the seats (`provider/model` rows)
   and the default panel. See [docs/configuration.md](../docs/configuration.md).
   The CLI has no `--provider` or `--model` flags: seats come only from this file.
2. Log in to each provider the roster uses (below), or set its API key environment
   variable.
3. Run `review-panel diagnose` in the repository. It reports `ready`, or what to fix, and the
   skill's state in each coding agent.

## Logins and the agent folder

Logins live in a Pi agent folder (`auth.json`, `models.json`, `settings.json`). The CLI
picks one folder when it starts:

| Situation | Folder used |
|---|---|
| `PI_CODING_AGENT_DIR` is set | That folder |
| `~/.pi/agent` has `auth.json` or `models.json` (you use Pi) | `~/.pi/agent`, so your Pi logins and models work as they are |
| Otherwise | `~/.pi-review-panel/agent`, the CLI's own folder |

When the CLI reuses `~/.pi/agent` (or the folder `PI_CODING_AGENT_DIR` names), it shares
Pi's logins: `review-panel auth login` and `auth logout` change Pi's own logins too.
Logging out there logs Pi out as well, and logging in replaces Pi's stored credential for
that provider.

`review-panel diagnose` prints the folder in use, the CLI version and the bundled SDK
version. The CLI never copies credentials from one folder to another. If you install Pi
later, the CLI switches to `~/.pi/agent` once you log in there. To keep using the CLI's own
folder, set `PI_CODING_AGENT_DIR=~/.pi-review-panel/agent`.

```sh
review-panel auth login anthropic                 # sign in with the account in a browser (OAuth)
review-panel auth login openai-codex              # a subscription sign-in, such as ChatGPT
review-panel auth login anthropic --api-key < key # save an API key read from stdin
review-panel auth login anthropic --api-key       # or type it at a hidden prompt
review-panel auth status                          # login status of each provider in the roster
review-panel auth logout anthropic                # remove the stored credential
```

- An API key is never taken from the command line, so it never lands in your shell history.
- Account sign-in needs an interactive terminal. It prints a URL or a device code to open.
- Subscription sign-ins go through the Pi SDK's own login flow, the same one `pi auth login`
  uses.
- `auth status` checks each provider with the extensions its roster row names
  (`extraExtensionPaths`), so extension-registered providers such as `claude-code` are
  checked too. Run it inside a repository or pass `--repo`, because the owner config must
  sit outside the reviewed repository.

## Commands

Each action takes `--repo <path>`, which defaults to the Git top-level of the current
folder, and `--json`, which prints the result object instead of the report text.
Flags are named after the actions' argument names (kebab-case here, camelCase in a `call`
object). A list flag takes commas, can be repeated, or
both: `--seats sol,opus` is the same as `--seats sol --seats opus`.

| Command | Argument names |
|---|---|
| `review-panel diagnose` | `{"action":"diagnose"}` |
| `review-panel suggest --base main --head HEAD` | `base`, `head` |
| `review-panel review --base main --head HEAD [--seats a,b] [--lenses tests,security] [--scoping-note <text>] [--no-pr-comment] [--pr 22] [--owner-approved]` | `base`, `head`, `seats`, `lenses`, `scopingNote`, `prComment: false`, `pr`, `ownerApproved` |
| `review-panel audit [--seats a,b] [--passes code-health,security] [--scoping-note <text>]` | `seats`, `passes`, `scopingNote` |
| `review-panel verify --prior-run-id <run> --head HEAD --kept-finding-ids F-1,G-2 [--seats a,b] [--scoping-note <text>] [--low-advisory F-3,F-4] [--dismissed <json> \| @<file> \| -] [--no-pr-comment] [--pr 22] [--owner-approved]` | `priorRunId`, `head`, `keptFindingIds` (`""` for none), `seats`, `scopingNote`, `lowAdvisory`, `dismissed`, `prComment: false`, `pr`, `ownerApproved` |
| `review-panel resume --prior-run-id <run>` | `priorRunId` |
| `review-panel comment --prior-run-id <run> --owner-approved [--pr 22] [--verify-run-id <run>] [--head <ref>] [--low-advisory F-3,F-4] [--dismissed <json> \| @<file> \| -]` | `priorRunId`, `ownerApproved`, `pr`, `verifyRunId`, `head`, `lowAdvisory`, `dismissed` |
| `review-panel call '<json>'` | One action's whole argument object, for example `'{"action":"review","base":"main","head":"HEAD"}'`. `-` reads it from stdin. |

- `suggest` runs no seat and spends no quota, but needs the owner config, which it
  reads for `defaults.lenses`. It prints each lens the diff's rules
  suggest, with its reason and evidence, and marks the owner's `defaults.lenses` as
  already on. You choose the lenses and pass them to `review --lenses`.
- `review` and `verify` post their round to the open pull request whose head is the run's
  head, as a new comment, through `gh`; a verify where every seat voted and resolved every
  kept id, with no regressions, also posts the close-out card once per review. `--no-pr-comment` turns that
  off for one run, and `--pr` names the PR. When the owner config sets
  `defaults.prComment: "ownerApproved"`, a round posts only with `--owner-approved`. A post
  that cannot be made ends the report with one line saying why, and the exit code does not
  change. See [Posting rounds to the pull request](../docs/configuration.md#posting-rounds-to-the-pull-request).
- `comment` posts or updates the manual close-out card on the pull request. It is refused
  without `--owner-approved`: pass that flag only after the owner said to post. The card shows the
  head as the short id of the commit the verify checked; `--head` is still accepted and no longer
  shown. See [The close-out card](../docs/configuration.md#the-close-out-card).
- `--dismissed` (comment, verify) is a JSON list of `{"id": "...", "reason": "..."}` objects, given inline,
  from a file (`@dismissed.json`) or from stdin (`-`).
- Inside a `call` object, `repository` names the repository; omit it (or pass `/`) to use the
  Git top-level of the current folder. Give the repository either there or with `--repo`, not
  both.

## Output and exit codes

- The report goes to stdout. Progress goes to stderr while seats run.
- Ctrl-C aborts the run, including while the CLI waits on stdin (`--api-key`, `call -`, `--dismissed -`). Press it twice to quit at once.
- An error about an unknown command, option or argument, a provider id, or an unknown
  argument name in a `call` object repeats it only when it is shaped like a name (letters, no
  digits), in case it is a key typed in the wrong place. Values you give on purpose can still
  appear in an error: the value of any flag (for example `--repo`, `--lenses` or `--passes`),
  and any value in a `call` object, such as `repository` or `priorRunId`.

| Exit code | Meaning |
|---|---|
| 0 | The command completed. That includes a review with findings and a `diagnose` that says `needs setup`: read the report. |
| 1 | A refusal or an operational failure, such as an unready panel, a missing commit, `comment` without `--owner-approved`, or Ctrl-C. |
| 2 | A usage error: an unknown command or flag, or arguments an action would reject. |

## Development

```sh
npm ci
npm run build                 # dist/, never committed
npm run typecheck && npm test && npm run check
```

The build (`scripts/build.mjs`) compiles every module under `src/` into `dist/src/` without
bundling, keeping the folder layout, and copies `prompts/` to `dist/prompts`, so the core
finds its prompts at `../../prompts` from its own module. `npm pack` and `npm publish` build
first (`prepack`). Some tests run the built bin, so `npm test` rebuilds `dist/` first (a
Vitest global setup).
