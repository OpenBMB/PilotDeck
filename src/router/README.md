# Model routing

Chooses model routes and orchestrates provider health, fallback chains and configured routing policy.

Entry points: [index.ts](index.ts), [RouterRuntime.ts](RouterRuntime.ts), [runFallbackChain.ts](fallback/runFallbackChain.ts).

Honor explicit request selections and reference validation before applying automatic routing or fallback.

Tests: [tests/router](../../tests/router). See the [test guide](../../docs/testing.md) for runner selection.
