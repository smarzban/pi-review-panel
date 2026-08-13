# pi-review-panel

A review panel for pi coding agents. Configured reviewer seats run over one pinned
change and record evidence under `.review-panel/`. The tool does not compute a
merge decision. The owner remains the merge gate.

**Status:** 0.1.0. Diagnose, review, and verify are the public path. Extracted
from the archived `pi-empanel` review surface; the unused repair loop was left
behind.

## Supported path

`review_panel` is the package's public review tool. Every call names an absolute
`repository`.

1. Diagnose setup before review:

   ```json
   {"action":"diagnose","repository":"/absolute/path/to/repository"}
   ```

2. Review an explicit change:

   ```json
   {"action":"review","repository":"/absolute/path/to/repository","base":"origin/main","head":"HEAD"}
   ```

   Optional `lenses` add specialist extras. Optional `scopingNote` focuses a large
   diff. Holistic seats always run. The result includes advisory lens suggestions.

3. After you fix kept findings, verify the fix range:

   ```json
   {"action":"verify","repository":"/absolute/path/to/repository","priorRunId":"<run-id>","head":"HEAD","keptFindingIds":["F-1"]}
   ```

The result is bounded Markdown: coverage, finding counts or dispositions, lost
seats, and the record path. Judge the report, fix real blockers in your harness,
then verify. The skill describes when to tell the owner the change looks ready
to land.

## Setup

Create the owner-controlled configuration outside the repository
(`~/.pi-review-panel/config.json`), then run `diagnose`. See the
[owner configuration guide](docs/configuration.md).

Point Pi's `packages` list at this repository and restart Pi.

## Package surface

The package ships TypeScript source, package-owned prompts, the review-panel
skill, and public configuration documentation. Pi loads the extension directly.
