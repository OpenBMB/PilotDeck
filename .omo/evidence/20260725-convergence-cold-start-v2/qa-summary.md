# Convergence cold-start allowance QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`

## What was tested

- Core `ProgressLease` behavior with a larger initial stagnant limit and the
  original strict steady-state limit.
- Pilot config parsing, defaults, bounds, and invalid initial/steady ordering.
- Existing AgentLoop rejected-compaction fail-closed behavior.
- Full PilotDeck regression suite, including the real local Gateway/legal hook
  integration tests.
- The motivating isolated experiment is recorded at
  `/Users/da/Documents/PilotDeck-eval-labs/20260725-e2-elite-convergence-v2/evidence/gate-2-paired-case09-cold-start-finding.md`.

## What was observed

- Focused build and tests: 15/15 passed.
- Full `npm test`: 238/238 passed.
- With `maxInitialStagnantObservations=4` in the unit fixture, three unchanged
  cold-start observations are allowed; the first opaque state-hash change
  renews the scope, after which one unchanged observation again schedules the
  strict `maxStagnantObservations=2` boundary.
- Omitting the new field defaults it to the existing steady-state threshold,
  preserving prior behavior for existing opt-in configs.
- Invalid initial limits below the steady-state limit fail config parsing.
- Progress lease remains absent by default; production behavior is unchanged
  unless the existing evaluation-only feature is explicitly enabled.

## Why this is enough

The unit tests cover the new state transition and configuration contract. The
AgentLoop test keeps the prior fail-closed boundary behavior covered, and the
full suite covers shared runtime, Gateway, legal plugin, artifact, context, and
tool regressions. The next isolated v3 campaign is still required to validate
the behavior against the real Case 09 model trajectory.

## What was omitted

No credentials, tokens, environment dumps, or raw model request payloads are
stored here. The v2 campaign retains the full run-local artifacts.
