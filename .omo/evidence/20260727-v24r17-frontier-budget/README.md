# V24R17a Frontier and Finalization Budget Evidence

## What was tested

- `pnpm test` after the implementation and Gateway projection change.
- Focused regression suite covering `AgentLoop`, phase-budget policy, O1 recorder mapping, Gateway event projection, and Legal Coverage frontier behavior.
- `git diff --check` before verification.

## What was observed

- Full test log: `pnpm-test.log`.
- Full suite result: `334` tests, `334` passed, `0` failed.
- Focused test log: `focused-test.log`.
- Focused suite result: `100` tests, `100` passed, `0` failed.
- The AgentLoop integration test caught and then verified the fix for mixed clock sources: budget evaluation now uses the same injected clock as the turn start.
- Gateway projection exposes `phase_budget_evaluated` as bounded `agent_status`; O1 records the same decision as `phase-budget/v1` without prompt or secret payloads.

## Why this is enough

This covers the new generic Core policy, its AgentLoop event path, the Gateway presentation path, the O1 observation path, and the Legal plugin's bounded read-only frontier/index contract. Existing single-matrix selection/proposal/apply and stale-state validation remain covered by the full suite.

## Boundary and omissions

- No live campaign was started and frozen V24R15/V24R16 campaigns were not rerun.
- No default deadline, Lease `8/2`, Router, Memory, model, or validator semantics were changed.
- No canonical ledger is written by frontier planning; no multi-proposal parallel write or atomic batch apply is included in this slice.
- No API keys, authorization headers, environment dumps, or raw provider logs are present in this evidence.
