# Legal source-merge handoff checkpoint QA

Date: 2026-07-25 (Asia/Shanghai)
Branch: `codex/source-merge-handoff-checkpoint-v1`
Base: `1dec8e5552cdddc67ba518d9d59fe15dfc9360ed`
Triggering run: v18 candidate Case 09 `20260725_231649_ac3f35f8`

## What was tested

- Added a Legal Plugin `source-merge-prepare` command that validates the current
  bounded worker slice and writes one deterministic readiness checkpoint.
- Bound the checkpoint to validator state SHA-256, proposal path, fragment path
  and receipt SHA-256, ordered source IDs, and the deterministic slice SHA-256.
- Added an explicit `source-fragment-propose` work group so the next
  `PreModelRequest` advances from inspection to proposal writing instead of
  repeating the inspection instruction.
- Kept the readiness artifact outside canonical sources/facts and preserved the
  existing SHA-bound proposal/apply transaction.
- Tested stale state, tampered checkpoint, invalid proposal repair, valid
  proposal apply, changed-proposal rejection, and stale apply replay.
- Replayed the preserved v18 Case 09 workspace from an isolated `/tmp` copy
  through the real changed Legal Plugin hook and exact injected preparation
  command.
- Ran syntax checks, clean TypeScript builds, the focused Legal Plugin suite,
  and the complete PilotDeck suite.

## What was observed

- Node syntax checks passed for the hook, CLI, and validator library.
- Focused Legal Plugin suite: 33/33 passed.
- Complete `npm test`: 246/246 passed before and after the final convergence
  projection hardening.
- `git diff --check` passed.
- In the v18 artifact replay, preparation output was 8,806 bytes and the
  readiness checkpoint was 644 bytes.
- The work group advanced from `source-fragment-merge` / `main-agent-merge` to
  `source-fragment-propose` / `main-agent-propose`.
- The opaque convergence hash changed across that transition.
- Canonical `sources.json` and `facts.json` SHA-256 values remained unchanged.
- No proposal or apply command was manufactured by preparation; proposal
  writing remains the main Agent's next legal-judgment action.
- A checkpoint with a changed slice hash was ignored and projected the original
  merge state/hash. A stale expected state was rejected without overwriting the
  valid checkpoint.

Replay copy:
`/tmp/pilotdeck-case09-handoff-replay.94RPiR`

## Why it is enough

The product test covers both data-plane safety and control-plane progress:
checkpoint creation is bounded and atomic, semantic fields are revalidated from
current workspace state, tampering fails closed, and the operational stage
change is visible to the unchanged Core lease. The real failed snapshot proves
that the exact state which previously repeated inspection now advances to a
write-ready proposal prompt without changing either canonical ledger.

The final projection deliberately excludes checkpoint file-byte hashes. Only
semantic readiness and the deterministic slice hash are exposed, so rewriting
equivalent JSON whitespace cannot manufacture lease progress.

## Boundary audit

Unchanged:

- Core AgentLoop and progress lease thresholds (cold 8, steady 2)
- Legal validator semantics and required legal records
- Worker ownership and disjoint fragment permissions
- Canonical source/fact proposal validation and atomic apply
- Matrix mutation contract
- Corpus, model, runner, router/memory settings, and evaluation conditions
- Case-specific legal facts or answers

## What was omitted

- No real provider call was made during product QA.
- The failed v18 Case 09 run was not retried and baseline Case 09 was not run.
- Live compliance must be evaluated from a fresh immutable campaign after this
  change is committed and frozen.
- No token, API key, auth header, environment dump, raw private corpus content,
  or secret-bearing model log is stored here.
