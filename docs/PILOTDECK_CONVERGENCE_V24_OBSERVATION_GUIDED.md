# PilotDeck Convergence V24: Observation-Guided Contracts

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260726-convergence-v24-observation-guided`
- Branch: `codex/convergence-v24-observation-guided`
- Base: Observation Foundation O1 commit `3e6e9ca5`
- O1 remains shadow-only, hash-only, and disabled by default.

V24 is a product candidate, not an O1 calibration change. It must be evaluated
in a new campaign. The closed O1 v3 campaign is evidence, not a reusable run
directory.

## Problem Statement

The calibrated Case 09 run exposed two independent generic failures:

1. Full compaction with no summarizable prefix was reported as
   `summary_failed`, although no summary model request was attempted.
2. Progress Lease renewed on any opaque `stateHash` change, including changes
   that left phase and blocker unchanged while remaining work increased.

Renaming the first failure is necessary for diagnosis but does not reduce
context. V24 also bounds verbatim retention of old protected tool turns.

## Ownership Boundary

PilotDeck Core owns:

- compaction planning and stable outcome codes;
- tool call/result integrity;
- generic comparison of a domain-issued monotonic progress ordinal;
- fail-closed lease behavior and observation events.

The Legal Plugin owns:

- legal phases, ledgers, work batches, and validator semantics;
- filtering raw validator state into a legal milestone digest;
- issuing a session-scoped monotonic `progressOrdinal` only for a new legal
  milestone;
- legal completion proof.

The Runner owns:

- isolated deployments and frozen settings;
- machine deadlines and artifact preservation;
- O1 Bundle verification and A/B metadata.

V24 does not change the legal validator, evaluation materials, expected
answers, Router/Memory settings, or the frozen Progress Lease limits.

## Compaction Contract

`CompactionEngine` returns exactly one outcome:

- `summarized`: a summary model request completed and produced a summary;
- `no_summarizable_messages`: planning left no prefix to summarize, so no
  summary model request was made;
- `summary_failed`: a summary request was attempted and failed.

`DefaultContextRuntime` propagates `summaryAttempted`, `summarySucceeded`, and
a stable rejection reason. `no_summarizable_messages` must never appear as
`summary_failed`.

The normal 35% tail remains verbatim. Outside that tail, full compaction keeps
at most the newest eight protected turns verbatim. Older `agent`, `Task`, and
other protected turns are summarized. The ratio-derived tail boundary is moved
to a complete turn boundary. Every tool call on both the summarized and
retained sides must still have exactly one matching result.

The bound is a generic context invariant. It does not inspect legal content or
special-case Case 09.

## Progress Lease Contract

The convergence metadata remains schema version 1 and adds an optional field:

```json
{
  "schemaVersion": 1,
  "scope": "legal-coverage",
  "phase": "sources",
  "stateHash": "opaque identity hash",
  "blockingCode": "source_pending",
  "remainingCount": 121,
  "progressOrdinal": 4
}
```

Core renews a lease only when:

- `remainingCount` is smaller than the stored count; or
- `progressOrdinal` is present and strictly larger than the stored ordinal.

`stateHash` changes, equal ordinals, stale ordinals, and replayed ordinals do
not renew the lease. A lower remaining count also cannot roll the stored
ordinal backward.

The Legal Plugin derives its ordinal from `milestoneDigest`, not raw validator
`stateHash`. A new digest advances the ordinal only when the ordered legal
phase does not regress and remaining work does not increase. It persists the
last observation, ordinal, and a bounded set of seen milestone digests in the
session state. Repeated invalid revisions, error-count growth, and replayed
milestones cannot manufacture progress. A later user prompt in the same
session preserves this state.

## Required Verification

Before commit:

1. Build succeeds.
2. Focused tests prove the three compaction outcomes and stable propagation.
3. A sanitized many-`agent` fixture proves old protected turns become
   summarizable and retained tool pairs remain exact.
4. Progress tests prove hash churn, equal ordinal, replay, and rollback do not
   renew; smaller remaining count and larger ordinal do renew.
5. Legal Plugin tests prove invalid revision churn does not advance the ordinal
   and genuine bounded workflow progress does.
6. Full repository tests pass.
7. Reviewer-readable evidence is written under `.omo/evidence/` without
   prompts, tool bodies, legal materials, credentials, or chain-of-thought.

## Live Gate

Use a new isolated campaign with Router and Memory disabled:

1. baseline smoke;
2. candidate smoke;
3. candidate Case 05 to check non-legal isolation;
4. candidate Case 09.

V24 is supported only if Case 09 shows all of the following:

- O1 Bundle remains complete and comparable;
- no false `summary_failed` classification;
- every lease renewal has a smaller remaining count or larger ordinal;
- accepted full compaction occurs when an old protected prefix exists;
- no tool-pair, lifecycle, secret-scan, or plaintext-scan regression;
- phase, remaining work, or bounded completion materially improves relative to
  the calibrated O1 candidate.

If observability improves but product behavior does not, V24 is diagnostic only
and must not justify V25. If the small Gate passes, V25 may address the next
observed bottleneck. The complete 85-case A/B run begins only after product
Gates are stable.
