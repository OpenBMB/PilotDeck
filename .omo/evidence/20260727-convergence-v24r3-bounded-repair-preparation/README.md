# V24R3 Bounded Repair Preparation QA

## What Was Tested

- Production TypeScript build with the frozen dependency tree.
- Progress Lease counterexamples for new, stale, replayed, pre-feedback, and
  repeated repair preparation ordinals.
- A real AgentLoop six-request sequence proving
  `boundary_grace -> feedback_grace -> repair_preparation_grace -> renewed`.
- O1 projection of `progress-lease/v4`, both repair ordinals, and the new
  decision without repair paths or diagnostics.
- Legal Plugin subprocess behavior for wrong-target reads, an exact successful
  proposal read, repeated reads with different ranges, and later model-request
  observation.
- Existing legal validator, full compaction, real local Gateway, tool pairing,
  artifact, and repository regression suites.
- JSON validity, `git diff --check`, Core/domain marker separation, and evidence
  secret-marker scans.

Exact commands are in `commands.txt`. Exact focused and full TAP output is in
`focused-tests.tap` and `full-tests.tap`.

## What Was Observed

- Focused gate: 78 passed, 0 failed; duration 9.259 seconds.
- Full gate: 282 passed, 0 failed; duration 27.973 seconds.
- A target preparation revision did not change remaining work, progress, or the
  stagnation count. It allowed exactly one model request after feedback.
- Genuine progress immediately after preparation renewed the lease. Replaying
  preparation, publishing it before feedback, or publishing another repair
  revision without progress failed closed.
- The Legal Plugin advanced preparation from 0 to 1 only for a successful
  `read_file` of the exact current proposal. A different legal checkpoint and
  a repeated target read left the ordinal unchanged.
- Core contains no legal phase, source, matrix, proposal path, or legal error
  code. O1 contains only generic policy, decision, counts, and ordinals.

## Why It Is Enough For Commit

The tests cover the pure state machine, actual AgentLoop request boundary,
PostToolUse plugin subprocess boundary, O1 projection, and full repository
regression surface. This supports committing and pushing V24R3 for one new
immutable small live campaign.

It does not prove Case 09 is solved. The live Gate must still pass paired smoke,
the Case 05 non-activation control, Case 09 O1 integrity, and the current legal
validator. It does not authorize V25 or the 85-case campaign.

## What Was Omitted

- No live prompt, answer, legal source, raw tool body, provider credential,
  server token, environment dump, or private reasoning is stored here.
- No authenticated campaign and no 85-case run were performed by this local
  pre-campaign gate.
