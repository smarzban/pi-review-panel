# review-panel CLI

`review-panel` runs the [pi-review-panel](../README.md) multi-model review panel from a
terminal, without Pi. It does what the `review_panel` tool does: the same actions, the same
owner config, and the same run records under `<repo>/.review-panel/runs/`. It bundles the Pi
SDK (`@earendil-works/pi-coding-agent` 1.5.2) to run the seats.

The tool never judges, and neither does the CLI. It prints a report. No exit code says
whether there are findings.

## Install from source

The CLI is not on npm yet, and its `package.json` is marked `"private": true`, so an
accidental `npm publish` from `cli/` is refused. `npm pack` still works. It needs Node 26 or
newer, `git`, and `gh` for `comment`.

```sh
git clone https://github.com/smarzban/pi-review-panel.git
cd pi-review-panel/cli
npm ci
npm run build
npm link          # puts `review-panel` on your PATH
review-panel --help
```

Without `npm link`, run `node dist/cli/src/main.js` from `cli/`. To install a copy that
does not depend on the checkout, run `npm pack` in `cli/` (it builds first), then
`npm install -g ./review-panel-<version>.tgz`.

## Setup

1. Write the owner config at `~/.pi-review-panel/config.json`, or set
   `PI_REVIEW_PANEL_CONFIG` to an absolute path. It names the seats (`provider/model` rows)
   and the default panel. See [docs/configuration.md](../docs/configuration.md).
   The CLI has no `--provider` or `--model` flags: seats come only from this file.
2. Log in to each provider the roster uses (below), or set its API key environment
   variable.
3. Run `review-panel diagnose` in the repository. It reports `ready`, or what to fix.

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
folder, and `--json`, which prints the tool's result object instead of the report text.
Flags are named after the tool's arguments. A list flag takes commas, can be repeated, or
both: `--seats sol,opus` is the same as `--seats sol --seats opus`.

| Command | Tool arguments |
|---|---|
| `review-panel diagnose` | `{"action":"diagnose"}` |
| `review-panel review --base main --head HEAD [--seats a,b] [--lenses tests,security] [--scoping-note <text>]` | `base`, `head`, `seats`, `lenses`, `scopingNote` |
| `review-panel audit [--seats a,b] [--passes code-health,security] [--scoping-note <text>]` | `seats`, `passes`, `scopingNote` |
| `review-panel verify --prior-run-id <run> --head HEAD --kept-finding-ids F-1,F-2 [--seats a,b] [--scoping-note <text>]` | `priorRunId`, `head`, `keptFindingIds` (`""` for none), `seats`, `scopingNote` |
| `review-panel resume --prior-run-id <run>` | `priorRunId` |
| `review-panel comment --prior-run-id <run> --owner-approved [--pr 22] [--verify-run-id <run>] [--head <ref>] [--low-advisory F-3,F-4] [--dismissed <json> \| @<file> \| -]` | `priorRunId`, `ownerApproved`, `pr`, `verifyRunId`, `head`, `lowAdvisory`, `dismissed` |
| `review-panel call '<json>'` | The tool's whole argument object, for example `'{"action":"review","base":"main","head":"HEAD"}'`. `-` reads it from stdin. |

- `comment` posts the close-out card on the pull request. It is refused without
  `--owner-approved`: pass that flag only after the owner said to post.
- `--dismissed` is a JSON list of `{"id": "...", "reason": "..."}` objects, given inline,
  from a file (`@dismissed.json`) or from stdin (`-`).
- Inside a `call` object, `repository` works as it does in the tool. Give the repository
  either there or with `--repo`, not both.

## Output and exit codes

- The report goes to stdout. Progress goes to stderr while seats run.
- Ctrl-C aborts the run through the same abort signal the tool uses, including while the
  CLI waits on stdin (`--api-key`, `call -`, `--dismissed -`). Press it twice to quit at once.
- An error about an unknown command, option or argument, a provider id, or an unknown
  argument name in a `call` object repeats it only when it is shaped like a name (letters, no
  digits), in case it is a key typed in the wrong place. Values you give on purpose can still
  appear in an error: those of `--repo`, `--base`, `--head`, `--prior-run-id`, `--seats` and
  `--dismissed`, and the values in a `call` object, such as `repository` or `priorRunId`.

| Exit code | Meaning |
|---|---|
| 0 | The command completed. That includes a review with findings and a `diagnose` that says `needs setup`: read the report. |
| 1 | A refusal or an operational failure, such as an unready panel, a missing commit, `comment` without `--owner-approved`, or Ctrl-C. |
| 2 | A usage error: an unknown command or flag, or arguments the tool would reject. |

## Development

```sh
cd cli
npm ci
npm run build                 # dist/, never committed
npm run typecheck && npm test && npm run check
```

The build compiles `../src` (the Pi package's source, unchanged) and `cli/src` into
`dist/` without bundling, keeping the folder layout, and copies `../prompts` to
`dist/prompts`. `src/tool/review-panel.ts`, the Pi tool's entry point, is left out. Some
tests run the built bin, so `npm test` rebuilds `dist/` first (a Vitest global setup).

The CLI lints itself with `biome.cli.json`, which extends the root `biome.json`. It is not
named `biome.json`, so the root package's own `npm run check` never lints `cli/`.
