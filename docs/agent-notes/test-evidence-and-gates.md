# Test Evidence And Gates

## Context

Passing tests on the fixed implementation are necessary but do not prove that
the test detects the regression. PilotDeck therefore separates deterministic
unit/contract evidence, compiled artifact evidence, mutation proof, browser
smoke, and credentialed nightly evaluation.

## Invariants

- Every new bug fix starts with a current behavior failure and retains a
  deterministic regression test.
- Historical claims distinguish `PARENT_FAIL`, `CURRENT_ONLY`, and
  `COVERED / MUTATION_FAIL`; a current-only pass is never presented as a parent
  failure.
- Protocol assertions normalize dynamic IDs, timestamps, paths, and secrets;
  snapshots never write back automatically.
- Missing fixtures, credentials, or required external configuration fail
  explicitly rather than silently skipping.
- `CI / All checks pass` currently reports the aggregate result but is not a
  Branch Protection required check.

## Evidence map

| Layer | Command/workflow | Scope |
| --- | --- | --- |
| Unit | `pnpm check` | deterministic Node and UI tests |
| Contract | `pnpm test:contract` | Gateway frames/events and process smoke |
| Artifact | `pnpm test:artifact` | compiled `dist` exports and plain Node smoke |
| Mutation | `pnpm test:regression-proof` | manual reverse-fix evidence |
| Browser | `pnpm --dir ui e2e` | controlled fake-provider UI workflow |
| Nightly | `pnpm test:external` | provider, web, router, and Docker groups |

The roadmap defines when coverage thresholds may become blocking. Repository
Branch Protection is deliberately deferred until the gates are stable across
two iterations.
