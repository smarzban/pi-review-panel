# pi-review-panel

A review panel for pi coding agents. Configured reviewer seats run over one pinned
change and record evidence under `.review-panel/`. The tool does not compute a
merge decision. The owner remains the merge gate.

**Status:** 0.1.0. Diagnose, review, verify, and comment are the public path.

## Supported path

`review_panel` is the package's public review tool. Every call names an absolute
`repository`.

1. Diagnose setup before review:

   ```json
   {"action":"diagnose","repository":"/Users/you/the-repo"}
   ```

2. Review an explicit change:

   ```json
   {"action":"review","repository":"/Users/you/the-repo","base":"origin/main","head":"HEAD"}
   ```

   Optional `lenses` add specialist extras. Optional `scopingNote` focuses a large
   diff. Holistic seats always run. The result includes advisory lens suggestions.

3. After you fix kept findings, verify the fix range:

   ```json
   {"action":"verify","repository":"/Users/you/the-repo","priorRunId":"<run-id>","head":"HEAD","keptFindingIds":["F-1"]}
   ```

4. After a first review with nothing kept, or a clean verify, ask the owner
   before posting. Yes posts or updates one PR comment (`## Review panel`).
   The tool does not post until `ownerApproved` is true.

   ```json
   {"action":"comment","repository":"/Users/you/the-repo","priorRunId":"<run-id>","ownerApproved":true,"pr":29,"dismissed":[{"id":"F-4","reason":"checked, not real"}],"lowAdvisory":["F-8"]}
   ```

The result is bounded Markdown: coverage, finding counts or dispositions, lost
seats, and the record path. Judge the report, fix real blockers in your harness,
then verify. The skill describes when to tell the owner the change looks ready
to land, and when to ask before posting the close-out comment.

## Setup

Create the owner-controlled configuration outside the repository
(`~/.pi-review-panel/config.json`), then run `diagnose`. See the
[owner configuration guide](docs/configuration.md).

Point Pi's `packages` list at this repository and restart Pi.

## Package surface

The package ships TypeScript source, package-owned prompts, the review-panel
skill, and public configuration documentation. Pi loads the extension directly.
