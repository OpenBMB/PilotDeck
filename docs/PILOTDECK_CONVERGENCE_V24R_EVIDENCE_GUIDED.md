# PilotDeck Convergence V24R: Evidence-Guided Recovery

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260726-fix-convergence-v24r-evidence-guided-v1`
- Branch: `codex/convergence-v24r-evidence-guided`
- Frozen base: `51c06715699c887741531b8e342de1fe9f6ee6ba`
- V24R is a repair candidate for a new isolated live Gate. It is not V25.
- O1 remains default-off, shadow-only, hash-only, and invisible to the Agent.

## Why V24R Exists

V24 passed local gates but failed the live Case 09 product Gate. The closed run
`20260726_174251_99c9a304` provided three actionable observations:

1. O1 recorded 127 tool starts but only 126 terminals. Raw Gateway evidence
   showed the missing nested `read_file` completed, so the mismatch was in the
   observation projection rather than tool execution.
2. Sixty-one of 66 compactions reported `no_summarizable_messages`. The real
   trajectory had one initial user prompt followed by many assistant/tool
   cycles, while the old planner treated the entire trajectory as one turn.
   Context grew from 57,011 to 210,669 tokens.
3. Forty-nine of 58 lease renewals were ordinal-only. The Legal Plugin advanced
   its ordinal on operational digest churn, including matrix pagination, rather
   than only on coarse validated legal progress.

V24R changes only the mechanisms directly supported by those observations.
It does not tune expected answers or weaken the legal validator.

## Ownership Boundary

PilotDeck Core owns:

- O1 event projection and exact tool span integrity;
- generic message framing and compaction planning;
- generic Progress Lease comparison of a domain-issued ordinal.

The Legal Plugin owns:

- legal phases and their ordering;
- validated source and matrix transaction semantics;
- the coarse, session-scoped `progressOrdinal` checkpoints.

The evaluation Runner owns deployment isolation, deadlines, artifact
preservation, O1 Bundle checks, and immutable campaign metadata.

V24R does not change the model, Router, Memory, lease limits `8/2`, validator
strictness, legal source material, expected answers, or evaluation rubric.

## Repair 1: One O1 Projection Layer

O1 now opens tool spans from `tool_calls_detected` and
`subagent_tool_calls_detected`, then closes them from `tool_result` and
`subagent_tool_result`. Internal `pre_tool_execute` and `post_tool_execute`
events are not independent O1 span boundaries.

This matches the model-visible projection. A nested tool inside `execute_code`
can have an internal execution lifecycle without an independent top-level tool
result, so mixing these two layers created a false unmatched span. O1 still
stores only bounded metadata and hashes, never tool input or output bodies.

## Repair 2: Atomic Compaction Frames

Full compaction now splits a trajectory into the smallest contiguous frames
that keep every tool call with its result. The tail window and bounded
protected-prefix retention align to those frames rather than to user-message
conversation turns.

This supports both ordinary multi-prompt conversations and the real long-task
shape:

```text
one user prompt
assistant tool call -> tool result
assistant tool call -> tool result
...
```

Both the summarized side and retained side are reduced to exact tool pairs.
The planner therefore gets a real summarizable prefix without emitting
dangling calls or results.

## Repair 3: Legal Coarse Checkpoints

The Legal Plugin no longer derives `progressOrdinal` from every new milestone
digest. The digest remains useful for dynamic-context identity and diagnostics,
but it is not a lease-renewal signal.

An ordinal advances once for either:

- entering a higher legal phase not previously reached in the session; or
- observing one new, validated transaction checkpoint:
  - `source-fragment-apply` with a validated proposal;
  - `matrix-pending-selection-apply` with a validated `finalize` selection;
  - `matrix-pending-apply` with a validated proposal.

Checkpoint identity is a SHA-256 digest over the checkpoint kind, expected
legal state hash, and bounded target identity. It excludes proposal prose,
page offsets, error messages, and mutable diagnostic text. The session stores
a bounded set of seen checkpoint digests and the highest phase rank.

The following do not advance the ordinal:

- matrix page continuation;
- invalid revisions or proposal rewrites;
- digest or diagnostic hash changes by themselves;
- replaying the same validated checkpoint;
- error-count growth;
- regression to, then recovery of, an already reached phase.

Core remains ignorant of legal phases and transaction names.

## Local Verification Contract

Before the candidate can enter a live campaign:

1. Build from the frozen lockfile.
2. Prove main and subagent O1 tool pairs, including nested internal lifecycle
   events, produce exactly one start and one terminal.
3. Prove a real-shaped single-prompt trajectory is summarized and both sides
   retain exact tool pairs.
4. Prove generic Progress Lease behavior is unchanged.
5. Prove legal page continuation and invalid revision churn do not advance;
   validated final selection, validated proposal, source apply, and a new phase
   advance exactly once; replay and `UserPromptSubmit` preserve state.
6. Pass the complete repository test suite.
7. Store sanitized reviewer-readable evidence under `.omo/evidence/`.

## New Live Gate

Never reuse the closed V24 campaign. Create a new immutable campaign using the
hardened runner at:

`/Users/da/ws/Lantay-PD-test/worktrees/20260726-eval-runner-observation-o1`

Run in this order with Router and Memory disabled:

1. baseline smoke;
2. candidate smoke;
3. candidate Case 05;
4. candidate Case 09.

V24R passes only if:

- every O1 Bundle is complete and comparable;
- tool starts and terminals are exactly paired;
- full compaction is applied on the old prefix and materially bounds context;
- every ordinal-only renewal maps to one accepted coarse checkpoint;
- Case 05 shows no legal-plugin leakage;
- Case 09 product behavior is bounded or materially improved;
- artifact, secret, plaintext, lifecycle, and deadline checks pass.

Local tests do not prove the live legal task is solved. If O1 is corrected but
context or product behavior remains unbounded, V24R is diagnostic only. V25 and
the complete 85-case campaign remain blocked until this small live Gate passes.
