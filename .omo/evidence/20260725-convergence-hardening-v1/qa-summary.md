# Convergence Hardening V1 QA

## What was tested

- `npm test` in `/Users/da/Documents/PilotDeck-worktrees/20260725-convergence-hardening-v1`.
- Focused AgentLoop, progress-lease, compaction, config, and legal-plugin tests after the implementation.
- Sanitized Case 09 context replay from `tests/fixtures/convergence/case-09-context-replay.json`.
- Legal hook output with `pilotdeckConvergence` metadata and existing dynamic milestone injection.

## What was observed

- Full build and test gate: **235 passed, 0 failed**.
- Focused convergence/legal gate: **42 passed, 0 failed**.
- The progress lease is inert when omitted from config.
- With `agent.progressLease.mode: evaluation`, one unchanged report schedules a forced full boundary; a rejected or unavailable boundary stops before the next model request; an accepted boundary permits one post-boundary turn and then stops if the opaque state remains unchanged.
- The AgentLoop integration test observed two model requests and three compaction evaluations, with `agent_convergence_stalled` on the third unchanged observation.
- Legal hook metadata contains only bounded generic convergence fields in addition to its existing legal activation metadata. It carries no rubric, ground truth, or source contents.
- The sanitized Case 09 replay reaches `fail_closed` at the rejected blocking compaction boundary instead of continuing through the historical 132-request loop.

## Why this is enough

The pure policy tests cover disabled, progress, completion, forced-boundary, rejection, post-boundary stagnation, and malformed metadata cases. The AgentLoop test covers the actual lifecycle ordering. The context test proves forced full compaction is independent of the ordinary token threshold. The legal tests prove domain output and existing behavior remain compatible. The full repository gate covers integration and regression risk.

## What was omitted

- No live LLM or Gateway campaign was run from this unpushed worktree.
- No raw model messages, legal source contents, credentials, API keys, or evaluator material were copied into evidence.
- No 85-case campaign was started; the RUNBOOK ladder still requires short inactive cases and a fresh Candidate-only Case 09 after the commit is pushed.

## Prior input-lineage evidence

Runner input preservation and Legal source-lineage interoperability remain covered by:

- `/Users/da/ws/Lantay-PD-test/worktrees/20260725-eval-runner-source-lineage/.omo/evidence/20260725-eval-runner-input-lineage/qa-summary.md`
- `/Users/da/Documents/PilotDeck-worktrees/20260725-convergence-hardening-v1/.omo/evidence/20260725-legal-input-lineage/qa-summary.md`
