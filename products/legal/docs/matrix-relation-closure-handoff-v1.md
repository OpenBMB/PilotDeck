# Matrix Relation-Closure Handoff v1

Status: implementation experiment derived from the v19 fresh Case 09 run.

## Problem

The matrix mutation contract works when the validator identifies one concrete
matrix record, such as `matrix_pending`. It is incomplete for aggregate
relationship errors such as `material_fact_matrix_orphaned`:

- the validator correctly reports that a material fact has no matrix link;
- the mutation contract has no `recordId` because selecting the legally
  appropriate matrix requires legal judgment;
- the Agent must rediscover the affected fact IDs from a large ledger;
- that read-only discovery does not advance canonical state;
- the steady-state convergence lease may fail closed before the next write.

The v19 run demonstrated this sequence after source review had already reached
24 reviewed sources and 94 reciprocal facts. The Agent used its final boundary
turn to discover 37 orphaned material facts and was stopped before it could
change a matrix.

## Decision

For matrix relationship-closure errors, the Legal Plugin injects one compact,
deterministic repair batch with the existing mutation contract.

The batch contains:

- the current validator state hash;
- up to 12 orphaned canonical facts and at most 8 KiB of serialized fact data;
- compact evidence fields needed for legal classification;
- the current required matrix IDs, statuses, and collection indexes;
- remaining/returned/has-more counters.

The 8 KiB limit applies to injected fact data. The canonical mutation budget
remains separately fixed at one matrix and 24 KiB.

The Agent must choose the legally appropriate target. It may update exactly one
matrix, must preserve every other record, must not change fact materiality to
avoid the link requirement, and must validate immediately after the write.

This is a state handoff, not an automatic classifier. The plugin identifies a
broken relationship and supplies bounded canonical evidence; the model retains
ownership of the legal mapping and narrative summary.

## Boundaries

This experiment does not change:

- Core convergence or the cold-start 8 / steady-state 2 lease;
- validator semantics or required matrix IDs;
- source worker ownership, source readiness checkpoints, or proposal/apply;
- canonical fact content or materiality;
- the one-matrix / 24 KiB mutation boundary;
- legal authority, issue, coverage, or deliverable requirements;
- prompts with benchmark IDs, expected answers, or Case 09 literals.

It also does not add a matrix apply CLI. Matrix writes remain direct canonical
workspace edits by the main Agent under the existing mutation contract.

## Expected behavior

On the first `material_fact_matrix_orphaned` request, the Agent receives the
next deterministic orphan batch instead of having to write a custom inspection
script or read the full `facts.json`. It reads the current `matrices.json`,
chooses one compatible matrix, updates its summary and fact links in one
bounded edit, and validates. A successful mutation changes the canonical state
hash and reduces or changes the orphan batch, so the unchanged Core lease sees
real progress.

If no injected fact is semantically compatible with one matrix, the Agent must
not force a false link. It should preserve uncertainty and use the validator
result to expose the modeling conflict. The plugin never weakens validation to
manufacture completion.

## Verification gates

1. Unit tests prove deterministic selection, byte and record bounds, compact
   target metadata, repeated-call stability, and convergence-hash advancement
   after a valid one-matrix edit.
2. Legal Plugin tests and the full PilotDeck test suite pass.
3. Offline replay against the v19 settled snapshot proves the injected batch
   identifies the same first orphan facts without modifying the snapshot.
4. A fresh candidate-only Case 09 run proves whether the Agent performs a
   matrix mutation before the steady-state lease closes.
5. Later blockers are attributed separately; passing relation closure does not
   imply the whole legal case is complete.
