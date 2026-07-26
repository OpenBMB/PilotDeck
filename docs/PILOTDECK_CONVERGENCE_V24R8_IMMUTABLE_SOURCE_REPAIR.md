# PilotDeck Convergence V24R8: Immutable Source Repair Transaction

## Decision

V24R8 addresses only the preserved Case 09 failure in the bounded source
proposal repair path. It adds an immutable Legal Coverage repair transaction;
it does not change Agent Core, O1, validator acceptance, issue rules, Progress
Lease thresholds `8/2`, V24R7 authority closure, Router, Memory, the model, or
the evaluation corpus.

The V24R7 Gate v2 run `20260727_064631_2982fc7f` reached a rejected second
source proposal. Two facts had neither a usable `dateOrPeriod` nor a
`missingTimeReason`. The Agent correctly read and edited the existing proposal,
but those two preparation turns exhausted the bounded lease before canonical
apply. This is a protocol mismatch: PilotDeck requires reading an existing file
before mutation, while the repair prompt asks for an in-place rewrite.

## Protocol

When a source proposal has complete fact-level diagnostics and a bounded repair
slice, Legal Coverage derives one fresh path:

```text
.pilotdeck/work/legal-coverage/fragments/source-repair-<digest>.json
```

The digest binds the repair to the current validator state, original proposal
path and SHA-256, ordered source IDs, and the complete diagnostic identity. The
injected repair contract contains only rejected fact rows, validated source
context, and a bounded template. It does not ask the Agent to read or overwrite
the original proposal.

The Agent writes one immutable transaction containing exactly one operation for
every rejected fact: replace the full rejected fact or remove it with a specific
reason. The plugin rejects missing or extra operations, duplicate fact numbers,
unrelated-fact changes, placeholders, stale state, changed original proposals,
invalid locators, broken source disposition, byte overflow, traversal, symlink
ancestors, changed repair receipts, and replay.

On the next model request, the plugin combines the transaction with the
unchanged original proposal in memory and runs the unchanged full source
proposal validator. A valid receipt exposes only the exact
`sourceMergeRepairApplyCommand`; it does not expose the complete corrected
proposal or mutate canonical ledgers.

The CLI revalidates state, original proposal, repair transaction, fragment
receipt, and normalized result, then atomically projects the corrected source
transaction into `sources.json` and `facts.json`. It writes a compact applied
receipt bound to the resulting canonical state. The hook accepts that receipt
only while it matches the current validator state and reviewed source rows.

## Lease Semantics

- The initial invalid proposal increments the existing `repairOrdinal` once.
- A successful `write_file` to the fresh repair path increments the existing
  `repairPreparationOrdinal` once.
- Reading the original proposal, writing another path, replaying the same
  repair, invalid repair content, repair validation, and the apply command do
  not increment `progressOrdinal`.
- Only the applied receipt, after verification against the resulting canonical
  source/fact state, creates one semantic progress checkpoint.
- No additional grace kind or threshold is introduced.

Core remains domain-neutral. It continues to compare only opaque ordinals,
counts, and hashes; every source field, locator, diagnostic, transaction, and
receipt rule remains inside Legal Coverage.

## Bounds

- At most 32 rejected fact operations.
- At most 24 KiB per repair transaction.
- One deterministic repair path and one applied receipt per stable rejection.
- Existing valid facts and `noMaterialFacts` rows are preserved byte-for-value
  in the reconstructed proposal.
- The unchanged full proposal and post-write workspace validators remain the
  final acceptance authority.

## Counterexamples

Tests must prove that no canonical mutation occurs for an unknown fact number,
missing rejected fact, duplicate operation, extra valid-fact operation,
placeholder replacement, invalid locator, unsupported action, missing removal
reason, changed original proposal, changed repair file, stale state, replay,
overflow, traversal, or symlink path.

Tests must also prove that wrong-path reads/writes and repeated writes do not
advance repair preparation; a valid repair receipt does not advance semantic
progress; atomic apply changes only the selected source/fact transaction; the
current applied receipt advances progress once; and its replay does not.

## Verification Gate

1. Build and run focused Legal Coverage, hook runtime, Progress Lease, Gateway,
   compaction, and O1 tests.
2. Run the complete repository suite.
3. Drive a real isolated local Gateway with a mock model and real tools,
   Router/Memory disabled, O1 diagnostic/4096, and evidence on disk.
4. Replay the preserved v2 Case 09 source failure in a disposable workspace and
   prove `feedback_grace -> repair_preparation_grace -> atomic apply -> genuine
   renewed progress` without reading or editing the original proposal.
5. Commit and push, assemble dependencies, and create a new immutable campaign.
   Run paired smoke, Case 05, then Case 09. V25 and 85 cases remain blocked
   until the complete Case 09 product Gate passes.
