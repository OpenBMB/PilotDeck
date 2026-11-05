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
| router.stats.enabled | Boolean, default true |
| router.stats.modelPricing.<provider/model>.input | Finite nonnegative input price |
| router.stats.modelPricing.<provider/model>.output | Finite nonnegative output price |
| router.stats.modelPricing.<provider/model>.cacheRead | Finite nonnegative cache-read price |
| router.stats.modelPricing.<provider/model>.unit | Optional display metadata: USD or CNY per million tokens; no currency conversion |
| router.stats.baselineModel | Configured {provider, model} reference; supported legacy provider/model strings are normalized |

The existing wire values for unit are `$/\u767e\u4e07 Token` and `\u00a5/\u767e\u4e07 Token` (JSON escapes shown). Omission means USD for display without rewriting YAML. Do not translate these protocol literals or infer a cacheWrite backend field. Pricing keys must reference configured models; calculations continue to use input/output/cacheRead numeric values independently of display metadata.

The baseline model takes precedence over scenarios.default for unrouted cost comparison. agent.subagents.default belongs to agent configuration: inherit or omission uses agent.model; an unresolvable explicit value produces a warning and inherits rather than becoming fatal. judge policy sends subagents through Token Saver; skip bypasses that decision.

## Consistency and errors

- Raw YAML must parse to an object and preserves complete configuration sections. Structured config restores masked secrets and validates references before writing/reload.
- withPilotDeckConfigWrite serializes changes. A stale baseRevision returns 409 CONFIG_CONFLICT/currentRevision. Do not invent a fixed HTTP/reload timeout; the reloader and Gateway own that policy.
- A provider/model rename atomically updates scenarios, fallback lists, judge, tiers, pricing keys and baselineModel along with other consumers. Display-only renames do not rewrite references. Preserve prices; reject referenced deletions with 409 MODEL_IN_USE.
- Syntax/type/reference/mask failures return 400; write/reload exceptions return 500. Parser diagnostics include ROUTER_ENABLED_INVALID, ROUTER_REF_FORMAT, ROUTER_REF_PROVIDER_NOT_FOUND, ROUTER_REF_MODEL_NOT_FOUND, ROUTER_TOKEN_SAVER_DEFAULT_TIER_UNKNOWN and ROUTER_TOKEN_SAVER_SUBAGENT_POLICY_INVALID.
- A successful save returns the reread disk snapshot and broadcasts pilotdeck:config-broadcast. Never fabricate a success snapshot after failure.

Implementation: [RouterRuntime](../../src/router/RouterRuntime.ts), [configuration service](../../ui/server/services/pilotdeckConfig.js), [settings hook](../../ui/src/hooks/usePilotDeckConfig.ts), [pricing](../../src/router/utils/modelPricing.ts). Validate through [router tests](../../tests/router) and [configuration route tests](../../ui/server/routes/config.test.js), including disabled routing, invalid tiers, rename/reference synchronization, price units and revision conflicts.
