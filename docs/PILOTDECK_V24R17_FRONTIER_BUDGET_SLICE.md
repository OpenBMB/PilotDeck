# PilotDeck V24R17a: frontier and finalization budget slice

## Purpose

Reduce repeated legal matrix discovery without changing canonical write
semantics. This slice is deliberately smaller than the full parallel proposal
plan: it provides a stable read-only planning interface and a generic phase
budget decision, while the existing single-matrix selection/proposal/apply
transactions remain authoritative.

## Legal Coverage: `legal-matrix-frontier/v1`

`matrix-frontier --workspace "$PWD"` returns a bounded object containing:

- one opaque `stateHash` shared by the frontier and fact-index snapshot;
- at most three pending matrix descriptors;
- an `eligible` flag and dependency marker for each descriptor;
- a bounded fact index with IDs, subject/predicate labels, date, materiality,
  criticality, and linked status;
- `factsHash`, counts, and a serialized-byte limit.

The index intentionally omits full fact values and source text. It is a
planning aid, not a replacement for the existing evidence-page protocol.
`legal-authority` is marked blocked until issue rows exist. This is a legal
plugin dependency, not a Core rule.

When a matrix milestone is injected, the same frontier is attached to
`workItems.frontier`. Agents may analyze eligible entries with bounded
parallelism, but each canonical write must still use the existing state-bound
selection/proposal/apply path.

## Core: `phase-budget/v1`

`PhaseBudgetController` is opt-in and domain-neutral. Given a turn deadline and
an optional phase budget, it returns `within_budget`, `phase_budget_exhausted`,
`finalization_reserve`, or `deadline_expired`. It never stops a turn itself.

When configured, AgentLoop emits `phase_budget_evaluated`; O1 records it as a
bounded `phase-budget` harness decision. A caller can use `finishFirst=true` to
stop opening new source/matrix work and preserve time for issue, authority,
proof, and report finalization.

## Explicit non-goals

- No validator rule or schema change.
- No change to Lease `8/2`, Router, Memory, model, or deadline defaults.
- No parallel canonical writes.
- No multi-proposal atomic apply yet.
- No automatic change to existing campaigns; V24R15 and V24R16 campaigns stay
  frozen.

## Next bounded slice

The next change may add read-only proposal preparation for a frontier snapshot.
Each proposal must carry the same expected state hash and be applied by the main
Agent one at a time. A stale proposal must be rejected and regenerated from a
fresh frontier; it must never be applied against a changed ledger.
