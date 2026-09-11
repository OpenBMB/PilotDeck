# Agent D evidence audit

Baseline inspected: `cfc4d1779228f91fececc5d6705c14dab5b7ef2f` on `feat/d-evaluation-ledger-owner`.

## Verified gaps

- `RouterRuntime.execute` previously emitted one `TokenStatsCollector` record only for the final success or final failure. Earlier provider failures, transient retries, zero-usage retries, and attempts superseded by fallback were not individual billing rows.
- `classifyAndRoute` calls `judgeRuntime.complete` up to three times. It emitted generic telemetry stages but did not add Judge usage/cost to router stats.
- When final usage was absent, runtime token estimates were stored without provenance. A consumer could not distinguish provider usage from estimation.
- `TokenStatsCollector.calculateCost` used zero-valued token defaults and fallback prices, so missing usage/pricing was not represented as unknown. Its aggregate therefore is operational telemetry, not a provider-bill reconciliation.
- Existing request duration used a single logical-call start across fallback/retry. It did not expose per-attempt timing. The new ledger records each attempt interval; task latency must use min(start) to max(end), never the sum of concurrent durations.

## Verified non-gaps / qualifications

- OpenAI normalization subtracts cache-read and cache-write tokens from prompt tokens before exposing `inputTokens`, preventing those categories from being charged twice by the new ledger.
- Anthropic usage already exposes input, output, cache-read, and cache-write as separate categories.
- `nativeCost` exists in canonical usage and is preferred by the ledger, including an explicit zero.
- Fallback eligibility excludes context compaction recovery. Compaction is performed in the Agent loop and needs a separate role-aware integration hook; it must not be inferred from a missing router `stats.observe` call.
- Compaction summaries already traverse `RouterRuntime`; their execute context now overrides the accounting role to `compaction`. Retry and fallback remain relationship fields on the same attempt row, so the summary is not charged twice.
- Router-disabled passthrough currently bypasses router stats. Baseline experiments therefore require the shared ledger at the provider boundary or an explicit baseline wrapper; absence from router stats is not evidence that the provider was not called.
- Non-streaming retries in `ModelRuntime.complete` and both OpenAI/Anthropic-compatible and Google retries in `streamModel` now emit distinct content-free provider-attempt callbacks. Judge consumes the non-streaming events without duplicating its logical fallback record. Router ledger de-duplication/wiring still needs to consume streaming callbacks, so a fully provider-reconciled claim remains premature.

## Evidence limitations

No paid/model-backed experiment was run. Historical demos and simulated traces are acceptable only for deterministic pipeline tests, not for cost, quality, or savings claims. Bill consistency may be claimed only for rows with provider-reported cost or provider usage plus a frozen price table, and only after comparison with provider billing exports.
