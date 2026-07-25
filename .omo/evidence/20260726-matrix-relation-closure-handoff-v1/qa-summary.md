# Matrix relation-closure handoff v1 QA

Date: 2026-07-26 (Asia/Shanghai)
Branch: `codex/matrix-relation-closure-handoff-v1`
Base: `c5911e5f37837ab38c67580965828ed6f4acb778`
Triggering run: v19 candidate Case 09 `20260725_235439_a361cc03`

## What was tested

- Added a Legal Plugin work batch for the first
  `material_fact_matrix_orphaned` validator blocker.
- Injected at most 12 compact canonical orphan facts and at most 8 KiB of
  actual serialized `items` JSON while retaining the existing one-matrix /
  24 KiB canonical write budget.
- Required the Agent to choose one legally compatible required matrix instead
  of having the plugin classify facts or select a legal conclusion.
- Added an extra valid custom matrix as a negative test and proved that it is
  not exposed as an eligible contract target.
- Proved repeated hook calls produce the same batch and state hash, and that a
  valid one-matrix edit advances the state hash and next batch.
- Replayed the preserved v19 Case 09 workspace from an isolated `/tmp` copy
  through the real changed Legal Plugin `PreModelRequest` hook.
- Ran Node syntax checks, a clean TypeScript build, the focused Legal Plugin
  suite, the complete PilotDeck suite, and `git diff --check`.

## What was observed

- Node syntax checks passed for the changed hook and validator library.
- Focused Legal Plugin suite: 34/34 passed.
- Complete `pnpm test`: 247/247 passed, with no failures or skipped tests.
- `git diff --check` passed.
- The negative test initially surfaced `matrix_pending` because its custom
  fixture was invalid. After changing it to a valid `not-applicable` record,
  the test proved that only the seven required matrix IDs are exposed.
- In the v19 replay, the first blocker remained
  `material_fact_matrix_orphaned`, with 37 occurrences.
- The hook returned the same first 12 fact IDs identified in the failed run.
- Injected `items` measured exactly 6,501 bytes; the complete dynamic context
  measured 15,040 bytes.
- The convergence projection reported group
  `material-fact-matrix-closure`, write budget 1 / 24,576 bytes, and an opaque
  state hash.
- The injected action explicitly prohibited rereading the full facts ledger,
  custom discovery scripts, and changing fact materiality to avoid validation.
- Canonical ledgers were byte-identical before and after replay:
  - `sources.json`: `ef0dc9c40c0fbedc706542716423ebdb2ae2e1a0366f93236dc2f85a78abb994`
  - `facts.json`: `e09feec24e6d97095bf9849dd4991c41b9ece80f2446923f99aa373597f5ab90`
  - `matrices.json`: `6ad10b0fa5c34298e24b545585df4c3ee7e45adfa393691f72ffb50d790fd17c`

Replay copy:
`/tmp/pilotdeck-v20-matrix-replay.8SysMV`

## Why it is enough

The focused test covers deterministic selection, actual serialized byte and
record bounds, target allowlisting, repeated-call stability, and observable
progress after a bounded canonical edit. The complete suite covers regression
risk across Core, Gateway, tools, and the existing Legal Plugin workflow. The
real failed snapshot proves that the exact blocker which exhausted the v19
lease now arrives as a bounded write-ready legal judgment task without changing
canonical evidence.

The plugin still does not decide which facts belong in which legal matrix. It
only performs deterministic state assembly; semantic classification and the
matrix narrative remain Agent-owned and validator-enforced.

## Boundary audit

Unchanged:

- Core AgentLoop and progress lease thresholds (cold 8, steady 2)
- Legal validator semantics, materiality, and required matrix IDs
- Source worker ownership, checkpoints, proposals, and atomic apply
- Matrix canonical write limit (one matrix / 24 KiB)
- Corpus, model, runner, router/memory settings, and evaluation conditions
- Case-specific legal facts, expected answers, and benchmark IDs

## What was omitted

- No real provider call was made during product QA.
- The preserved v19 run was replayed read-only; it was not resumed or retried.
- The one redundant full worker-fragment read observed in v19 remains outside
  this change.
- Live semantic behavior must be measured in one fresh immutable v20 campaign;
  later matrix, issue, authority, coverage, or deliverable blockers must be
  attributed separately.
- No token, API key, auth header, environment dump, raw private corpus content,
  or secret-bearing model log is stored here.
