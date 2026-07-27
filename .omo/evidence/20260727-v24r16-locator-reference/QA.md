# V24R16 QA Evidence

## What was tested

- `pnpm test` from the V24R16 worktree. This runs the TypeScript build and the complete Node test suite.
- `git diff --check` for whitespace and patch integrity.
- Static boundary inspection of all V24R16 changes for `locatorRef` and `progress-boundary-preview` references.
- The focused tests included in the full suite exercise ProgressLease preview decisions, AgentLoop event emission, Gateway mapping, O1 recording, Local Gateway handoff observation, and Legal Coverage locator-reference resolution/rejection.

## What was observed

- Full suite passed: `328` tests, `328` passed, `0` failed, `0` skipped, `0` cancelled.
- Build completed before the test run.
- The exact test output is preserved at `full-test.log` in this directory.
- `progress-boundary-preview/v1` is emitted as a separate O1 component with bounded fields: scope, decision, and fixed reason code. Existing `progress-boundary` deferred behavior remains separately tested.
- Valid Legal Coverage `locatorRef` values resolve to canonical `{sourceId, locator}` before the existing transaction/ledger path. Unknown references fail closed with `source_merge_fact_locator_ref_unverified`.
- The static diff contains no changes to the validator schema, model/provider configuration, Router, Memory, deadline, Case 09 text, or the `8/2` Lease limits.

## Why this is enough

The full suite covers the changed Core and Legal paths together, including live Local Gateway/O1 wiring and canonical ledger preservation. The evidence proves the new diagnostic event is observable and that the legal convenience reference cannot bypass receipt-bound fragment validation. It does not claim that the live Case 09 semantic checker passes.

## What was omitted

- No live provider campaign was run in this worktree. V24R15 remains frozen, and a new immutable V24R16 campaign requires a separate Gate 0/Gate 1 setup.
- No raw API keys, authorization headers, environment dumps, or provider logs were copied into this evidence directory.
