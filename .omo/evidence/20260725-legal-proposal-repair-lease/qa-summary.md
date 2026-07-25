# Legal proposal repair lease QA

Date: 2026-07-25 (Asia/Shanghai)

## What was tested

- Replayed failed v14 Case 09 run `20260725_213041_df61a894` against the
  proposal validator to identify the exact rejection.
- Added a stable operational repair transition for rejected source-merge
  proposals without changing canonical state or Core lease behavior.
- Added explicit dynamic guidance for the optional structured
  `thresholdAssessment` field.
- Ran the legal product test file and the complete PilotDeck test suite.
- Replayed the real v14 proposal through merge, two different invalid
  revisions, and corrected apply states.

## What was observed

- The preserved proposal was correctly bound to the canonical state, fragment,
  receipt, and four ordered source IDs. Its only validation error was
  `source_merge_threshold_invalid` on fact 3 because prose was supplied where
  only null or a numeric threshold object is valid.
- Replacing prose threshold assessments with null made the same real proposal
  valid: 11 facts and an 8,188-byte projected transaction.
- Real-artifact replay directory:
  `/tmp/pd-v15-lease-repair-replay.fKRfvd`.
- Replay assertions all passed:
  - first rejection changes the operational convergence hash;
  - threshold and placeholder rejection revisions share the same stable repair
    hash, so invalid rewrites cannot create unlimited progress;
  - the corrected proposal advances to `source-fragment-apply`.
- Targeted legal product tests: 33/33 passed.
- Complete test suite: 246/246 passed.
- `git diff --check`: PASS.

## Why it is enough

The tests cover the exact v14 failure and the intended lease composition, plus
all existing legal transaction, validator, Gateway, artifact, and Core lease
regressions. Canonical ledgers remain unchanged for invalid proposals; only the
first transition into a stable repair state is observable to the unchanged
Core lease.

## What was omitted

- No provider call was needed for deterministic replay.
- A fresh real-provider Case 09 run is intentionally deferred to a new
  immutable campaign bound to the new commit and dist.
- No API key, token, auth header, or private credential was captured.
