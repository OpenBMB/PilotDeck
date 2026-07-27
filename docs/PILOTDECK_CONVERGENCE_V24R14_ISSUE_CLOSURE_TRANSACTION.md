# PilotDeck V24R14 issue closure transaction

## Problem contract

V24R13 proves that capacity-aware full compaction resolves the Case 09 Core
context-lifecycle blocker. The preserved V24R13 run reaches 24 reviewed sources,
100 facts, and one applied matrix before failing closed on
`issues/risk_signal_orphaned`.

The failure is an executable-interface gap in the Legal Coverage plugin:

- dynamic context identifies the validator error and injects issue-rule
  guidance;
- the CLI provides state-bound source, matrix, and authority transactions;
- no issue proposal/apply transaction exists;
- the generic issue instruction does not provide a bounded evidence slice,
  exact document schema, reciprocal matrix-link update, or apply command.

The model therefore loads issue guidance, validates, and inspects CLI help but
cannot form a durable issue mutation before Progress Lease correctly fails
closed.

## Scope

V24R14 changes only the Legal Coverage plugin and its tests, docs, and QA
evidence. It does not change:

- Core compaction or context thresholds;
- Progress Lease limits or decisions;
- validator rules, phase ordering, or completion authority;
- source, matrix, authority, coverage, or report contracts;
- Router, Memory, model, Skills, corpus, runner, or deadlines.

Only the first blocking error `issues/risk_signal_orphaned` is supported. Other
issue error codes remain fail closed and retain the existing interface.

## Transaction contract

The plugin exposes one deterministic transaction for one matrix entry:

1. Locate the first matrix entry with risk signals and no linked issue IDs.
2. Inject only the target entry, its complete bounded fact slice, allowed
   signal-to-rule mappings, and an exact proposal template.
3. Require a proposal at
   `.pilotdeck/work/legal-coverage/issue-transactions/issue-closure-<digest>.json`.
4. Validate the proposal without mutating canonical state.
5. Expose `issue-closure-apply` only after the exact proposal bytes pass.
6. Recheck path, SHA-256, state hash, target identity, and proposal scope at
   apply time.
7. Atomically append the new issues and replace only the target matrix entry's
   `issueIds`; roll back both ledgers if either write fails.
8. Run the unchanged validator immediately after apply.

The bounded interface is at most one matrix entry, 12 target facts, one issue
per unique risk signal, and 24 KiB serialized proposal/prepared context.

## Validation invariants

- Proposal keys, phase, group, state hash, target entry, and prepared-slice
  hash must exactly match the injected template.
- Every proposed issue ID is new, unique, non-placeholder, and canonical.
- Every target risk signal has exactly one issue with its mapped rule ID.
- No issue rule outside the target signals is accepted.
- Every issue uses exactly the target entry's fact IDs and contains status,
  severity, critical flag, analysis, conclusion, recommendations, and an
  authority ID array.
- Every issue's critical flag equals whether the target fact slice contains a
  critical fact; the transaction cannot downgrade critical evidence to avoid
  the unchanged authority requirement.
- Matrix links equal the proposed issue IDs exactly; existing authority links
  and all unrelated records are preserved.
- Invalid, changed, stale, replayed, oversized, outside-workspace, or symlinked
  proposals fail without canonical mutation.
- A validated proposal advances only the opaque handoff signal. Canonical
  state and semantic progress advance only after apply.

## Counterexample

The regression fixture is synthetic and contains no case text. It preserves
only the failure shape: a complete matrix entry with three bounded facts, one
`rights_governance_conflict` signal, no issue links, empty issue ledger, and a
`risk_signal_orphaned` first error. The red assertion requires the dynamic
milestone to provide a state-bound issue proposal/apply path instead of generic
repair prose.

## Gate

The code gate requires focused Legal Coverage tests, convergence tests, and the
full repository suite. The product gate requires a new immutable campaign with
the same runner, baseline, model, Skills, corpus, Router/Memory controls,
O1 profile, deadline, and Lease `8/2`. V25 and the 85-case campaign remain
blocked until Case 09 completes validator, completion proof, and substantive
report contracts.
