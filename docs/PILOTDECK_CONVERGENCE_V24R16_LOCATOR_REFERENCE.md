# PilotDeck V24R16: preview evidence and locator references

## Decision

V24R15's frozen Case 09 run stopped after 731 seconds with
`post_boundary_stagnation`. O1 recorded no `progress-boundary/v1` deferral. The
last legal proposal failed twice with `source_merge_fact_locator_unverified`.
The run therefore did not demonstrate that post-tool preview was ineffective;
it demonstrated that the trajectory never produced a progress or bounded
handoff preview at a required boundary.

V24R16 addresses the diagnostic gap and the domain transaction failure
separately:

- Core records a bounded `progress-boundary-preview/v1` decision for every
  scope that requires a boundary. It records only scope, `deferred|required`,
  and a fixed reason code. It does not change whether the boundary is forced.
- Legal Coverage exposes deterministic `locatorRef` values in the prepared
  source slice. A proposal may use either the legacy exact `locator` or the new
  `locatorRef`. The plugin resolves a ref against the receipt-bound fragment
  row and passes only the canonical `{sourceId, locator}` form to the existing
  source transaction and final validator.

## Core contract

`ProgressLease.planBoundary()` remains behaviorally identical. New preview
observations are:

| Decision | Reason | Meaning |
| --- | --- | --- |
| `deferred` | `preview_completed` | Preview is a valid completion report |
| `deferred` | `preview_progressed` | Remaining count or progress ordinal advances |
| `deferred` | `preview_handoff` | One in-budget operational handoff advances |
| `required` | `preview_missing` | No accepted PostToolUse preview exists |
| `required` | `preview_not_renewable` | Repair-only, replayed, or over-budget preview |
| `required` | `multiple_scopes` | More than one scope requires a boundary |

The event carries no state hash, next batch, file path, prompt, or domain
payload. O1 projects it under a separate `progress-boundary-preview/v1`
component so existing deferred-boundary counters remain unchanged.

## Legal contract

For a validated fragment fact `(sourceId, locator)`, the plugin derives:

```text
locatorRef = LR-hex(sha256(sourceId + "\\0" + locator))[0:16]
```

The reference is only an input-side convenience. It is bound to the existing
fragment receipt, source IDs, expected state hash, and prepared-slice hash.
Unknown or stale references fail closed with
`source_merge_fact_locator_ref_unverified`. Canonical facts, source rows,
receipts, state hashes, and final validator schemas remain unchanged.

The plugin still accepts exact legacy locators to preserve compatibility with
existing transactions and tests. V24R16's injected proposal template uses
`locatorRef`, so the model no longer needs to reproduce long or transformed
locator strings from context.

## Explicit non-goals

This change does not modify the validator, model, fixed prompt text, Router,
Memory, deadline, corpus, Case 09 text, Lease `8/2`, or the rule that repair-only
signals cannot defer a boundary. It does not add case-specific paths or infer a
legal fact from a locator reference.

## Verification gates

1. Focused Core, O1, Gateway, and Legal Coverage tests must pass.
2. The full PilotDeck suite must pass with no dropped or secret-bearing O1
   events.
3. A local Gateway trajectory must show both a deferred preview and a rejected
   repair-only preview, while final ledger output remains canonical.
4. A new immutable live campaign may run Gate 0, smoke, Case 05, and Case 09
   once. The previous V24R15 campaign remains frozen and is never reused.
