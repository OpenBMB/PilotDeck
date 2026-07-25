# Legal missing-deliverable contract QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`

## What was tested

- A safe workspace-relative deliverable path whose file is not created yet is
  classified as `deliverable_missing`, not `deliverable_path_invalid`.
- The legal milestone instructs the Agent to create a non-empty skeleton at
  the exact configured path with `write_file` and then validate.
- Traversal and symbolic-link deliverable paths remain rejected as
  `deliverable_path_invalid`.
- Existing legal validator, hook, progress lease, real local Gateway, artifact,
  context, tool, and configuration behavior.

## What was observed

- Focused legal coverage suite: 27/27 passed.
- Full `npm test`: 239/239 passed.
- The new fixture initializes `deliverables/opinion.md` without creating it;
  validation reports `deliverable_missing`, the request-local milestone names
  the exact path and `write_file`, and no completion proof is created.
- Existing ancestor-symlink and proof-symlink fixtures still fail closed.
- PilotDeck Core and its convergence thresholds were not changed.

## Why this is enough

The regression test reproduces the contract mismatch observed in v4 Case 09,
while the existing adversarial path fixtures prove the safety boundary remains
strict. The full suite covers shared runtime and Gateway regressions. A fresh
v5 campaign is still required to prove that the real model creates the
deliverable skeleton and advances to source review.

## What was omitted

No credentials, tokens, auth headers, environment dumps, raw private case
content, or model payloads are stored here. The motivating run is preserved at
`/Users/da/Documents/PilotDeck-eval-labs/20260725-e2-elite-convergence-v4`.
