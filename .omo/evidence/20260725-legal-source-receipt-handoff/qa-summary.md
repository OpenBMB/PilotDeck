# Legal source receipt handoff QA

Date: 2026-07-25 (Asia/Shanghai)

## What was tested

- Replayed the v12 Case 09 event trace and preserved workspace to classify the
  post-worker `boundary_rejected` failure before changing code.
- Added product tests for deterministic source-review fragment envelopes,
  invalid alias-bearing receipt rejection, exact source/path membership,
  receipt hash binding, bounded four-source/24-KiB slices, stale receipt hash
  rejection, dynamic dispatch-to-merge prompt transition, and opaque progress
  hash renewal.
- Built PilotDeck and ran the complete legal-coverage product suite.
- Ran the full repository test suite, including real local Gateway lifecycle,
  generic lifecycle identity, progress lease, compaction boundary, editor,
  artifact, plugin, and tool tests.
- Rebuilt after the final Skill wording update and reran the legal product
  suite.

## What was observed

- v12 run `20260725_201516_643aaaf9` proved two sibling workers succeeded and
  produced disjoint 12-source fragments, but the prior Legal Plugin re-emitted
  dispatch work because it did not recognize fragment receipts. Core correctly
  failed closed after two unchanged `source_pending` observations.
- A malformed fragment using the prior `reviews` alias does not change the
  dynamic work group or opaque progress hash.
- Two valid deterministic receipts change the work group from
  `pending-source-review` to `source-fragment-merge`, change the Legal
  Plugin-owned opaque hash, and expose a receipt-hash-bound `fragment-slice`
  command for at most four source rows and 24 KiB.
- A stale receipt hash and out-of-contract receipt fail closed without exposing
  fragment content.
- Legal product suite: 33/33 passed after implementation.
- Full repository suite: 246/246 passed.
- Final post-Skill build and legal product rerun: 33/33 passed.
- `git diff --check` and Node syntax checks passed.

## Why it is enough

The tests exercise the exact failed handoff while keeping ownership boundaries
observable: workers write only validated fragments, the Legal Plugin validates
and slices operational receipts, the main Agent remains the sole canonical
writer and legal decision maker, and Core still sees only an opaque domain
state hash. The unchanged Core progress-lease tests and real Gateway lifecycle
tests cover the main cross-module regression risk.

The next evidence gate is a fresh immutable candidate campaign. Unit and local
Gateway QA cannot prove that the configured model will obey the new envelope
and complete the bounded canonical merge in a real 24-source legal task.

## What was omitted

- No v12 product failure was retried and no baseline Case 09 was run.
- No API key, token, auth header, private source content, environment dump, or
  raw secret-bearing log is stored here.
