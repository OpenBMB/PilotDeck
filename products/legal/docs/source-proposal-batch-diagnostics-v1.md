# Source Proposal Batch Diagnostics v1

Status: implementation experiment derived from the v21 fresh Case 09 run.

## Problem

The v21 state handoff worked: the Agent received the verified prepared slice,
wrote three source-merge proposals, and successfully applied the first two.
The third proposal entered a validator repair loop. Proposal validation stopped
at the first invalid fact, so each model request exposed only one error even
when later rows had independent errors. The steady-state Core lease correctly
allowed one repair revision and then failed closed because canonical state had
not advanced.

The preserved final proposal still had three independent errors: two evidence
class mismatches and one locator absent from its validated source row. A
fail-fast receipt could reveal only the first.

## Decision

The Legal Plugin proposal receipt now validates every fact row and returns the
first actionable error from each invalid row in one bounded diagnostic set.
The response contains total, returned, hasMore, and at most 36 code/message
items: the complete contract maximum of 32 fact rows plus four no-material
rows. The next action points to that structured list instead of duplicating it,
and tells the Agent to fix every listed diagnostic in one rewrite using the
existing `preparedSlice` and proposal template.

Basic proposal-envelope failures remain fail-fast because later row checks are
not meaningful without a valid transaction identity, source scope, and array
shape. The atomic apply path also remains fail-fast and reruns the strict
validator before any canonical write.

All invalid proposal revisions continue to project to one stable repair marker
for the Core lease. Changing invalid bytes or changing the diagnostic list does
not manufacture progress.

## Boundaries

This experiment does not change:

- Core AgentLoop, compaction, or cold-start 8 / steady-state 2 lease;
- Legal fact semantics, materiality, evidence classes, or locator rules;
- worker ownership, readiness receipts, or prepared-slice SHA binding;
- proposal and transaction limits (four sources / 24 KiB);
- canonical source/fact schemas or SHA-bound atomic apply;
- matrix relation-closure, issue, authority, coverage, or deliverable rules;
- prompts with benchmark IDs, expected answers, or Case 09 literals.

The plugin reports existing contract violations. It does not repair the
proposal, choose legal classifications, or write canonical facts.

## Verification Gates

1. A proposal with errors in different fact rows returns both diagnostics in
   one hook envelope.
2. The maximum invalid proposal returns all 36 row diagnostics and marks
   `hasMore=false`.
3. Different invalid revisions retain the same opaque convergence repair hash.
4. Valid proposals still advance to the unchanged apply command.
5. A v21 failed-snapshot replay exposes all remaining final-proposal errors
   without changing sources, facts, or proposal bytes.
6. Legal Plugin and complete PilotDeck tests pass before a fresh v22 campaign.
