# V24R13 capacity-aware compaction QA

## What was tested

1. A new uneven protected-frame counterexample was built and run on the V24R12
   base before the Core implementation.
2. The same focused context suite was rebuilt and rerun after implementation,
   including aggregate retention, pair integrity, newest-frame, oversized
   newest-frame, and no-summarizable boundaries.
3. The preserved V24R12 Case 09 durable session shape was replayed through both
   built engines with a local mock summary model. The replay emitted statistics
   only.
4. Focused AgentLoop, Progress Lease, real local Gateway, O1/router observation,
   and Legal Coverage control suites were run together.
5. The complete repository build and test suite plus `git diff --check` were run.

## What was observed

- Red counterexample: 9 existing tests passed; only the new aggregate-retention
  assertion failed on V24R12 because exact retained tokens exceeded 35%.
- Green context suite: 11/11 passed in 437.1065 ms.
- Preserved replay input: 27 durable messages, 88,280 estimated tokens, 30,897
  exact-retention target.
- V24R12 replay: 42,098 exact retained tokens (47.6869%), 42,157 projected
  post-message tokens, and no protected agent pair entered summary.
- V24R13 replay: 27,232 exact retained tokens (30.8473%), 27,291 projected
  post-message tokens, and both older protected agent pairs entered summary.
- Both replay partitions retained complete tool call/result pairs and the newest
  pair remained exact.
- Focused controls: 95/95 passed, including real local Gateway/O1 legal flows.
- Full repository: 313/313 passed after a clean build.
- Patch hygiene: `git diff --check` passed; the frozen dependency lock was not
  modified.

Artifacts:

- `red-counterexample.log`
- `green-counterexample.log`
- `preserved-session-comparison.md`
- `replay-preserved-case09-context.mjs`
- `focused-controls.log`
- `full-suite.log`

## Why it is enough for the code gate

The red/green test isolates the previous count-based bypass and proves the new
aggregate token ceiling. The preserved replay demonstrates the same behavior
on the actual failed session's durable message shape without copying content.
Pair assertions cover provider validity, and the focused real-Gateway controls
show that dynamic context, Lease accounting, O1, and Legal Coverage still
compose. The full suite covers unrelated regressions.

## Remaining product risk

This QA does not prove that a real model summary preserves every semantic fact,
that the complete request including system/tools/dynamic context clears the
blocking threshold in every trajectory, or that Case 09 reaches completion.
Those are product-level claims and require a fresh immutable Gateway/O1
campaign. V25 and the 85-case campaign remain unauthorized until full Case 09
passes with completion proof and a substantive validated report.

## What was omitted

No API key, token, auth header, environment dump, private source content,
prompt body, legal report text, or model reasoning was recorded. The replay
script reads the preserved session locally but emits only aggregate metrics and
booleans.
