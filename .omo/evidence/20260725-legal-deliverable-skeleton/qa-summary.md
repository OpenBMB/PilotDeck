# Legal deliverable skeleton QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `a3efd713e96969e09be82b083763b49a8fbf68ab`

## What was tested

Focused legal-plugin gate:

```text
npm run build
node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js
```

Full repository gate:

```text
npm test
```

The focused gate exercised initializer creation, repeat initialization,
existing-content preservation, explicit text-format handling, unsupported
binary handling, absolute-path rejection, traversal rejection, symlink-ancestor
rejection, validator behavior, hook milestones, and plugin loading. The full
gate also drove the real local Gateway lifecycle, artifact contracts, dynamic
request context, progress lease, compaction boundary, tools, and history paths.

## What was observed

- Focused legal-plugin tests: 29 passed, 0 failed.
- Full repository tests: 241 passed, 0 failed.
- First initialization created non-empty `.md`, `.txt`, `.html`, `.htm`, and
  `.csv` skeletons at the configured paths.
- Repeated initialization created nothing and preserved the exact existing
  bytes.
- A missing `.docx` was reported as unsupported and was not created.
- Existing user-authored content was unchanged.
- Absolute, traversal, and symlinked paths returned a structured initialization
  error and created no file outside the workspace.
- `git diff --check` passed.

## Why this is enough

The regression that blocked v5 occurred because the model completed legal
initialization but did not obey a later `write_file` prompt. The new behavior
makes creation part of the same deterministic legal initializer and verifies
that exact path in both isolated CLI tests and the repository's real Gateway
lifecycle suite. The no-overwrite and path tests cover the mutation boundary;
the binary test proves that the plugin does not synthesize invalid Office
artifacts. Core convergence policy and the evaluation runner were not changed.

## What was omitted and residual risk

No credentials, auth headers, environment dumps, private corpus contents, or
raw model payloads are stored here. Unit and local Gateway QA cannot prove that
the external model will complete the full difficult legal task. A fresh v6
candidate-only Case 09 run remains required before a paired run or the 85-case
campaign. As with the repository's existing workspace path guard, protection
assumes no hostile process swaps filesystem ancestors concurrently between
validation and creation.
