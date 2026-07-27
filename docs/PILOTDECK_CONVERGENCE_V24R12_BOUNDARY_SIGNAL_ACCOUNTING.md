# PilotDeck Convergence V24R12: Boundary Signal Accounting

## Decision

V24R12 fixes one domain-neutral Progress Lease accounting defect exposed by the
V24R11 Case 09 product gate. It changes only how Core records opaque domain
signals that are delivered by an already-authorized boundary request. It does
not change Legal Coverage, validator acceptance, Lease thresholds `8/2`,
Router, Memory, the model, Skills, corpus, deadlines, transactions, receipts,
or completion authority.

AgentLoop applies a required full context boundary before `PreModelRequest`.
The lifecycle hook then derives the current domain context and convergence
ordinals, and Progress Lease evaluates them immediately before sending that
same request to the model. Therefore, when a new `repairOrdinal` appears in an
observation whose boundary was applied, the `boundary_grace` request really
does deliver that repair feedback.

The old state transition stored the new repair ordinal but reset
`feedbackGraceUsed` to false. If the Agent used the boundary request to write a
valid repair target, the following observation contained a new
`repairPreparationOrdinal`; Lease rejected it because its state incorrectly
said no feedback turn had been delivered.

## Protocol

An applied boundary remains exactly one model request. Core continues to store
all opaque ordinals visible in that observation because the request receives
the complete current domain context. In addition, the transition records which
repair stages that request delivered:

- a strictly newer `repairOrdinal` marks repair feedback as delivered;
- a strictly newer `repairPreparationOrdinal` marks repair preparation as
  delivered; and
- absent or replayed ordinals do not set either marker.

This is accounting, not another grace. A boundary observation with new repair
feedback but no new preparation permits the later, strictly newer preparation
to receive the existing one `repair_preparation_grace`. If repair feedback and
preparation are both already present in the boundary observation, both are
accounted for by that one request and replay still fails closed.

## Boundaries

- No new decision type, retry, lease threshold, or model request is added.
- The boundary request and existing repair-preparation request remain the only
  turns in the affected path.
- A second repair revision cannot replace missing semantic progress.
- Replayed, rolled-back, absent, or malformed ordinals earn no allowance.
- Handoff limits remain per-progress-epoch and unchanged.
- Core compares opaque monotonic numbers only. It does not know repair files,
  legal facts, validators, or apply commands.
- If the required boundary is unavailable or rejected, evaluation still fails
  closed before any domain signal can bypass it.

## Counterexamples

Tests must prove that:

- the sanitized Case 09 sequence
  `stagnant -> boundary + new feedback -> new preparation -> progress` produces
  `stagnant -> boundary_grace -> repair_preparation_grace -> renewed`;
- feedback and preparation already co-delivered by one boundary cannot be
  replayed for another grace;
- a boundary without a new repair signal still permits exactly one
  post-boundary request and then fails closed;
- feedback delivered after a boundary retains the existing behavior;
- second repair revisions, simultaneous handoff/repair replay, unavailable
  boundaries, and handoff budget limits still fail closed as before; and
- parsing, O1 events, Legal Coverage contracts, and ordinary non-legal tasks
  remain unchanged.

## Verification Gate

1. Record the focused Lease counterexample failing on the V24R11 base.
2. Apply the smallest Core state-accounting change and rerun all Lease and
   Agent runtime control tests.
3. Replay the preserved V24R11 terminal trajectory through Core and project the
   blocked legal repair in a disposable workspace.
4. Run focused Legal Coverage/Gateway/O1 suites and the complete repository
   suite, then record reviewer-readable QA evidence.
5. Push a stacked draft PR on V24R11. Create a fresh immutable campaign and run
   Gate 0, paired smoke, Case 05, and full Case 09. V25 and the 85-case campaign
   remain blocked until the new Case 09 completes with a substantive report and
   completion proof.
