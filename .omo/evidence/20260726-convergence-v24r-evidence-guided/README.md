# V24R Evidence-Guided Recovery QA

## What Was Tested

- Frozen dependency installation and production TypeScript build.
- Focused Node gate covering O1 recorder pairing, real-shaped full compaction,
  generic Progress Lease, Pilot config, and the Legal Plugin process boundary.
- Full repository Node gate over every compiled test and spec.
- `git diff --check` and a credential-marker scan of the captured TAP output.

Exact commands are recorded in `commands.txt`. Exact test output is in
`focused-tests.tap` and `full-tests.tap`.

## What Was Observed

- Focused gate: 67 passed, 0 failed.
- Full gate: 272 passed, 0 failed; duration 28.504 seconds.
- Main and subagent tool events produced one exact O1 start/terminal pair while
  nested internal lifecycle events did not create a false span.
- A 30-cycle single-prompt trajectory produced a real summary request and
  preserved exact tool pairs on both summarized and retained sides.
- Matrix page continuation, invalid revision churn, and repeated observations
  did not advance the legal ordinal.
- Validated final selection, validated matrix proposal, validated source apply,
  and first entry into a higher legal phase advanced once; replay did not.
- A later `UserPromptSubmit` preserved the session progress state.
- The credential scan matched only test titles containing the configuration
  field name `apiKey`; no value, authorization header, bearer credential,
  private key, legal material, prompt body, or tool body was captured.

## Why It Is Enough For Commit

The changed integration surfaces are exercised at their actual process and
runtime boundaries, and counterexamples reproduce the three failure classes
seen in the closed V24 Case 09 run. The full gate covers unrelated Core and
product behavior against regression. This supports committing and pushing a
V24R candidate for isolated live evaluation.

It does not prove Case 09 is solved. That requires a new campaign and complete,
comparable O1 evidence from the live Gateway.

## What Was Omitted

- No model prompt, raw tool input/output, legal source, expected answer, Judge
  material, environment dump, credential, or private chain-of-thought is in
  this evidence directory.
- No authenticated live run and no 85-case campaign were performed during the
  pre-campaign gate.
