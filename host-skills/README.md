# Host skills

Skills for agents that **are not Pi** (Grok, Codex, Claude Code). The `review-panel` host skill
runs the standalone `review-panel` CLI (see `cli/README.md`), reads the report, and judges each
finding. It never starts Pi. Do not copy these into Pi's `skills/` tree; Pi loads its own
`review-panel-pi` skill from the package.

## Install

Install the CLI first (`cli/README.md`), then copy the skill:

```bash
# Grok
mkdir -p ~/.grok/skills/review-panel
cp host-skills/review-panel/SKILL.md ~/.grok/skills/review-panel/SKILL.md

# Codex
mkdir -p ~/.codex/skills/review-panel
cp host-skills/review-panel/SKILL.md ~/.codex/skills/review-panel/SKILL.md

# Claude Code
mkdir -p ~/.claude/skills/review-panel
cp host-skills/review-panel/SKILL.md ~/.claude/skills/review-panel/SKILL.md
```

Invoke as `/review-panel`, or ask the agent to review a PR / the current diff.
