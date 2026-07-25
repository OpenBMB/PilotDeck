# Legal matrix mutation contract QA

Date: 2026-07-25 (Asia/Shanghai)
Branch: `codex/convergence-hardening-v1`
Triggering run: v17 candidate Case 09 `20260725_223550_9daf7d34`

## What was tested

- Added structured `recordId` and `collectionIndex` details to
  `matrix_pending` validator errors.
- Added a request-local `mutationContract` for the matrices phase that declares
  the main Agent as the only writer, the exact canonical JSON path, current
  target matrix, one-record/24-KiB budget, required matrix IDs and row shape,
  direct workspace-file-write interface, and post-write validation command.
- Verified the contract explicitly says no phase-specific apply command is
  available and forbids probing for or inventing one.
- Verified a bounded canonical matrix change advances the target to the next
  pending matrix and changes the opaque convergence hash used by the unchanged
  Core progress lease.
- Replayed the preserved v17 Case 09 workspace from an isolated `/tmp` copy
  through the real Legal Plugin `PreModelRequest` hook.
- Ran syntax checks, a clean TypeScript build, the focused Legal Plugin suite,
  and the complete PilotDeck test suite.

## What was observed

- Focused Legal Plugin suite after the final test update: 33/33 passed.
- Complete `npm test`: 246/246 passed.
- `git diff --check` and Node syntax checks passed.
- The v17 artifact replay preserved the observed state: 24 reviewed sources,
  96 facts, zero issues, zero authorities, and `matrix_pending` as the first
  blocker.
- The replay injected `equity-capital-timeline` at collection index 0 as the
  exact next target, with `.pilotdeck/work/legal-coverage/matrices.json` as the
  canonical path and `maxChangedRecords: 1`.
- The replay copy is `/tmp/pd-v18-matrix-contract-replay.L3wlen`; the frozen
  campaign evidence and original workspace were not modified.

## Why it is enough

The product test covers the contract as structured data rather than relying on
prompt substrings alone, and proves iterative state advancement renews the
existing opaque lease. The preserved-workspace replay covers the exact state
that caused the model to guess `matrix-apply`. The full suite covers shared
Gateway, hook injection, artifact, compaction, tool, and Core lease regressions.

This change does not alter Core lease thresholds, validator legal semantics,
source transactions, worker ownership, corpus bytes, evaluation conditions, or
any case-specific legal conclusion.

## What was omitted

- No real provider call was made during pre-commit QA. Model compliance must be
  tested in a fresh immutable v18 campaign.
- No baseline Case 09 run or retry of the failed v17 product run was performed.
- No token, API key, auth header, environment dump, raw private corpus content,
  or secret-bearing model log is stored here.
