# PilotDeck V24R15 post-tool convergence preview

## Problem contract

The preserved V24R14 Case 09 run did useful work but reached the 2100-second
machine deadline. O1 recorded 67 model requests, 113 tool pairs, and 19 full
compactions. Most forced compactions began at only 49-55 percent context use.

The dominant ordering failure was:

1. `PreModelRequest` reported stagnation and scheduled a boundary.
2. The model wrote a valid, state-bound legal proposal.
3. The Legal Coverage plugin could report the new handoff only at the next
   `PreModelRequest`.
4. AgentLoop ran the already-scheduled full compaction before that hook.
5. The hook then confirmed `handoff_grace`, after the expensive boundary had
   already consumed time.

One observed proposal write took about 14 seconds, while the unnecessary full
summary immediately after it took about 45 seconds. The run spent an estimated
10-15 minutes on this repeated ordering penalty.

## Scope and ownership

V24R15 adds one domain-neutral Core protocol and one Legal Coverage adapter.

Core owns:

- a bounded `convergencePreview` PostToolUse output;
- internal transport from HookRuntime through ToolRuntime to AgentLoop;
- pre-boundary eligibility checks;
- mandatory confirmation before the next model request;
- fail-closed behavior and O1/Gateway projection.

The Legal Coverage plugin owns:

- deciding which legal tool operations may change durable legal state;
- re-running the unchanged legal validator after those operations;
- deriving the same opaque convergence ordinals used by `PreModelRequest`;
- emitting no legal work items, commands, prompts, or validator payload in the
  preview.

Core does not understand legal phases, ledgers, proposal schemas, authorities,
or matrix transactions. The plugin cannot alter Progress Lease policy.

## Bounded protocol

`convergencePreview` accepts only:

- `schemaVersion`;
- `scope`, `phase`, and `stateHash`;
- optional `blockingCode`;
- `remainingCount`;
- optional progress, repair, repair-preparation, and handoff ordinals.

Strings and ordinals are length/range checked. Unknown fields such as
`nextBatch`, commands, templates, or private domain payload are discarded.
HookRuntime produces the effect only for `PostToolUse`. ToolRuntime stores it
only under internal lifecycle metadata; the tool result text shown to the model
and user is unchanged.

## Boundary decision

At the next loop boundary, Progress Lease may defer a required full compaction
only when exactly one tracked scope requires a boundary and its newest preview
shows one of:

- `remainingCount` decreased;
- `progressOrdinal` increased;
- completion (`remainingCount = 0` and no blocker);
- `handoffOrdinal` increased within the existing per-progress-epoch budget.

A preview cannot defer for opaque state-hash churn, repair-only changes,
repair-preparation-only changes, replayed/lower ordinals, an exhausted handoff
budget, or multiple simultaneously forcing scopes. Lease thresholds remain
`maxInitialStagnantObservations=8` and `maxStagnantObservations=2`; no new grace
decision is added.

The preview is advisory and consumes no lease state. AgentLoop clears it after
one boundary decision.

## Confirmation and failure mode

After a boundary is deferred, the immediately following `PreModelRequest` is
still authoritative. It must report the same scope and produce `renewed`,
`completed`, or `handoff_grace` under the existing Progress Lease rules.

If the report is missing, stale, replayed, repair-only, over budget, or belongs
to another scope, AgentLoop stops before sending the model request with:

- error: `agent_convergence_stalled`;
- reason: `boundary_preview_unconfirmed`.

This prevents a buggy or stale PostToolUse hook from converting an advisory
preview into unbounded execution.

## Legal adapter performance boundary

The Legal Coverage hook does not validate after every tool call. It computes a
preview only after operations that may change durable legal state:

- `write_file` inside `.pilotdeck/work/legal-coverage`;
- the plugin's explicit state-changing CLI commands, including initialization,
  source preparation/apply, matrix apply, issue apply, authority apply, and
  coverage batch apply.

`read_file`, writes outside the legal state directory, and read-only legal CLI
commands do not produce a preview. Existing repair-preparation tracking remains
separate and cannot defer a boundary.

The adapter computes ordinals without writing progress or handoff state.
`PreModelRequest` remains the only persistence and confirmation point. Writing
a proposal can expose a bounded handoff, but cannot manufacture semantic
progress.

## Observability

Every deferral emits a separate O1 decision:

- type: `harness.decision`;
- component: `progress-boundary`;
- policy: `progress-boundary/v1`;
- decision: `deferred`;
- reason: `post_tool_convergence_preview`.

The following authoritative result remains a normal
`progress-lease/v5` decision. This preserves the existing policy stream while
making ordering and confirmation independently auditable. Gateway consumers
also receive `progress_boundary_deferred` status with only scope names.

## Code gate

The required code evidence is:

- parser whitelist and size/range rejection;
- HookRuntime event restriction;
- internal-only ToolRuntime transport;
- Progress Lease acceptance and counterexamples;
- multi-scope and exhausted-budget rejection;
- AgentLoop success with zero forced full compactions;
- stale-preview failure before a third model request;
- real local Gateway run with complete O1 pairing and the ordered deferred then
  confirmed decisions;
- unchanged Legal Coverage validator and transaction tests;
- full repository test suite and diff checks.

## Product gate

Code success does not prove Case 09 success. After the code gate, create a new
immutable V24R15 campaign from the same V24R14 runner, candidate baseline,
model, Skills, corpus, Router/Memory controls, O1 diagnostic profile, 2100-second
deadline, and Lease `8/2`.

Run Gate 1, Case 05, then Case 09 exactly once. Freeze the campaign on failure.
V25 and the 85-case campaign remain blocked until Case 09 produces a complete
O1 trajectory, unchanged-validator proof, completion proof, and substantive
report artifacts. No result from V24R14 is overwritten or reclassified.

## Non-goals

V24R15 does not change validators, prompt content, domain transactions, Router,
Memory, model selection, compaction capacity thresholds, runner deadlines, or
the corpus. It does not add Case 09 text matching and does not let plugins
cancel boundaries directly.
