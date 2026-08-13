# Constitution

Standing, project-wide guardrails. Every design and change is checked against these; they change
rarely and deliberately.

- **Code does not compute a merge decision.** No verdict, no agreement arithmetic, no computed
  severity, no review-derived semantic stop signal. Fixed operational bounds may halt work and
  expose the cause, but they make no quality claim. The orchestrator judges findings and may write
  a merge recommendation; the owner is the merge gate.
- **Findings enter only through the structured channel.** A seat's findings exist iff its
  `submit_findings` tool call recorded them. Prose is never parsed into findings.
- **Reviewers are read-only.** Seats run under an explicit tool allowlist with no write, edit, or
  shell execution; they observe a pinned snapshot, never the live tree.
- **Repair is not a package feature.** The calling agent may edit the working tree after reading a
  report. pi-review-panel does not authorize, dispatch, commit, or implement fixes.
- **Seat severity is opinion.** The orchestrator may keep a low or drop a high, with a recorded
  reason. The tool does not restamp severity.
- **Every seat is reproducible.** A run records the complete package-runner replay input, including
  target revisions, exact provider/model, prompt role, tool contract, configured extensions, and
  options.
- **Roster identity is exact.** Configs pin exact `provider/model` ids; model patterns are never
  used for seat identity.
- **Mechanics in code, judgment in agents.** Spawn, collect, format, and count in code. Validity,
  priority, sameness, and doneness stay with the agent and the owner.
- **The core stays a plain module; adapters stay thin.** Harness entry points and the seat backend
  are swappable without touching review planning.
- **The owner is the merge gate.** Nothing in this system merges a change.
