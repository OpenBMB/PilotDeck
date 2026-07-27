# PilotDeck Convergence V24R9: Durable Ordinary Source Apply Receipt

## Decision

V24R9 fixes one Legal Coverage observation gap found by the V24R8 Case 09
product run. It does not change Agent Core, O1, validator acceptance, issue
taxonomy, Progress Lease thresholds `8/2`, Router, Memory, the model, the
evaluation corpus, immutable source repair, matrix handoffs, or authority
closure.

V24R8 correctly crossed the rejected-proposal repair boundary and renewed
progress from its verified repair receipt. The next ordinary source proposal
also applied successfully, changing four source rows and adding 23 facts. That
ordinary transaction had no durable applied identity. On the next hook call,
Legal Coverage had already moved to the following source batch, so the former
apply-ready work item was gone and the Lease correctly failed closed.

## Protocol

Every successful ordinary `source-merge-apply` now writes one deterministic
receipt next to its immutable proposal:

```text
.pilotdeck/work/legal-coverage/fragments/source-merge-applied-<digest>.json
```

The receipt records:

- the previous canonical state hash;
- the resulting canonical state hash;
- the immutable proposal path and SHA-256;
- the ordered IDs of the sources applied by the transaction.

The receipt is written only after the existing source and fact ledgers have
been projected and the unchanged workspace validator has computed the
resulting state. If receipt persistence fails, the canonical source and fact
ledgers are rolled back.

On a later hook call, Legal Coverage accepts the receipt only when all of the
following remain true:

- its schema and checkpoint type are exact;
- its resulting state hash equals the current validator state;
- its previous state hash equals the proposal's immutable expected state;
- its filename digest and proposal path agree;
- the current proposal bytes still match the recorded SHA-256;
- its source IDs exactly match the proposal source IDs;
- every recorded source exists in the current ledger and has the exact
  `reviewed` status;
- record count, receipt size, traversal, and symlink protections pass.

Malformed, stale, tampered, replayed, out-of-scope, or inaccessible receipts do
not create progress.

## Lease Semantics

The ordinary apply-ready state is preparation, not semantic progress, and is
therefore no longer a progress checkpoint. Only the verified durable receipt
creates one `source-fragment-applied` checkpoint.

The hook's existing session state deduplicates that checkpoint digest, so one
canonical transaction advances `progressOrdinal` exactly once. A repeated
hook call with the same receipt does not advance it again. No grace kind,
threshold, error-count heuristic, or raw state-hash heuristic is added.

Core remains domain-neutral. It receives only the opaque ordinal and digest;
proposal fields, source IDs, ledger status, receipt validation, and legal state
hashes remain inside Legal Coverage.

## Counterexamples

Verification must prove that:

- apply readiness alone does not advance progress;
- a successful ordinary apply persists the deterministic receipt;
- a changed proposal hash makes the receipt invalid;
- a receipt for a non-current state makes the receipt invalid;
- pending, missing, duplicate, extra, or mismatched source IDs are rejected;
- an unknown source status is rejected even if a receipt claims the resulting
  current state hash;
- a tampered receipt does not advance progress;
- the valid current receipt advances progress once;
- replay of the same receipt does not advance progress;
- immutable source repair behavior is unchanged;
- traversal and symlink restrictions remain enforced by the existing safe-path
  layer.

## Verification Gate

1. Run syntax checks, patch hygiene, and the focused 41 Legal Coverage plus
   four real-Gateway tests.
2. Run the complete repository suite.
3. Reconstruct the exact preserved V24R8 Case 09 state immediately before the
   ordinary apply. Execute the real Legal Coverage CLI and hook and prove
   `apply-ready -> durable receipt -> progress +1 -> replay +0` with the same
   four sources, 23 facts, and state hashes observed in the failed campaign.
4. Commit and push the bounded Legal Coverage change as a stacked PR targeting
   V24R8.
5. Create a new immutable campaign. Run Gate 0, paired smoke, Case 05, and then
   the complete Case 09 product Gate. Do not authorize V25 or the 85-case
   campaign unless Case 09 completes and passes its product validation.
