# Host skills

Skills for agents that **are not Pi** (Grok, Codex, Claude Code). They launch Pi
and ask it to run Review panel. Do not copy these into Pi's `skills/` tree.

## Install

```bash
# Grok
mkdir -p ~/.grok/skills/pi-review
cp host-skills/pi-review/SKILL.md ~/.grok/skills/pi-review/SKILL.md

# Codex
mkdir -p ~/.codex/skills/pi-review
cp host-skills/pi-review/SKILL.md ~/.codex/skills/pi-review/SKILL.md

# Claude Code
mkdir -p ~/.claude/skills/pi-review
cp host-skills/pi-review/SKILL.md ~/.claude/skills/pi-review/SKILL.md
```

Invoke as `/pi-review`, or ask the agent to review a PR / the current diff.
