# V24R6 Bounded Matrix Handoff QA

## What Was Tested

- Production TypeScript build from the frozen candidate dependency tree.
- Progress Lease unit counterexamples for replay, rollback, boundary ordering,
  simultaneous repair/handoff revisions, hard per-progress-epoch limits, and
  reset only after genuine progress.
- A sanitized replay fixture matching the closed Gate 2b Case 09 matrix tail.
- A real AgentLoop path through
  `handoff_grace -> boundary_grace -> renewed` with a full compaction boundary.
- The real local Gateway with an isolated Pilot home, isolated project plugin,
  mock model, real `bash` tool execution, Router disabled, Memory disabled, and
  O1 diagnostic/4096 observation.
- Legal Coverage hook subprocess and CLI behavior for invalid selection,
  validated continue selection, deterministic selection apply, next page,
  replay, finalization, and semantic progress.
- Full repository regression tests, JSON validity, and whitespace checks.

Exact commands are in `commands.txt`. Build output is in `build.log`; focused
and full TAP output are in `focused-tests.tap` and `full-suite.tap`.

## What Was Observed

- Build passed under the repository's required Node runtime.
- Focused gate: 89 passed, 0 failed, including the isolated real Gateway.
- Full gate: 304 passed, 0 failed.
- The Gateway and O1 both recorded:
  `baseline(0) -> renewed(0) -> handoff_grace(1) -> boundary_grace(2) -> renewed(2)`.
- O1 integrity was complete; model requests, tool calls, and turns were paired;
  recorder drops were zero.
- A handoff retained the stagnation count and never renewed semantic progress.
- Replay, ordinal rollback, a ninth handoff under the frozen limit of eight,
  and an unavailable required boundary did not receive grace.
- A simultaneous repair and handoff revision received one request, not two.
- Invalid legal selections did not advance `handoffOrdinal`. A valid continue
  selection and the resulting next evidence page each advanced it exactly once.
- Repeated `PreModelRequest` and `UserPromptSubmit` calls did not manufacture
  another witness. Final selection advanced existing `progressOrdinal` and did
  not create a handoff.

## Why It Is Enough For Commit

The tests cover every modified boundary: metadata parsing, Core state machine,
AgentLoop scheduling, forced compaction, Gateway projection, O1 persistence,
Legal Plugin witness ownership, and the existing legal validator/transaction
path. The full suite covers unchanged Router, Memory, Gateway, tools, artifact,
and model-runtime behavior.

This supports committing and pushing V24R6 for a new immutable small campaign.
It does not prove the Case 09 legal product is complete.

## Boundary Preserved

- Core sees only opaque ordinals, counts, and boundary outcomes. It contains no
  legal phase, matrix, selection, page, path, fact, or validator-code logic.
- Legal Coverage owns state hash, matrix ID, evidence batch, page offset,
  selection hash/path, and checkpoint issuance.
- Validator acceptance, seven matrices, completion proof, Router, Memory,
  deadlines, and the 85-case corpus were not changed.

## What Was Omitted

- No external LLM API request was made during deterministic QA.
- No private legal source, answer, raw prompt, credential, authorization
  header, or environment dump is stored in this evidence directory.
- The live Case 05 and Case 09 Gates were not rerun before committing.
- V25 and the 85-case campaign remain unauthorized until a new immutable
  campaign passes paired smoke, Case 05, and the full Case 09 product Gate.
