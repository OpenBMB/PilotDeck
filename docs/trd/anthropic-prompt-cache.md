# Anthropic prompt-cache contract

Scope: canonical request assembly through Anthropic Messages conversion. Entry points: [CachePlan](../../src/context/cache/CachePlan.ts), [context runtime](../../src/context/DefaultContextRuntime.ts), [Anthropic request adapter](../../src/model/providers/anthropic/request.ts), [RouterRuntime](../../src/router/RouterRuntime.ts), [canonical types](../../src/model/protocol/canonical.ts), and [continuation requests](../../src/model/streaming/continuationRequest.ts).

## Cache markers

1. Enable only for the actual anthropic protocol and supportsPromptCache=true.
2. Default layout is system + recent3: one system breakpoint and one on each of the last three projected non-system messages. Select positions without filtering pending tool calls/results, permissions or elicitation messages.
3. Never mark thinking blocks. Fall back to the nearest cacheable block, or skip a thinking-only message.
4. Tool schemas have no breakpoint by default. Explicit cachePlan.tools=true remains supported and limits message breakpoints to two.
5. Markers use ttl=5m; at most four per request. cache_control belongs only in provider requests, never canonical transcripts.
6. System, tool schema, provider, model or selected-message changes alter the fixed-length SHA-256 fingerprint. Do not retain media base64/full inputs in the plan. Compaction and routing changes cannot reuse incompatible plans.
7. Plan reminders are appended after real-message projection and memory retrieval. Recompute recent3 against the final request.
8. A streaming continuation that appends partial assistant content/instructions must recompute or clear old provider-boundary indices.

## Projection and date state

Recompute after projection; trimming and compaction advance the generation. Pin the system prompt UTC date at the first committed request assembly. Normal additions, retries and crossing midnight do not refresh it. Only a new full-summary compaction checkpoint refreshes it on the next committed assembly; local trimming, micro-compaction and repeated projection do not.

After a UTC day change, append a synthetic date_update request message. Keep its position for later same-day requests rather than disturbing an unchanged prefix. Clear old date messages after a full compaction refreshes the system date. Local rewrites preserve unaffected prefix messages and replace affected date messages at the new tail when needed, respecting tool pairing. Date messages are request projections only: do not persist them in user transcripts or feed them to memory retrieval.

previewOnly budget assembly includes candidate date messages but does not commit dates, history summaries, cache generations or pending compaction resets. Date anchors live with their runtime and reinitialize when it is rebuilt.

Router provider/model changes and message-count-changing continuations clear stale plans. Unsupported models/providers use normal requests without markers. TTL is fixed, not a newly exposed setting.

Validation: [cache plans](../../tests/context/cache-plan.spec.ts), [context cache runtime](../../tests/context/cache-runtime.spec.ts), [Anthropic conversion](../../tests/model/request/anthropic-cache-plan.spec.ts), [plan-mode projection](../../tests/agent/loop/model-override-defaults.spec.ts), [continuations](../../tests/model/streaming/continuation-cache.spec.ts). Offline tests establish request structure and isolation; live cache-hit rates are separate external-provider acceptance.
