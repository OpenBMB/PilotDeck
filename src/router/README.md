# Model routing

Chooses model routes and orchestrates provider health, model-pool failover and configured routing policy.

Entry points: [index.ts](index.ts), [RouterRuntime.ts](RouterRuntime.ts).

Auto starts at the judged tier and searches the configured tiers from Simple through Medium, Complex, and Reasoning. The same order applies to capability checks and pre-output failover. The model pool follows the tier candidates. Models assigned exclusively below the judged tier stay outside the candidate list. A successful model remains preferred within the same AgentLoop run while it can handle the next request.

Auto skips the affected provider for the rest of the turn when a failure is tied to its endpoint or shared credentials. Other failures exclude just the failed model when switching. A pre-output failover can try up to five distinct alternatives after the first attempt. Explicit selections and disabled routing use a single target. See the [routing contract](../../docs/trd/53-router-settings-api.md#candidate-order-and-failover) for price ordering and tier rules.

Uploaded images and images read by tools stay in conversation history as image blocks or stored-media references. The final request uses text placeholders for images it cannot send when no compatible Auto route is available. The agent reports that omission during the turn.

Auto compares compatible models' input costs within a currency. The previous model must be assigned to the judged tier or a higher tier. The comparison uses the latest successful call's provider-reported cache hit ratio, with full input pricing when cache reads are zero or unreported. Main-agent and auxiliary calls keep separate observations. A failed or incomplete attempt leaves the previous observation in place.

Turn cancellation reaches judge requests and retry delays. Optional execution callbacks project resolved context for each selected/fallback model and finalize it after routing patches and media conversion. Cache identity follows the final request; provider changes never reuse another model's plan. Callers without these callbacks retain the ordinary canonical-request interface.

Task classification and legacy subagent tags read actual user requests through the shared model-message predicate. Request-only memory, artifact indexes, date notices and other synthetic context remain available to the answering model without selecting its routing tier or subagent identity. Synthetic context alone does not activate sticky routing; actual conversation history retains that behavior.

Tests: [tests/router](../../tests/router). See the [test guide](../../docs/testing.md) for runner selection.
