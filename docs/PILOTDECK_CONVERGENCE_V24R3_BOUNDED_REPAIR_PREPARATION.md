# PilotDeck Convergence V24R3: Bounded Repair Preparation

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260727-fix-convergence-v24r3-bounded-repair-preparation-v1`
- Branch: `codex/convergence-v24r3-bounded-repair-preparation`
- Frozen base: V24R2 `b04fbf3ca5da804c7993c9e5af391f554583cf0b`
- V24R3 is a bounded repair candidate, not V25.
- Validator rules, model, Skills, Router/Memory controls, and lease limits `8/2`
  remain frozen.

## Live Evidence

The closed V24R2 Case 09 run `20260726_235311_bd99cceb` proved that one-shot
feedback delivery works:

```text
boundary_grace -> repairOrdinal 1 -> feedback_grace
feedback_grace -> accepted source transaction -> progressOrdinal 2 -> renewed
```

A later source proposal failed because 11 facts had neither `dateOrPeriod` nor
a valid `missingTimeReason`. The second feedback reached the model, but the
model first read the existing proposal before editing it:

```text
boundary_grace -> repairOrdinal 2 -> feedback_grace
feedback_grace -> read current proposal -> fail_closed
```

The read was a legitimate prerequisite because PilotDeck's file safety model
requires an existing file to be read before it can be edited or overwritten.
It was still not legal progress and must never renew the lease.

## Ownership Boundary

Core owns a domain-neutral preparation protocol:

- parse and compare a domain-issued monotonic `repairPreparationOrdinal`;
- after `feedback_grace`, grant one `repair_preparation_grace` only when that
  ordinal strictly increases;
- never count preparation as progress or reset stagnation;
- require genuine progress at the immediately following observation.

The Legal Plugin owns domain meaning:

- identify the rejected state-bound proposal as the current repair target;
- record a preparation revision only after successful `read_file` of that exact
  target;
- issue at most one preparation revision for each stable repair identity;
- reject wrong paths, failed reads, and repeat reads as preparation.

Core does not inspect legal phases, proposal paths, tool names, facts, sources,
matrices, error codes, or validation text.

## Metadata Contract

```json
{
  "schemaVersion": 1,
  "scope": "legal-coverage",
  "remainingCount": 74,
  "progressOrdinal": 2,
  "repairOrdinal": 2,
  "repairPreparationOrdinal": 1
}
```

- `progressOrdinal` may renew the lease.
- `repairOrdinal` may deliver one newly surfaced feedback request.
- `repairPreparationOrdinal` may permit one target preparation request after
  that feedback.
- Neither repair ordinal may reset stagnation or count as completion.

## State Machine

The only successful two-step repair path is:

```text
boundary_grace
  -> strictly newer repairOrdinal
  -> feedback_grace
  -> strictly newer repairPreparationOrdinal
  -> repair_preparation_grace
  -> strictly newer progressOrdinal or smaller remainingCount
  -> renewed
```

Fail closed when any of these occurs:

- no preparation revision after feedback;
- the same preparation revision is replayed;
- a second preparation revision appears for the same repair;
- no genuine progress follows preparation grace;
- a preparation revision appears before feedback delivery and is replayed;
- the full boundary is unavailable or rejected.

## Legal Preparation Identity

For a rejected source or matrix proposal, the plugin stores a target containing:

- stable repair digest;
- workspace-relative proposal path;
- expected state hash and bounded source IDs or matrix ID, already represented
  by the repair digest.

On successful `PostToolUse(read_file)`, the plugin safely resolves the supplied
path and compares it with the stored proposal path. A match records a digest of
the stable repair identity and increments `repairPreparationOrdinal` once.
Changing offsets or limits and reading the same proposal again does not create a
new revision.

## Counterexamples

Tests must prove:

- unrelated or failed reads do not grant preparation grace;
- repeated reads of the target do not grant another request;
- a target read before feedback cannot be replayed after the boundary;
- preparation does not lower remaining work or increase progress;
- genuine progress after preparation renews normally;
- a no-op after preparation fails closed;
- source and matrix targets are identified without Core knowing their shape;
- later prompts and compaction preserve bounded ordinals and checkpoint sets;
- O1 records policy `progress-lease/v4`, both repair ordinals, and the new
  decision without paths or diagnostic bodies.

## Live Gate

After build, focused/full tests, evidence, commit, and push, create a new
immutable campaign. Run paired smoke, candidate Case 05, then candidate Case 09.
Case 09 must pass the validator and preserve complete O1. V25 and the 85-case
campaign remain blocked until the entire small Gate passes.
