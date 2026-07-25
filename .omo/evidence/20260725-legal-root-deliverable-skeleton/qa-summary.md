# Root-level legal deliverable skeleton QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `bfc666cdebe3ffdb34ce061aba7c1d1f02ccc3fb`

## Triggering evidence

Candidate-only Case 09 in campaign
`20260725-e2-elite-convergence-v6-skeleton`, run
`20260725_172318_a75649af`, called the legal initializer with the safe root-level
deliverable `担保人主体审查报告.md`. The initializer returned
`deliverable_skeleton_write_failed` because the file's parent is the workspace
root and was represented as an empty relative path during parent validation.
The input manifest remained unchanged and the runner failed closed correctly.

## Change and boundary

The legal skeleton writer now represents a workspace-root parent as `.` before
calling the existing safe workspace resolver. No Core, progress-lease, runner,
validator, activation, or format behavior changed. The existing initializer
test now uses a root-level `opinion.md`, while the format test continues to
exercise nested deliverables.

## Commands and observations

```text
npm run build
node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js
```

Result: 29 passed, 0 failed. The root-level skeleton was created, repeated
initialization preserved its bytes, and nested, no-overwrite, unsupported
binary, absolute, traversal, and symlink boundary tests remained green.

```text
npm test
```

Result: 241 passed, 0 failed. This includes the real local Gateway lifecycle,
legal hook, artifact contract, dynamic request context, progress lease,
compaction boundary, tools, and history tests.

## Why this is enough and residual risk

The regression is deterministic and its exact path shape is now covered. The
full suite shows that normal plugin and Core behavior did not regress. A fresh
campaign is still required because the v6 plugin snapshot is immutable and the
external-model Case 09 path has not yet run with this commit.

No credentials, auth headers, environment dumps, private corpus contents, or
raw model payloads are stored here.
