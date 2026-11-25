# Router settings API

Routing settings use authenticated GET/PUT `/api/config` and POST `/api/config/validate`. Shared snapshot, masking, revision, persistence and error rules are defined by the [configuration API](../model-pool-settings-api.md#configuration-reads-and-writes). A validation request has no write/reload effects; PUT has no dedicated idempotency key.

## Fields

[parseRouterConfig](../../src/router/config/parseRouterConfig.ts) and its [schema](../../src/router/config/schema.ts) define defaults and diagnostics.

| Path | Contract |
| --- | --- |
| router.enabled | Boolean, default true; false bypasses inactive router subconfiguration validation |
| router.scenarios.default | Configured provider/model reference |
| router.tokenSaver.judge | Configured judge model |
| router.tokenSaver.enabled | Boolean, default true; disabled settings are retained |
| router.tokenSaver.defaultTier | Name present in the nonempty tiers map |
| router.tokenSaver.tiers.<name>.model | Configured model reference; each tier is an object |
| router.tokenSaver.tiers.<name>.description | String; built-in description when omitted |
| router.tokenSaver.subagent.policy | skip or judge |
| router.tokenSaver.judgeTimeoutMs | Positive integer milliseconds |
| router.tokenSaver.cacheAwareSwitching.minSavingsRatio | Minimum fractional input savings required to switch an eligible prior model; defaults to 0 |
| router.stats.enabled | Boolean, default true |
| router.stats.modelPricing.<provider/model>.input | Finite nonnegative input price |
| router.stats.modelPricing.<provider/model>.output | Finite nonnegative output price |
| router.stats.modelPricing.<provider/model>.cacheRead | Finite nonnegative cache-read price |
| router.stats.modelPricing.<provider/model>.unit | Optional currency: USD or CNY per million tokens; no currency conversion |
| router.stats.baselineModel | Configured {provider, model} reference; supported legacy provider/model strings are normalized |

The existing wire values for unit are `$/\u767e\u4e07 Token` and `\u00a5/\u767e\u4e07 Token` (JSON escapes shown). Omission means USD for display without rewriting YAML. Do not translate these protocol literals or infer a cacheWrite backend field. Pricing keys must reference configured models. Prices retain their configured currency, and Auto compares input costs only within one currency.

The baseline model takes precedence over scenarios.default for unrouted cost comparison. agent.subagents.default belongs to agent configuration: inherit or omission uses agent.model; an unresolvable explicit value produces a warning and inherits rather than becoming fatal. judge policy sends subagents through Token Saver; skip bypasses that decision.

## Candidate order and failover

Auto uses the same candidate order when the preferred model cannot handle the request and when an eligible failure occurs before output. It starts with the judged tier, followed by each higher configured tier in Simple, Medium, Complex, and Reasoning order. Custom tier names follow the standard tiers in declaration order. If the route has no judged tier, its preferred model comes first, followed by all configured tiers. Each provider/model pair appears once.

The model pool follows the configured tiers. Models assigned exclusively to lower tiers are excluded from pool recovery for that request. Auto checks streaming, system prompt, tool and media compatibility before dispatch. Within each currency, pool models with complete configured input and output prices are ranked by the sum of those unit prices, representing equal quantities of input and output tokens. The currency positions follow the stable provider/model ordering, and models without complete prices come last.

For pre-output failover, a confirmed endpoint or shared credential failure excludes the affected provider for the rest of the turn. Model-specific errors exclude the failed model. When healthy candidates cannot carry the request's media, Auto can probe one compatible candidate with an open circuit before considering text placeholders. It can also probe one remaining candidate if all circuits are open. A target stays preferred on subsequent calls in the same AgentLoop run while it meets the request requirements, including continuations after an output limit.

Across user turns, Auto compares the input cost of the judged tier's preferred model against the last call that completed with an answer or tool call. Output truncated by the model's length limit does not replace this observation. Both models must meet the request requirements, the previous model must be assigned to the judged tier or a higher tier, and their input prices must be comparable. Auto uses a price configured for the exact provider and model ID or a matching built-in price. Without two comparable input prices it follows the judged tier. It estimates the previous model's input cost using the observed cache hit ratio. A zero or unreported cache read is estimated at full input price. Auxiliary calls have their own session observations. Manual selections and disabled routing use a single target.

The Router checks oversized inline images against the target model's byte and format limits after attempting compression. Candidate selection, cost comparison and dispatch share this rule. If the image count still exceeds the target's limit, recent messages take priority over older images. The outgoing request retains message order and the transcript retains the original media.

Configuration saves preserve the legacy `router.fallback` and `router.tokenSaver.cacheAwareSwitching.enabled` fields. Auto ignores these fields silently. Model reference changes leave the retired list untouched.

## Consistency and errors

- Raw YAML must parse to an object and preserves complete configuration sections. Structured config restores masked secrets and validates references before writing/reload.
- withPilotDeckConfigWrite serializes changes. A stale baseRevision returns 409 CONFIG_CONFLICT/currentRevision. Do not invent a fixed HTTP/reload timeout; the reloader and Gateway own that policy.
- A provider/model rename atomically updates scenarios, judge, tiers, pricing keys and baselineModel along with other consumers. Display-only renames do not rewrite references. Preserve prices; reject referenced deletions with 409 MODEL_IN_USE.
- Syntax/type/reference/mask failures return 400; write/reload exceptions return 500. Parser diagnostics include ROUTER_ENABLED_INVALID, ROUTER_REF_FORMAT, ROUTER_REF_PROVIDER_NOT_FOUND, ROUTER_REF_MODEL_NOT_FOUND, ROUTER_TOKEN_SAVER_DEFAULT_TIER_UNKNOWN and ROUTER_TOKEN_SAVER_SUBAGENT_POLICY_INVALID.
- A successful save returns the reread disk snapshot and broadcasts pilotdeck:config-broadcast. Never fabricate a success snapshot after failure.

Implementation: [RouterRuntime](../../src/router/RouterRuntime.ts), [configuration service](../../ui/server/services/pilotdeckConfig.js), [settings hook](../../ui/src/hooks/usePilotDeckConfig.ts), [pricing](../../src/router/utils/modelPricing.ts). Validate through [router tests](../../tests/router) and [configuration route tests](../../ui/server/routes/config.test.js), including disabled routing, invalid tiers, rename/reference synchronization, price units and revision conflicts.
