# Router And Configuration Contracts

## Context

Router decisions select models and orchestration behavior without changing the
user's accepted message or persisted history. Configuration reload is an
atomic boundary for runtime consumers.

## Invariants

- `allowedTools: undefined` means no explicit allowlist; `allowedTools: []`
  means keep no tools. A configured allowlist always takes precedence over a
  blocklist, including when its filtered result is empty.
- Orchestration prompt injection is bounded to the current request and must not
  repeat for subagent requests.
- Sticky routing state is isolated by session and cannot leak across projects
  or sessions.
- A failed configuration reload preserves the last valid snapshot and does not
  interrupt an active turn.
- Retry/fallback decisions do not mutate the original model request or
  persisted conversation.

## Evidence and status

- [router orchestration tests](../../tests/integration/router-orchestration-sticky.spec.ts)
- [router regressions](../../tests/regressions/model-router-regressions.spec.ts)
- [configuration/state regressions](../../tests/regressions/config-state-file-regressions.spec.ts)

The explicit empty and non-matching allowlist cases are covered on the current
branch. A reverse mutation proof for this specific allowlist fix is not yet in
`scripts/verify-regression-proofs.mjs`; it must be added before the audit row is
classified as `COVERED / MUTATION_FAIL`.
