# V24R2 One-Shot Repair Feedback QA

## What Was Tested

- Frozen dependency installation and production TypeScript build.
- Progress Lease state-machine counterexamples for new, replayed, stale, and
  pre-boundary repair ordinals.
- A real AgentLoop sequence proving newly injected repair feedback reaches one
  model request after an applied full boundary.
- O1 projection of `progress-lease/v3`, `feedback_grace`, and `repairOrdinal`.
- Legal Plugin process tests for stable source/matrix repair identity, invalid
  rewrite replay, genuine progress, and session persistence.
- Existing real-shaped full compaction and exact O1 tool-pair tests.
- Full repository Node test gate, `git diff --check`, and evidence marker scan.

Exact commands are in `commands.txt`. Exact output is in `focused-tests.tap`
and `full-tests.tap`.

## What Was Observed

- Focused gate: 73 passed, 0 failed; duration 8.849 seconds.
- Full gate: 277 passed, 0 failed; duration 28.459 seconds.
- A strictly larger post-boundary repair ordinal returned `feedback_grace`,
  preserved the stagnation count, and delivered the repair context to the
  fourth model request.
- Replaying that ordinal failed closed; genuine progress after the feedback
  renewed normally.
- Feedback observed before a boundary could not be saved and replayed after
  the boundary.
- Multiple invalid source revisions with changing validation failures issued
  one repair ordinal; the valid apply advanced progress without another repair
  revision.
- O1 stored only policy/ordinal/decision metadata, not repair diagnostic bodies.
- The marker scan matched only its command text and test titles containing the
  configuration field `apiKey`; no credential value, authorization header,
  bearer value, private key, prompt, legal material, tool body, or private
  reasoning was captured.

The first marker-scan expression had a zsh character-class quoting error. It
was replaced by a simpler marker expression and rerun successfully. This did
not affect build or test execution.

## Why It Is Enough For Commit

The tests cover the pure state machine, the actual AgentLoop request boundary,
the Gateway/O1 projections, and the Legal Plugin subprocess boundary. The full
gate protects unrelated behavior. This supports committing and pushing a
V24R2 candidate for a new isolated live campaign.

It does not prove Case 09 is solved. The live Gate must show the first rejected
proposal reaches the model once and then either becomes a valid progress
checkpoint or correctly fails closed.

## What Was Omitted

- No live prompt, answer, legal source, raw tool input/output, provider
  credential, server token, environment dump, or private chain-of-thought is
  stored here.
- No authenticated campaign and no 85-case run were performed by this local
  pre-campaign gate.
