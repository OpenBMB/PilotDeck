# Telemetry Receiver Contract (`analytics.v2`)

## HTTP request attribution (`x-pilotdeck-*`, schema 1)

HTTP diagnostics are independent of the analytics event body below. They add no
messages, system-prompt text, or tool definitions. Model generation (including
streaming, continuation, title generation, routing and compaction), Web API
requests, uploads, model probes/discovery, and native gateway HTTP responses use
the following vocabulary when the relevant context is available.

| Header | Meaning and lifetime |
| --- | --- |
| `User-Agent` | Server-side model requests: `PilotDeck/<version> (<platform>; <arch>)`. Browsers retain their native UA. |
| `x-pilotdeck-client` | `pilotdeck` on the backend, `web` or `desktop` in the browser. |
| `x-pilotdeck-version`, `x-pilotdeck-build` | Application version and optional `PILOTDECK_GIT_SHA`; version comes from `PILOTDECK_VERSION` or the application package, never the user's project package. |
| `x-pilotdeck-platform`, `x-pilotdeck-arch` | Runtime OS and architecture, without hostname or hardware serial numbers. |
| `x-pilotdeck-schema-version` | `1`; version of this diagnostic vocabulary. |
| `x-pilotdeck-installation-id` | Stable, anonymous ID for a PilotDeck home, shared by its gateway and Web server. |
| `x-pilotdeck-instance-id` | Random ID for the current backend process. Changes on restart. |
| `x-pilotdeck-device-id` | Random browser-profile ID when a browser originated the turn; otherwise the installation ID. It is not a physical-device fingerprint. |
| `x-pilotdeck-user-id` | Anonymous, installation-scoped authenticated local account ID. CLI/headless calls without an account use a local-profile ID. Independent installations cannot identify the same human across devices. |
| `x-pilotdeck-project-id` | Salted digest of the resolved project path. No path or repository URL is transmitted in this header. |
| `x-pilotdeck-session-id`, `x-pilotdeck-turn-id` | Stable conversation and user-turn identifiers. UUIDs remain unchanged; named keys are salted digests because channel/session names may contain personal data. |
| `x-pilotdeck-operation-id` | One model-runtime invocation, stable across its transport retries and endpoint/parameter fallbacks. Router fallback invocations receive new operation IDs while retaining session/turn IDs. |
| `x-pilotdeck-request-id` | One runtime HTTP dispatch. Runtime retries/fallbacks receive new values; SDK-internal retry exceptions are described below. Service responses echo a valid supplied request ID or generate one. |
| `x-pilotdeck-parent-request-id` | Originating Web API request or WebSocket command ID, connecting a user action to model requests. |
| `x-pilotdeck-client-version` | Originating browser bundle version, separate from the backend version. |
| `x-pilotdeck-purpose` | `conversation`, `compaction`, `session-title`, `router-judge`, `token-count`, `model-probe`, `model-discovery`, `web-api`, or `gateway-api`. |

The private random seed is stored in `$PILOT_HOME/request-identity` with owner-only
permissions where supported. Domain-separated HMACs produce public identifiers;
the seed, API keys, gateway tokens, usernames and emails are not sent. Read-only
or damaged identity storage falls back to a process-local seed without blocking
requests; identifiers then do not survive restarts. Copying the whole PilotDeck
home copies its identity too.

Context follows each request/turn via AsyncLocalStorage, not mutable global
"current chat" state. Web authentication derives the user ID from the verified
account and ignores a caller-supplied user header. Headers are diagnostic claims,
never authentication, authorization, billing authority, or idempotency keys.
`request_started.metadata.requestOperationId` correlates model events with wire
headers. Do not use user/session/request IDs as unbounded metrics labels.

Browser requests add headers only to same-origin `/api/` URLs. The server resolves
registered project names and returns opaque project IDs; the browser can echo
them on later requests for that project. Missing context is omitted. A browser
WebSocket cannot set custom handshake headers: its per-message `requestContext`
is carried through normal sends, persisted queued sends and gateway execution.
The gateway's own WebSocket hello already has `clientName`/`clientVersion`; its
default version now uses the actual application version. Shared connections do
not carry one mutable session ID for all their messages.

### Compatibility controls

Set `PILOTDECK_REQUEST_HEADERS=full` (default), `basic`, or `off` before starting
the backend. `basic` sends application/build/platform/schema information and a
per-request ID, without persistent user/device/project/session IDs. `off` omits
automatically generated attribution headers; explicitly configured provider
headers and normal authentication/protocol headers remain unchanged.

For a restrictive model endpoint, set `requestHeadersMode: basic` or `off` in its
provider entry in `pilotdeck.yaml`. The provider override affects generation
and token counting; probes/discovery use the process setting. Global `off` always
wins over provider overrides. The Web server returns
`x-pilotdeck-request-headers-mode`, so an existing UI bundle learns the runtime
setting after its initial same-origin API response. Before that response it uses
the build-time default. Rebuild with the variable set to suppress even the initial
browser request's optional headers.

Configured header names are merged case-insensitively. The generated model wire
request ID is reserved and refreshed per dispatch when attribution is enabled.
Existing retry policies are preserved. Google SDK retries and probe/discovery
internal network retries may reuse a request ID within one runtime dispatch. A successful
response proves acceptance by the configured endpoint, not forwarding or logging
by every intermediary. No automatic retry strips attribution after an error.

### Public implementation references

- [DeepSeek Harness wire extensions](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/deepseek-llm-api-wire-extensions.md): application UA, anonymous user ID, session ID and a compaction marker, outside model-visible content.
- [Pi client identity](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/identity.ts): separates UA/version from provider-specific app attribution. PilotDeck uses its own namespace and does not impersonate another client.
- [OpenClaw provider attribution](https://github.com/openclaw/openclaw/blob/main/src/agents/provider-attribution.ts): destination/provider-specific policies; an SDK header hook alone does not prove that a vendor supports a particular attribution contract.
- [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol): documents session/agent headers and opt-in gateway hints. These are distinct from credentials and the provider's protocol headers.
- [WorkBuddy official product documentation](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Product-Guide): reviewed as product context; no official request-header implementation was verified. Third-party reverse-engineered gateways are not treated as its official contract.

Local mock HTTP tests cover all four supported model protocols. On 2026-10-29,
three live streaming requests to the locally configured `qwen3.8-flash-next`
endpoint, using `off`, `basic` and `full`, all returned HTTP 200 and `OK` with a
normal stop. This is evidence for that configured endpoint only, not a claim of
compatibility with every official API or intermediary.

## Endpoint

- Method: `POST`
- Path: `/collect`
- Content-Type: `application/json`
- Body: `AnalyticsEvent[]`
- Success status: any `2xx`
- Deduplication key: `eventId`

## Delivery Semantics

- At-least-once delivery.
- Client batches events (default 20) and retries failed requests.
- Client persists unsent queue to local JSONL on shutdown and restores on startup.
- Receiver must handle duplicated events idempotently.

## Event Schema

```ts
type AnalyticsEvent = {
  schemaVersion: "analytics.v2";
  eventId: string;
  eventName: "feature_used" | "error_occurred";
  occurredAt: string; // ISO timestamp
  installationId: string; // installation-level identity (stable across shared server-token)
  instanceId: string; // instance-level identity (distinguishes multi-instance same machine)
  deploymentMode:
    | "source"
    | "docker"
    | "curl_installer"
    | "desktop_installer"
    | "npm_binary"
    | "unknown";
  sessionId?: string; // 24-char hex hash of internal sessionKey (not the raw key)
  commitHash: string; // app/runtime commit hash
  appVersion: string;
  platform: string; // process.platform
  properties: Record<string, unknown>;
};
```

## Breaking Change Notes

- `analytics.v2` adds explicit source attribution: `ownerModule`, `executionKind`, and `phase`.
- `module = "router"` now describes router/tokenSaver/judge/fallback health only; real provider requests are reported through `module = "session"` unless they belong to memory/judge direct LLM calls.
- `module = "session"` may include reused agent-loop executions for Always-On, subagents, compaction, or tool-secondary model calls. Use `ownerModule` and `executionKind` to isolate ordinary user sessions.
- Removed field: `projectCommitHash`.
- Removed field: `projectPath` (no filesystem paths in outbound events).
- `sessionId` is now a hashed anonymous id, not the raw `sessionKey` (which may embed paths).
- `error_occurred` no longer includes `message` or `stack`; only classification fields below.
- Removed event types: `app_started`, `session_active` (DAU uses any `feature_used` / `error_occurred`).

## `feature_used` Two-Layer Model

For `eventName = "feature_used"`, `properties` follows:

```ts
type FeatureUsedProperties = {
  /** Business surface being measured. */
  module: "router" | "always_on" | "memory" | "cron_job" | "session";
  /**
   * Business owner of an execution event. For ordinary user chat this is
   * "session"; for Always-On agent loops it is "always_on" even though
   * `module` remains "session".
   */
  ownerModule?: "router" | "always_on" | "memory" | "cron_job" | "session";
  executionKind?:
    | "user_session"
    | "subagent"
    | "always_on"
    | "router_judge"
    | "memory"
    | "cron_job"
    | "compaction"
    | "tool_secondary";
  /** Business phase, e.g. router judge/decision/fallback or Always-On discovery/workspace/execution/report/apply. */
  phase?: string;
  loopStage:
    | "module_event"
    | "loop_start"
    | "model_request"
    | "model_response"
    | "tool_prepare"
    | "tool_call"
    | "permission_check"
    | "loop_end";
  outcome?: "success" | "failed" | "aborted" | "timeout" | "denied";
  errorCategory?:
    | "model_request_error"
    | "permission_error"
    | "tool_param_error"
    | "tool_runtime_error"
    | "tool_result_parse_error"
    | "loop_error"
    | "runtime_error";
  provider?: string;
  model?: string;
  /** HTTP(S) API base from provider config (no userinfo, query, or fragment). */
  providerBaseUrl?: string;
  // plus other module-specific metadata (path-like keys stripped client-side)
  [key: string]: unknown;
};
```

Session `model_request` events are emitted after routing, when the real provider request starts (`model_event` → `request_started`), not at turn submit time.

Ordinary user chat should be queried as:

```sql
properties.module = 'session'
AND properties.ownerModule = 'session'
AND properties.executionKind = 'user_session'
```

Always-On reused agent-loop health should be queried as `module = 'session' AND ownerModule = 'always_on'`, grouped by `phase`.

## `error_occurred` Properties

- `module`: same module space as above plus runtime/ui contexts.
- `ownerModule`, `executionKind`, `phase`: same attribution semantics as `feature_used`.
- `loopStage`: where the error occurred.
- `errorCategory`: normalized category.
- `code`: error code (if available).

No `message`, `stack`, or caller-supplied metadata is included.

## Privacy

- Outbound events must not contain raw filesystem paths.
- Property keys matching path-like names (`path`, `cwd`, `root`, etc.) and absolute-path string values are stripped before upload.

## Aggregation Guidance

- Installation-level active users (DAU): distinct `installationId` per day with any event (`feature_used` or `error_occurred`).
- Instance-level active users: distinct `instanceId` per day.
- Module metrics: group by `properties.module`.
- Ordinary user session metrics: filter by `module=session + ownerModule=session + executionKind=user_session`.
- Loop-stage funnel/error rates: group by `properties.module + properties.loopStage + properties.outcome`.
- Session-scoped funnels: group by hashed `sessionId`.
