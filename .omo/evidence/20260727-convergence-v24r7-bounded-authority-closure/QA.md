# V24R7 Bounded Authority Closure QA

## What Was Tested

- Production TypeScript build using the unchanged locked dependency tree.
- Legal Coverage proposal, validation, receipt, apply, stale/replay, scope,
  record limit, existing-row mutation, reciprocal-link, and symlink controls.
- Progress and handoff ordinal behavior for invalid revisions, validated
  receipts, replay, apply, and completion.
- A real local Gateway with isolated Pilot home and project plugin, mock model,
  two real `bash` tool calls, Router and Memory disabled, and O1
  diagnostic/4096.
- A temporary-copy replay of the preserved V24R6 Case 09 failure workspace.
- Full repository regression tests, JSON validity, whitespace, boundary, and
  secret scans.

Exact commands are in `commands.txt`. Raw TAP and build output are preserved in
this directory.

## What Was Observed

- Build passed.
- Focused gate: 94 passed, 0 failed.
- Full gate attempt 1: 306 passed, 1 unrelated O1 teardown `ENOTEMPTY` failure.
  The exact output is preserved in `full-suite-attempt-1.tap`. The target O1
  test passed alone immediately afterward.
- Full gate attempt 2: 307 passed, 0 failed.
- The real Gateway path recorded
  `baseline(0,0) -> handoff_grace(0,1) -> completed(1,1)`.
- The Gateway used the injected proposal and apply interfaces, generated a
  current completion proof, and produced reciprocal issue-authority-matrix
  links through real `bash` execution.
- O1 integrity was complete; model requests, tool calls, and turns were paired;
  two tool starts matched two terminals; recorder drops were zero; stored O1
  evidence contained neither legal payload text nor the test API key.
- The preserved Case 09 replay injected all 12 target facts in 11,167 UTF-8
  bytes, below the 24 KiB limit, and did not expose apply before validation.

## Why It Is Enough For Commit

The automated tests cover the new domain transaction from hook injection
through the real Gateway and tool executor, plus every state/path/replay guard.
The unchanged Core convergence suites prove a handoff remains non-progress and
bounded. The full suite covers Router, Memory, tools, artifact preservation,
Gateway, model runtime, O1, and unrelated product surfaces.

This supports committing and pushing V24R7 for a fresh immutable small
campaign. It does not prove that a real model will make correct legal judgments
or that Case 09 is complete.

## Boundary Preserved

- All production changes are under the Legal Coverage product plugin, its
  Skill/reference, and its CLI/hook. Core Progress Lease and O1 source are
  unchanged.
- Validator acceptance rules and issue taxonomy are unchanged.
- Router, Memory, deadlines, model, evaluation inputs, and lease thresholds are
  unchanged.
- Invalid proposal revisions, reads, repair preparation, validated receipts,
  and apply execution do not become semantic progress.

## What Was Omitted

- No external LLM API request was made during deterministic QA.
- No credential, authorization header, private raw prompt, or private legal
  source content is stored in this evidence directory.
- A fresh real-model Case 05/09 campaign has not yet run.
- V25 and the 85-case campaign remain unauthorized until Case 09 passes the
  product Gate with a substantive deliverable and complete/comparable O1.
