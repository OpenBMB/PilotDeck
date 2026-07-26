# PilotDeck Convergence V24R5: Bounded Repair Slice

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260727-fix-convergence-v24r5-bounded-repair-slice-v1`
- Branch: `codex/convergence-v24r5-bounded-repair-slice`
- Frozen base: V24R4 `f22546efb671c5a43cbc415545d2223dcdf4cc15`
- V24R5 is a Legal Plugin repair-executability candidate, not V25.
- Core, O1, Progress Lease `8/2`, validator acceptance rules, model, Skills,
  Router/Memory controls, and the corpus remain frozen.

## Live Evidence And Failure

The closed V24R4 campaign proved that complete same-fact diagnostics fixed the
original Case 09 repair. The Agent renewed after feedback and advanced from zero
reviewed sources and facts to 16 reviewed sources and 71 accepted facts.

A later 349-line proposal failed on one fact:

```text
source_merge_fact_locator_unverified:
Proposal fact 11 locator is not present in the validated fragment row for
SRC-0E7EE6AA1384.
```

The Agent received one feedback grace and one target-bound preparation grace,
but two paginated reads still did not expose the complete fact object. It never
rewrote the proposal and Core correctly failed closed. Removing only fact 11 in
a disposable copy made the real V24R4 apply succeed atomically with 4 sources
and 15 facts. There was no hidden second validator failure.

## Decision

Do not add another generic read or stagnation allowance. Make the existing one
bounded repair opportunity executable by attaching a Legal Plugin-owned
`repairSlice` to rejected source-merge proposal feedback.

The slice contains:

- the complete parsed proposal, already limited by the proposal's 24 KiB cap;
- the proposal path, SHA-256, byte count, and configured byte limit;
- structured diagnostics, with `factNumber` when a diagnostic belongs to a
  proposal fact;
- exact rejected fact objects selected by those fact numbers;
- allowed fragment locators and conflict/unresolved context for sources
  referenced by rejected facts.

The next action tells the Agent to rewrite
`workItems.proposal.repairSlice.currentProposal` as one complete JSON document.
For an unsupported locator, it must either use an exact supported locator when
the validated source facts support the assertion, or remove a fact that merely
restates conflict/unresolved metadata already preserved on the source ledger.
It must not reconstruct the proposal through paginated reads.

## Ownership Boundary

The repair slice belongs to Legal Coverage because it understands proposal
facts, source references, locators, conflicts, and source-ledger projection.
Core remains domain-neutral and receives the same opaque progress, repair, and
preparation ordinals as before.

No legal field, locator rule, proposal content, or source conflict semantics may
move into Progress Lease, O1, or another generic Harness module.

## Stability And Bounds

- Direct `source-merge-apply` remains fail-fast.
- `validateSourceMergeProposal()` acceptance semantics do not change.
- The complete current proposal remains within the existing 24 KiB limit.
- Repair source context is derived only from already validated fragment rows.
- Rejected fact ordering and source-context ordering are deterministic.
- `validationError`, `validationDiagnostics`, and `repairSlice` are excluded
  from `convergenceWorkProjection()` so invalid rewrites cannot manufacture
  progress or additional repair leases.
- The proposal path and original readiness checkpoint continue to identify the
  stable repair target.

## Counterexamples

Tests must prove:

- an invented locator exposes its `factNumber`, exact rejected fact, and the
  validated source's allowed locators;
- the complete current proposal, SHA-256, and byte count are present and match
  the on-disk rejected proposal;
- unrelated valid facts remain unchanged in `currentProposal`;
- conflict and unresolved source metadata are available for the omit-versus-
  replace decision;
- invalid revisions with different proposal contents keep the same convergence
  state hash and repair ordinal;
- direct apply remains fail-fast and valid apply remains atomic;
- no Core, O1, or Progress Lease source changes are required.

## Verification Gate

Run build, the focused Legal Coverage suite, the full suite, and a real isolated
Gateway integration. Then replay the preserved Case 09 V24R4 failure in a
disposable copy and prove the repair slice contains everything needed for the
single local edit and successful atomic apply.

After commit and push, create a new immutable campaign comparing frozen V24R4
with V24R5. Run paired smoke, candidate Case 05, and candidate Case 09. Only a
complete Case 09 product Gate authorizes discussion of V25 or the 85-case run.
