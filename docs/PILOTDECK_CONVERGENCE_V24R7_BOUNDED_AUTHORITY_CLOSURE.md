# PilotDeck Convergence V24R7: Bounded Authority Closure

## Decision

V24R7 addresses only the preserved Case 09 transition from a completed
`legal-authority` matrix to reciprocal issue and authority links. It adds a
Legal Coverage plugin transaction; it does not change generic Agent Core,
Progress Lease policy, O1, the validator acceptance rules, Router, Memory,
deadlines, the model, or the evaluation corpus.

The V24R6 failure showed that bounded matrix selection and proposal handoffs
worked. The run reached `authorities`, then repeatedly read complete ledgers
whose `issues` and `authorities` arrays were empty. The generic next action did
not provide a writable joint issue-authority-matrix closure. V24R7 supplies
that missing domain transaction without treating reads, repair feedback, or a
validated proposal as semantic progress.

## Protocol

When the unchanged validator reports `legal_authority_links_missing` first,
the Legal Coverage hook selects exactly one empty-authority entry and injects:

- the target entry and at most 12 referenced facts;
- compact guidance for the existing six issue rules;
- existing target-linked issue and authority rows, if any;
- a deterministic proposal path bound to validator state, target entry, and
  prepared-slice SHA-256;
- a maximum of eight issue and authority upserts combined and 24 KiB of
  serialized proposal content.

The Agent writes one proposal. The plugin rejects placeholders, unknown facts,
unlinked extra upserts, non-reciprocal links, mutation of existing legal
reasoning, record or byte overflow, stale state, changed receipts, replay, path
escape, and symlink ancestors before any canonical write.

After validation, the hook removes the prepared facts, template, and normalized
transaction from model context. It exposes only a compact apply receipt and the
exact `authorityClosureApplyCommand`. The CLI revalidates the proposal and
state, then updates `issues.json`, `authorities.json`, and the one target matrix
entry as one logical transaction. Existing ledger order is preserved.

## Lease Semantics

A newly validated apply receipt increments only `handoffOrdinal`. Replaying the
same receipt does not increment it again. The proposal itself, invalid repair
revisions, reading a rejected proposal, and the apply command are not semantic
progress. Only the resulting validator phase advance or completion increments
`progressOrdinal` under the existing Core rules.

No legal phase, path, fact, issue, authority, validator code, or transaction
content is added to Core Progress Lease or O1. Core continues to observe only
opaque ordinals, counts, hashes, and decisions.

## Verification Gates

Before commit:

1. Build and run focused Legal Coverage, AgentLoop, Progress Lease, Gateway,
   compaction, and O1 tests.
2. Drive a real isolated local Gateway with a mock model and real `bash`, Router
   and Memory disabled, and O1 diagnostic/4096 enabled.
3. Replay the preserved V24R6 Case 09 workspace in a temporary copy and prove
   the target 12-fact slice is complete and bounded.
4. Run the full repository suite, boundary scan, JSON checks, and secret scan.

After push, create a fresh immutable campaign. Run paired smoke, Case 05, then
Case 09. Case 09 must produce a current completion proof, a substantive legal
deliverable, complete/comparable O1, zero recorder drops, preserved inputs, and
no unsupported authority or issue classification. V25 and the 85-case campaign
remain blocked until this product Gate passes.
