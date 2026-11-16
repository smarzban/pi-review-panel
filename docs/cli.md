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

Pi is not needed. [Setting up without Pi](configuration.md#setting-up-without-pi) walks through
it from an empty home folder.

1. See the providers and how each logs in: `review-panel auth providers`. Log in to the ones
   you want (below), or set a provider's API key environment variable.
2. Find the exact ids for each seat: `review-panel models` lists the models your logins give,
   with a ready-to-copy roster row. A provider that a Pi extension registers needs
   `review-panel extension install <source>` first (below).
3. Write the owner config at `~/.pi-review-panel/config.json`, or set
   `PI_REVIEW_PANEL_CONFIG` to an absolute path. It names the seats (`provider/model` rows)
   and the default panel. See [docs/configuration.md](../docs/configuration.md).
   The CLI has no `--provider` or `--model` flags: seats come only from this file.
4. Run `review-panel diagnose` in the repository. It reports `ready`, or what to fix, and the
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
review-panel auth providers                       # every provider, its logins, and whether it is logged in
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
- `auth providers` lists every provider the bundled SDK knows, plus those in the agent
  folder's `models.json`: its login (`account`, `API key`, both, or `none` for a provider set
  up only by an environment variable or `models.json`), and whether it is logged in now and
  how (a stored credential, an environment variable, a `models.json` key). A provider whose
  own check fails, or does not finish within 15 seconds, says `check failed` with the reason on
  its own row; the checks run side by side, so the others still answer. `--json` prints the objects. `auth login` loads no extension, so a provider that an extension registers
  logs in the way that extension documents.

## Models and extensions

```sh
review-panel models                         # the models your logins give
review-panel models anthropic               # all of one provider's models, logged in or not
review-panel models --search opus --all     # every model whose ids or name hold every word
review-panel models --extension /abs/ext.ts # also the models one extension file registers
review-panel extension install git:github.com/earendil-works/pi-claude-code
review-panel extension list                 # installed packages and their entry paths
review-panel extension remove git:github.com/earendil-works/pi-claude-code
```

- `models` prints one row per model: `provider` and `model` (the exact ids a roster row
  takes), the context window, the output limit (`max-out`), whether it thinks, whether it
  takes images and, for a model an extension registers, the extension. Without a provider it
  lists only models whose provider is logged in; with one, all that provider's models, and a
  line when it is not logged in. `--all` lists every model; `--search <text>` keeps rows
  whose provider, id or name hold every word of the text. It ends with a ready-to-copy roster
  row for the first row, with `extraExtensionPaths` when the model comes from an extension.
  `--json` prints the rows, the roster row and any problem.
- `models` reads the bundled SDK's own catalog and the agent folder's `models.json`. It asks
  no provider for its model list. Whether a provider is logged in comes from its stored
  credential or environment variable; a provider that defines its own check (such as
  `claude-code`, which asks the Claude Code CLI) runs that check, as `diagnose` does.
- `models` loads every installed package, because only loading it shows which providers it
  registers (any id, a built-in's included), as Pi does on every start. Each extension entry,
  and each `--extension` file (resolved from the working folder), loads on its own, exactly as
  a seat loads only its own row's paths, and lists only the providers that entry registered,
  so the roster row names just that entry. Each load is
  bounded at 30 seconds; a package that fails or does not finish is named under `Problems:`
  and the rest is still listed. It runs that code, as `diagnose` does.
- `extension install <source>` installs a Pi package with the bundled SDK's own package
  manager, the code behind `pi install`: `git:host/owner/repo` (cloned into
  `<agent folder>/git/<host>/<owner>/<repo>`, then `npm install` there), `npm:name` (a registry
  package only, into
  `<agent folder>/npm`), or a local folder (recorded, not copied; a leading `~` and a `file:`
  URL work, and a relative path is taken from the working folder). An SSH source needs the
  prefix: `git:git@github.com:owner/repo`; without it the command refuses and says so. It records the source in the
  agent folder's `settings.json` `packages`, keeping every other setting. It needs `git` (and
  `npm` for a package with dependencies) on PATH, and the network for a remote source. Their
  output passes through to the terminal; the command's last lines are the package's
  extension entry paths, one of which goes in the roster row's `extraExtensionPaths`.
  Installing gives no seat the extension: a seat loads only the paths in its own row.
  `git` runs with `GIT_TERMINAL_PROMPT=0`, so a source that needs a user name or password fails
  with git's message instead of waiting at a prompt. That does not cover SSH: an `ssh` key
  passphrase or an unknown host key can still prompt, as `pi install` would (the command does
  not force `BatchMode`, which would override your own SSH setup). The first Ctrl-C ends any
  setup command (`auth providers`, `models`, `extension ...`) at once, with exit code 1, and the
  process exits, so the package manager does not go on to record the source. A git or npm
  that was already running is not stopped by review-panel (Ctrl-C in a terminal stops it too).
  An install stopped that way says whether `settings.json` listed its source when checked after
  the stop; `review-panel extension list` shows the final state. A clone it had started may be
  left under the agent folder, and installing the source again finishes it.
- When the agent folder in use is Pi's own `~/.pi/agent`, `extension install` and `remove`
  change Pi's own packages, as `pi install` and `pi remove` do: Pi then loads the package in
  every session too. The command says so, and for another folder that `PI_CODING_AGENT_DIR`
  names it says that a Pi started with the same variable loads it too.
- `extension list` prints each installed source, where it is installed and its entry paths;
  `--json` prints the objects. Only the agent folder's own `settings.json` is read, never a
  `.pi/` folder in the working folder, so a repository cannot add a package to the list.
- `extension remove <source>` takes the source as `extension list` prints it (a local folder is
  recorded relative to the agent folder, and a source with a credential is printed redacted:
  that form removes the one recorded source it matches), or a local path from the working
  folder. It deletes a
  git clone or npm install, keeps a local folder, and exits 1 when nothing matches. Remove the
  path from every roster row too.

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
| `review-panel verify --prior-run-id <run> --head HEAD [--kept-finding-ids F-1,G-2] [--seats a,b] [--scoping-note <text>] [--low-advisory F-3,F-4] [--dismissed <json> \| @<file> \| -] [--close-out] [--no-pr-comment] [--pr 22] [--owner-approved]` | `priorRunId`, `head`, `keptFindingIds` (`""` for none; leave it out on a chained verify for every open id), `seats`, `scopingNote`, `lowAdvisory`, `dismissed`, `closeOut`, `prComment: false`, `pr`, `ownerApproved` |
| `review-panel resume --prior-run-id <run>` | `priorRunId` |
| `review-panel comment --prior-run-id <run> --owner-approved [--pr 22] [--verify-run-id <run>] [--head <ref>] [--low-advisory F-3,F-4] [--dismissed <json> \| @<file> \| -]` | `priorRunId`, `ownerApproved`, `pr`, `verifyRunId`, `head`, `lowAdvisory`, `dismissed` |
| `review-panel call '<json>'` | One action's whole argument object, for example `'{"action":"review","base":"main","head":"HEAD"}'`. `-` reads it from stdin. |

- `suggest` runs no seat and spends no quota, but needs the owner config, which it
  reads for `defaults.lenses`. It prints each lens the diff's rules
  suggest, with its reason and evidence, and marks the owner's `defaults.lenses` as
  already on. You choose the lenses and pass them to `review --lenses`.
- `verify` chains. The first verify of a review takes the review's run id as
  `--prior-run-id` and needs `--kept-finding-ids`; it must place every finding (a high or
  medium it neither keeps nor dismisses is refused; a low it leaves out is low/advisory). Every later verify takes the latest
  verify's run id, checks only what is still open after it (its still-present ids and its
  regressions, which get ids such as `V1-R1`) from that verify's head, and with no
  `--kept-finding-ids` checks every open id. An id an earlier round resolved, dismissed or left
  as low/advisory is refused, and so is a verify against the review or an older verify once a
  newer one exists: the refusal names the latest verify. See
  [Verify rounds chain](../docs/configuration.md#verify-rounds-chain).
- `review` and `verify` post their round to the open pull request whose head is the run's
  head, as a new comment, through `gh`. A verify posts the close-out card only with
  `--close-out`, and then only when nothing is open after it and no seat was lost, and after one
  final check from the review head (one seat, the owner's) reports nothing; the reply says why
  otherwise, and names the final check as the latest verify. `--no-pr-comment` turns posting
  off for one run, and `--pr` names the PR. When the owner config sets
  `defaults.prComment: "ownerApproved"`, a round posts only with `--owner-approved`. A post
  that cannot be made ends the report with one line saying why, and the exit code does not
  change. See [Posting rounds to the pull request](../docs/configuration.md#posting-rounds-to-the-pull-request).
- `comment` posts or updates the manual close-out card on the pull request, from the
  review's whole verify chain: each id resolved (with the round that resolved it), dismissed,
  low/advisory, or still open when the owner stops the rounds. When a round resolved an id, it
  first runs the final check (one seat, the owner's, minutes like a verify) and lists what it
  finds as open; when nothing was open before it, what it finds (or a lost seat) refuses the card
  and says what to run next. `--verify-run-id`, when given,
  must be the latest verify. It is refused
  without `--owner-approved`: pass that flag only after the owner said to post. It posts only to an
  open pull request whose head is the commit the card is about (the latest verify's, or else the review's):
  the one `--pr` names, or with no `--pr` the one open PR at that head. Anything else is refused with
  the reason. After a commit pushed since the last verify, run `verify` at the new head and pass
  that verify to `comment`. The card shows the
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
  appear in an error: the value of any flag (for example `--repo`, `--lenses` or `--scoping-note`),
  any value in a `call` object, such as `repository` or `priorRunId`, and the source of
  `extension install` or `remove` (a source that `install` refuses is never repeated; one it
  accepts can be). `extension install` decides on what Pi's own package
  manager parses from the source (the same parse `pi install` runs) and refuses, before
  anything is cloned or recorded:
  - a git source with any user info other than the SSH user `git`: a password, any user name
    on an `http(s)://` URL (a token often sits there alone, as in `https://<token>@host/...`),
    any other SSH user (`ssh://deploy@host/...` is refused; `git:git@host:owner/repo`,
    `ssh://git@host/owner/repo` and `git:ssh://git@host/...` install), or a scheme-less
    `git:user:token@host/...` / `git:token@host/...` however it is spaced, cased or ported;
  - a git source with a percent sign in its host;
  - a git source with any query string (`?...`), its ref included, or a pinned ref that is not
    a plain branch, tag or commit name (letters, digits, `.`, `_`, `/`, `+`, `-`); pin a ref
    with `@<ref>` or `#<ref>` (`git:host/owner/repo@release/1.0` installs);
  - an `npm:` source that is not a registry package. Only `npm:<name>` and
    `npm:<name>@<version, range or tag>` install (`npm:pi-foo`, `npm:@scope/pkg@^1.2.0`,
    `npm:pkg@latest`); a URL, `git+…`, `git:`, `github:`, `file:`, alias or path spec is refused,
    with or without a credential. Install a private package from your registry with a token
    in `.npmrc`, or use a git source (`git:git@host:owner/repo`) instead;
  - a source with a scheme that Pi cannot read as git or npm (`HTTPS://...`, `git+https://...`,
    `github:...`): Pi would look for a local folder of that name and print it.

  A refusal names no part of the source, since any part of it can hold a token: it says why the
  source was refused and what to write instead. The same holds for an scp-style source written
  without the `git:` prefix (`git@host:owner/repo`) and a `file:` URL that names no local path,
  which `extension install` and `remove` refuse before Pi parses them.

  Pi would store such a source in `settings.json`, name the clone folder after the credential,
  and git would print that folder, so the refusal is what keeps a credential out of git's and
  npm's own output, which passes through unchanged. Give git the token through a credential
  helper, use an SSH source, or put an npm token in `.npmrc`. review-panel's own lines
  (progress, result, list, `models`, errors and `--json`) also show a credential as `***`, for
  a source that Pi or an earlier version recorded, in the source and in the folder Pi named
  after it. Such a path cannot be copied into a roster row, and the output says so; remove the
  source and install it again without the credential. Any other `@` in a path (a folder
  named `ext@v2`, a `.pnpm/name@1.2.0` folder) prints as it is.

| Exit code | Meaning |
|---|---|
| 0 | The command completed. That includes a review with findings and a `diagnose` that says `needs setup`: read the report. |
| 1 | A refusal or an operational failure, such as an unready panel, a missing commit, `comment` without `--owner-approved`, or Ctrl-C. |
| 2 | A usage error: an unknown command or flag, or arguments an action would reject. `review-panel audit` and `{"action":"audit"}` exit 2 and say the repository audit was removed. |

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
