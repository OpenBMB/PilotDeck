# PilotDeck Convergence V24R2: One-Shot Repair Feedback Grace

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260726-fix-convergence-v24r2-feedback-grace-v1`
- Branch: `codex/convergence-v24r2-feedback-grace`
- Frozen base: `36d3f015f1986b88a0d872909cf0f364c928d178`
- V24R2 is a repair candidate, not V25.
- Validator rules, model, Skills, Router/Memory controls, and lease limits `8/2`
  remain frozen.

## Evidence Basis

The closed V24R Case 09 run `20260726_232437_fd5bdaea` proved two repairs:

- O1 was complete with 41 tool starts and 41 terminals;
- full compaction applied and reduced context from 85,994 to 67,704 tokens.

It then failed after 281.518 seconds at
`sources/source_pending/remaining=33/progressOrdinal=1`. After the applied
boundary, the Agent wrote its first source merge proposal. The Legal Plugin
found five actionable validation errors, but Progress Lease failed closed at
the same PreModel boundary before those diagnostics could be delivered to the
next model request.

The invalid proposal was correctly not legal progress. The missing capability
was one delivery turn for newly surfaced feedback.

## Ownership Boundary

Core owns a domain-neutral feedback-delivery protocol:

- parse and compare a domain-issued monotonic `repairOrdinal`;
- grant one `feedback_grace` only after an applied boundary;
- keep the scope in post-boundary state and preserve the stagnation count;
- require genuine progress on the next observation.

The Legal Plugin owns:

- deciding when actionable legal repair feedback first exists;
- stable repair identity for a state-bound source or matrix transaction;
- ensuring rewrites and changing error sets do not issue another repair
  ordinal for the same target/state.

Core does not inspect legal phases, error codes, sources, matrices, or proposal
content.

## Metadata Contract

The optional `repairOrdinal` is separate from `progressOrdinal`:

```json
{
  "schemaVersion": 1,
  "scope": "legal-coverage",
  "phase": "sources",
  "stateHash": "opaque identity",
  "blockingCode": "source_pending",
  "remainingCount": 33,
  "progressOrdinal": 1,
  "repairOrdinal": 1
}
```

- `progressOrdinal` can renew the lease when it strictly increases.
- `repairOrdinal` never renews the lease and never resets stagnation.
- A smaller or equal repair ordinal has no effect.

## Core State Machine

`feedback_grace` is available only when all conditions hold:

1. the scope is waiting for progress after a successfully applied full
   boundary;
2. genuine progress has not occurred;
3. `repairOrdinal` is strictly greater than the stored value.

The grace permits the current model request so newly injected feedback can be
read. The state remains `awaitingPostBoundaryProgress=true`. At the next
observation:

- smaller remaining work or a larger progress ordinal returns `renewed`;
- the same/stale repair ordinal returns `fail_closed` with
  `post_boundary_stagnation`;
- a different invalid rewrite cannot create another grace unless the domain
  incorrectly issues a new repair ordinal.

If repair feedback appears before the boundary, the ordinary model request
already receives it. Core records the ordinal then, so it cannot be replayed
after the boundary.

## Legal Repair Identity

The Legal Plugin issues at most one repair revision for each stable target:

- source proposal: kind + expected state hash + bounded source IDs;
- matrix selection: kind + expected state hash + target matrix ID;
- matrix proposal: kind + expected state hash + target matrix ID.

Proposal text, error messages, error-code combinations, page offsets, and
diagnostic prose are excluded. The checkpoint is stored as a SHA-256 digest in
session state. A bounded set of seen repair digests and the monotonic repair
ordinal survive later user prompts and compaction hooks.

## Counterexamples

The implementation must prove:

- opaque hash churn does not renew progress;
- a first post-boundary repair revision gets one model request;
- replay gets no second request;
- genuine progress after feedback renews normally;
- feedback already delivered before the boundary cannot be replayed;
- source and matrix invalid rewrites keep one progress ordinal and one repair
  ordinal;
- a later user prompt preserves both states;
- O1 records `progress-lease/v3`, `repairOrdinal`, and `feedback_grace` without
  prompt or diagnostic bodies.

## Live Gate

After build, focused tests, full tests, evidence, commit, and push, create a new
immutable campaign. Never reuse the V24R campaign.

Run:

1. baseline smoke;
2. candidate smoke;
3. candidate Case 05;
4. candidate Case 09.

Case 09 must show the exact failed V24R sequence now behaves as follows:

```text
boundary_grace -> new repairOrdinal -> feedback_grace
feedback_grace -> valid transaction checkpoint -> renewed
```

If the repair remains invalid, fail-closed is correct and V24R2 fails the
product Gate. O1 must remain complete, compaction must remain applied/bounded,
and no invalid-revision churn may manufacture progress or feedback turns.

V25 and the full 85-case campaign remain blocked until this small live Gate
passes with bounded product improvement.
