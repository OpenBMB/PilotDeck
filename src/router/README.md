# Model routing

Chooses model routes and orchestrates provider health, fallback chains and configured routing policy.

Entry points: [index.ts](index.ts), [RouterRuntime.ts](RouterRuntime.ts), [runFallbackChain.ts](fallback/runFallbackChain.ts).

Honor explicit request selections and reference validation before applying automatic routing or fallback.

Turn cancellation reaches judge requests and retry delays. Optional execution callbacks project resolved context for each selected/fallback model and finalize it after routing patches and media conversion. Cache identity follows the final request; provider changes never reuse another model's plan. Callers without these callbacks retain the ordinary canonical-request interface.

Task classification and legacy subagent tags read actual user requests through the shared model-message predicate. Request-only memory, artifact indexes, date notices and other synthetic context remain available to the answering model without selecting its routing tier or subagent identity. Synthetic context alone does not activate sticky routing; actual conversation history retains that behavior.

Tests: [tests/router](../../tests/router). See the [test guide](../../docs/testing.md) for runner selection.
