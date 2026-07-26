# PilotDeck Convergence V24R4: Complete Repair Diagnostics

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260727-fix-convergence-v24r4-complete-repair-diagnostics-v1`
- Branch: `codex/convergence-v24r4-complete-repair-diagnostics`
- Frozen base: V24R3 `f3b8245716134ab8f67c6fc6ff2b9c94d296fe3b`
- V24R4 is a Legal Plugin feedback-completeness candidate, not V25.
- Core, O1, Progress Lease `8/2`, validator acceptance rules, model, Skills,
  Router/Memory controls, and the corpus remain frozen.

## Live Evidence

Closed campaign
`20260727-convergence-v24r3-bounded-repair-preparation-gate-v2` proved the
V24R3 mechanism:

```text
boundary_grace
-> feedback_grace
-> successful exact-target read
-> repair_preparation_grace
-> successful proposal rewrite
-> fail_closed
```

The rewrite corrected all nine surfaced time diagnostics. A non-mutating apply
check then exposed a previously hidden error on the same fact:

```text
source_merge_threshold_invalid: Proposal fact 5 has an invalid thresholdAssessment.
```

The validator already aggregates errors across facts, but each fact is wrapped
in one fail-fast `try/catch`. Fact 5's time error therefore hid its independent
threshold error until the next model request. Core correctly refused a second
unbounded repair cycle.

## Decision

Do not increase Core stagnation, feedback, or preparation allowances. Make the
Legal Plugin's repair contract complete enough for the existing bounded repair
cycle:

- collect every independent local field-contract error for each source proposal
  fact in deterministic validation order;
- keep cross-record and source-dependent checks behind their prerequisites;
- preserve the existing global diagnostic cap and `total/returned/hasMore`
  envelope;
- give the model the exact `thresholdAssessment` JSON field names and allowed
  operator values;
- keep the acceptance validator fail-fast for direct apply calls.

## Ownership Boundary

This change belongs entirely to Legal Coverage because it understands facts,
time fields, thresholds, source references, and proposal shapes. Core remains
domain-neutral and sees only opaque monotonic ordinals and remaining counts.

No legal field name, error code, proposal path, or threshold rule may move into
Progress Lease or another generic Harness module.

## Diagnostic Contract

When `collectFactDiagnostics` is enabled, one fact may emit multiple independent
diagnostics, for example:

```json
{
  "validationDiagnostics": {
    "total": 2,
    "returned": 2,
    "hasMore": false,
    "items": [
      { "code": "source_merge_fact_time_invalid", "message": "..." },
      { "code": "source_merge_threshold_invalid", "message": "..." }
    ]
  }
}
```

The diagnostics are bounded by the existing cap and ordered by fact index, then
field validation order. A malformed prerequisite must not cause speculative
dependent errors. Direct `source-merge-apply` retains its current fail-fast
behavior and acceptance semantics.

The prompt contract is explicit:

```json
{
  "operator": "gt",
  "actual": 55200000,
  "threshold": 50000000,
  "unit": "人民币元",
  "breached": true
}
```

Allowed operators are `gt`, `gte`, `lt`, `lte`, and `eq`. Use `null` unless the
source supports a numeric threshold comparison.

## Counterexamples

Tests must prove:

- one fact with invalid time and threshold contracts returns both diagnostics in
  one PreModelRequest envelope;
- diagnostic order is stable and bounded;
- unsupported or non-object facts do not produce unsafe dependent diagnostics;
- direct apply remains fail-fast and rejects the same invalid proposal;
- valid proposals still advance to `source-fragment-apply` and apply atomically;
- exact threshold guidance appears in both proposal creation and repair prompts;
- no Core, O1, or Progress Lease source changes are required.

## Verification Gate

Run focused Legal Coverage tests, the full suite, and build. Record sanitized QA
under `.omo/evidence/`. Then run a real isolated Gateway smoke proving the
candidate plugin activates and emits the complete diagnostic envelope without
touching the user's PilotDeck home.

Only after commit and push may a fresh immutable campaign compare V24R3 baseline
with V24R4 candidate through paired smoke, Case 05, and Case 09. V25 and the
85-case campaign remain unauthorized until the full small Gate passes.
