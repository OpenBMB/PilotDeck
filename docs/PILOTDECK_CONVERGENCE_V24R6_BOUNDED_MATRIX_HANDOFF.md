# PilotDeck Convergence V24R6: Bounded Matrix Handoff

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260727-fix-convergence-v24r6-bounded-matrix-handoff-v1`
- Branch: `codex/convergence-v24r6-bounded-matrix-handoff`
- Frozen base: candidate `a38dbf07148087e25d830300b212d73c98f7a8f1`
- V24R6 is a bounded operational-handoff candidate, not V25.
- Validator acceptance, seven matrices, completion proof, model, Skills,
  Router/Memory controls, and parent/child deadlines remain frozen.

## Live Failure

The closed Gate 2b Case 09 run reviewed all 24 sources and recorded 90 facts.
It then reached the first matrix, where the fact index required pagination. A
valid selection with `decision=continue` intentionally did not advance
`progressOrdinal`: reviewing another page is not legal completion progress.

The next deterministic action was already available as a validated,
state-bound `matrix-selection-apply` command. Core had no way to distinguish
that finite command handoff from arbitrary non-progress work. The final shape
was therefore:

```text
matrix progress -> stagnant -> boundary_grace -> no tool call -> fail_closed
```

The failure is not exhausted repair allowance, a permissive validator problem,
or a reason to increase the 2,100-second deadline.

## Decision

Add one optional domain-issued `handoffOrdinal` to the generic convergence
report and one Core decision, `handoff_grace`.

A handoff permits the next model request only when its ordinal strictly
increases. It never:

- decreases `remainingCount`;
- renews `progressOrdinal`;
- resets `stagnantObservations`;
- marks completion;
- bypasses an unavailable or rejected required boundary.

Core limits accepted handoff revisions in each genuine progress epoch to the
frozen `maxInitialStagnantObservations` value. In the Gate configuration that
is eight. A strictly newer `progressOrdinal` or smaller `remainingCount` resets
only this usage count; replay and hash churn do not.

## Ownership Boundary

Core owns only opaque protocol mechanics:

- parse a non-negative safe integer ordinal;
- compare it monotonically per scope;
- count handoffs since genuine progress;
- emit `handoff_grace` and O1/Gateway projections;
- preserve fail-closed boundary ordering.

Core does not know legal work, matrices, pages, selections, commands, paths,
facts, or validator codes.

Legal Coverage owns witness meaning. It issues a new ordinal at exactly two
stable matrix-pagination checkpoints:

1. a validated `continue` selection is ready for the deterministic apply
   command, bound to state hash, matrix ID, evidence batch, and selection hash;
2. the immutable continue receipt exposes the next evidence page, bound to
   state hash, matrix ID, page offset, next evidence batch, and selection path.

Invalid selections, changed files, the initial page, prompt replay, and repeated
hook execution do not issue a witness. Finalizing a selection remains genuine
progress under the existing contract and does not issue a handoff.

## State Machine

The intended successful paginated path is:

```text
renewed(progress=N)
  -> valid continue selection, handoff=H+1
  -> handoff_grace (stagnation retained)
  -> deterministic selection apply
  -> next page, handoff=H+2
  -> boundary_grace or handoff_grace (never both)
  -> finalized selection, progress=N+1
  -> renewed
```

If the Agent narrates instead of taking the required action, the same handoff
is replayed and the lease still fails closed. If a forced compaction is already
applied on the observation, `boundary_grace` takes precedence and the handoff
is only recorded and charged against its epoch limit; it does not create a
second request.

## Counterexamples

Tests must prove:

- equal and lower handoff ordinals grant nothing;
- a replay after boundary fails closed;
- handoff does not reset stagnation or semantic progress;
- the per-progress-epoch limit is hard and resets only on genuine progress;
- a new handoff cannot bypass an unavailable or rejected required boundary;
- simultaneous repair/handoff revisions cannot be redeemed on separate turns;
- invalid Legal Coverage selections do not advance handoff state;
- each valid apply-ready and next-page checkpoint advances exactly once;
- `UserPromptSubmit` and repeated `PreModelRequest` calls do not manufacture a
  witness;
- O1 records policy `progress-lease/v5`, the ordinal, and the decision without
  legal content, paths, or selection bodies.

## Verification Gate

Run type checking, focused Core/AgentLoop/O1/Legal Coverage tests, the full
suite, and isolated Gateway QA with evidence under `.omo/evidence/`. Then commit
and push the stacked branch and create a new immutable campaign.

The live order remains Gate 0 identity/isolation, Gate 1 paired smoke, Case 05,
then Case 09. Case 09 must produce validator success, a current completion
proof, and a non-skeleton legal report with complete/comparable O1. Only that
product pass permits discussion of V25 or the 85-case campaign.
