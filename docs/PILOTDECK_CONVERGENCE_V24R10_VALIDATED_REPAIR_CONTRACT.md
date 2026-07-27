# PilotDeck Convergence V24R10: Validated Repair Contract

## Decision

V24R10 fixes the V24R9 Case 09 product-gate failure before the ordinary source
apply stage. It changes only the Legal Coverage repair contract and repair
preparation accounting. It does not change Agent Core, O1, validator acceptance,
Progress Lease thresholds `8/2`, Router, Memory, the model, the corpus, source
apply receipts, matrix selection, authority closure, or completion authority.

The failed run wrote the correct deterministic immutable repair path but the
transaction itself was invalid. A replacement fact inferred a plausible
document type instead of using the exact `evidenceClass` already validated on
the referenced worker fragment. The PostToolUse hook then counted any non-empty
file at the repair path as prepared, so an invalid transaction consumed the one
`repair_preparation_grace` even though no apply command existed.

## Contract

The source repair slice now exposes the exact `evidenceClass` from each
validated fragment source next to its existing exact locators, statements,
conflicts, and unresolved items.

When a rejected fact has `source_merge_fact_evidence_mismatch`, the repair
template derives a corrected `evidenceClass` only if all referenced fragment
rows resolve to exactly one allowed class. This is a mechanical projection of
validated receipt metadata, not a new legal inference. If references permit
multiple classes or no validated class, the template preserves the rejected
fact and the Agent must decide from the bounded repair slice.

The dynamic next action tells the Agent to preserve validator-derived template
fields and to use exact source-context classifications rather than infer a
document type. Existing diagnostics remain authoritative for every field that
cannot be derived uniquely, including semantic locator selection, time,
threshold, materiality, and removal.

## Preparation Boundary

A `write_file` event at the deterministic repair path is no longer sufficient
to advance `repairPreparationOrdinal`.

After the write, Legal Coverage revalidates the current workspace and derives
the current bounded work item. Preparation advances only when all of the
following hold:

- the file is the exact state-bound repair target;
- the file is non-empty and within the existing 24 KiB limit;
- the unchanged full repair validator accepts the complete transaction;
- the derived work item is `source-fragment-repair-apply`;
- its repair receipt is marked validated; and
- its path exactly matches the expected repair target.

Only that state exposes `sourceMergeRepairApplyCommand` and earns the existing
one `repair_preparation_grace`. Invalid content, wrong paths, missing files,
overflow, reads, replay, and rejected repairs advance neither preparation nor
semantic progress.

## Boundaries

- Validator acceptance is unchanged. The template cannot make an invalid
  transaction valid unless its projected field already comes from validated
  fragment metadata.
- No canonical ledger is mutated during derivation or preparation.
- No extra repair attempt, grace kind, stagnant observation, or retry loop is
  introduced. An invalid immutable repair still fails closed.
- Source-context additions remain inside the existing bounded repair slice and
  24 KiB transaction limits.
- Core continues to receive only opaque ordinals, counts, and hashes. It does
  not learn legal source fields or transaction rules.

## Counterexamples

Tests must prove that:

- a unique referenced fragment class is projected into the repair template;
- ambiguous or missing classes are not guessed;
- rejected facts and the original proposal remain unchanged;
- wrong-path, missing, empty, oversized, malformed, stale, duplicate,
  out-of-scope, placeholder, invalid-locator, and otherwise invalid repair
  writes do not advance `repairPreparationOrdinal`;
- a valid state-bound repair advances preparation exactly once and exposes the
  exact apply command;
- apply writes the existing verified receipt, advances semantic progress once,
  and replay advances zero; and
- source apply receipts, matrix/authority protocols, Lease behavior, O1, and
  ordinary legal-task non-activation remain unchanged.

## Verification Gate

1. Run the focused Legal Coverage, real-Gateway, Progress Lease, Agent runtime,
   and O1 suites.
2. Replay the exact preserved V24R9 Case 09 source failure in a disposable
   workspace and prove validator-derived repair template, valid-only
   preparation, exact apply, verified receipt, and one semantic renewal.
3. Run the complete repository suite and patch hygiene checks.
4. Record reviewer-readable QA evidence on disk, commit, push, and open a
   stacked PR on V24R9.
5. Assemble a new immutable campaign and repeat Gate 0, paired smoke, Case 05,
   and the complete Case 09 product gate. V25 and the 85-case campaign remain
   blocked until Case 09 completes with validator success and a non-skeleton
   report.
