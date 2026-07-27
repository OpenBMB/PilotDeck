# PilotDeck Convergence V24R11: Ordinary Source Apply Handoff

## Decision

V24R11 closes one Legal Coverage protocol handoff gap observed in the V24R10
Case 09 product gate. It does not change Agent Core, O1, validator acceptance,
Progress Lease thresholds `8/2`, Router, Memory, the model, the corpus, source
apply transactions, durable receipts, repair behavior, matrix selection,
authority closure, or completion authority.

The failed run produced a valid, state-bound ordinary source proposal as its
final tool result. Legal Coverage exposed the exact `source-merge-apply`
command only on the next hook projection, but the Progress Lease evaluated the
same PostToolUse cycle before the Agent could receive that next model turn and
failed closed. The transaction was ready; the protocol did not acknowledge
the newly available handoff.

## Protocol

Legal Coverage adds one replay-safe handoff checkpoint when its derived work
item satisfies all of the following:

- `group` is exactly `source-fragment-apply`;
- the unchanged proposal validator marked the proposal `validated: true`;
- `expectedStateHash` and `proposalSha256` are valid SHA-256 identities; and
- `sourceIds` is a non-empty, bounded list containing only exact non-empty IDs.

The checkpoint identity is domain-owned and deterministic:

```text
kind=source-fragment-apply-ready
expectedStateHash=<validated canonical state>
proposalSha256=<immutable proposal identity>
sourceIds=<sorted exact source IDs>
```

A new identity advances the existing opaque `handoffOrdinal` exactly once.
Agent Core then applies its existing `handoff_grace`, allowing one model turn
to receive the already-generated exact apply command. Replaying the same
projection advances nothing.

## Boundaries

- No transaction is auto-applied. The Agent must execute the existing exact
  command explicitly.
- Apply readiness is not semantic progress. `progressOrdinal` still advances
  only from the verified durable V24R9 applied receipt.
- Invalid, stale, tampered, readiness-only, rejected, out-of-scope, or already
  applied proposals do not create a handoff checkpoint.
- No new Lease decision, threshold, retry loop, deadline, or special-case
  prompt is introduced.
- Core receives only the existing opaque ordinal and hashes. Legal proposal
  fields and validation remain inside Legal Coverage.

## Counterexamples

Tests must prove that:

- an invalid ordinary proposal does not advance `handoffOrdinal` or expose an
  apply command;
- a valid state-bound proposal exposes the exact apply command and advances
  handoff exactly once;
- replay of the apply-ready state advances neither handoff nor progress;
- stale, tampered, unknown-ID, or rejected proposal state does not advance;
- a successful apply writes the existing durable receipt and advances
  semantic progress exactly once;
- applied-state replay advances neither ordinal; and
- repair, matrix, authority, Core Lease, O1, and ordinary non-legal activation
  behavior remain unchanged.

## Verification Gate

1. Run the focused Legal Coverage, real-Gateway, Progress Lease, Agent runtime,
   and O1 suites.
2. Replay the preserved V24R10 Case 09 final source state in a disposable
   workspace and prove `valid proposal -> handoff once -> exact apply -> durable
   receipt -> semantic progress once`.
3. Run the complete repository suite and patch hygiene checks.
4. Record reviewer-readable QA evidence, commit, push, and open a stacked draft
   PR on V24R10.
5. Create a fresh immutable campaign and run Gate 0, paired smoke, Case 05, and
   Case 09. V25 and the 85-case campaign remain blocked until Case 09 passes.
