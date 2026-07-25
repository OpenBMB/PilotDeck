# Source Proposal State Handoff v1

Status: implementation experiment derived from the v20 fresh Case 09 run.

## Problem

The state-bound source readiness checkpoint correctly advances the work group
from preparation to proposal. The proposal prompt, however, relies on the model
attending to the bounded slice returned by the prior tool call. In v20 the
model ignored an explicit write-next instruction, reread the checkpoint, then
reread the complete worker fragment. Neither read changed state, so the
unchanged Core lease correctly failed closed before a proposal existed.

## Decision

When a readiness checkpoint is valid, the Legal Plugin already reconstructs
the exact bounded source slice to verify its SHA-256. The plugin now carries
that same verified object into the next `source-fragment-propose` work item as
`preparedSlice`.

The model receives the current evidence and proposal template in one dynamic
state envelope. It no longer needs to recover evidence from prior tool history,
read the checkpoint, or reopen the worker fragment. The model still owns fact
normalization, legal materiality, conflict status, and proposal writing.

`preparedSlice` is removed when a valid proposal advances to apply, so later
requests do not retain unnecessary evidence payload.

## Boundaries

This experiment does not change:

- Core convergence or the cold-start 8 / steady-state 2 lease;
- Legal validator semantics or source/fact schemas;
- worker ownership or disjoint batch assignment;
- readiness checkpoint fields, limits, or SHA binding;
- proposal validation or SHA-bound atomic apply;
- the four-source / 24 KiB proposal boundary;
- matrix relation-closure, issue, authority, coverage, or deliverable rules;
- prompts with benchmark IDs, expected answers, or Case 09 literals.

The plugin does not generate a legal proposal. It performs deterministic state
assembly from an already validated worker receipt; semantic judgment remains
Agent-owned and validator-enforced.

## Verification gates

1. Unit tests prove injected state equals the exact preparation output, remains
   bounded, disappears on apply, and is absent for a tampered checkpoint.
2. Legal Plugin tests and the full PilotDeck suite pass.
3. Read-only replay against the v20 settled snapshot proves the previously
   missing proposal evidence is present without changing canonical ledgers.
4. A fresh candidate-only Case 09 run determines whether the Agent writes the
   proposal before the lease closes and can later reach the v20 matrix treatment.
