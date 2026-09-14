# HALO: health-aware outage recovery

Baseline: `cfc4d1779228f91fececc5d6705c14dab5b7ef2f` (`origin/integration`, 2026-09-11). The repository contained no `AGENTS.md` at kickoff.

## Source audit answers

- Retryable provider errors are HTTP 408, 409, 429 and 5xx, plus normalized rate-limit, overloaded, timeout, server, DNS, reset, refused and proxy failures. Fallback additionally accepts billing, model-not-found, auth and invalid-tool-arguments. Context/payload recovery flags and context overflow are excluded from fallback and remain on existing compaction/image-strip paths.
- Before HALO, `ModelRuntime` performed its configured transport retries (default two), then `RouterRuntime` tried the next static fallback before its own transient retry. The counters reset for each model. With HALO enabled, transport retries are set to zero per dispatch so one RouterRuntime budget owns the chain. A 429 chooses an actually executable independent endpoint first; if none exists, it retries the current endpoint only when the complete provider Retry-After fits the remaining deadline. Other service failures get at most the configured same-route transient retry before fallback. Credential errors never retry the same provider identity.
- Any emitted text, thinking delta, or tool-call start/delta/end makes replay unsafe. RouterRuntime locks to the current attempt from that point. Completed side-effecting tools occur above this model-stream layer; HALO never replays after even the first tool-call event.
- HALO health is scoped to one RouterRuntime (therefore shared by sessions/requests in the process). Its key is protocol plus normalized endpoint URL, with credentials, query and fragment removed. Defaults: 128 records, 15-minute idle TTL, 20-result window, degraded after two consecutive service failures, open after three, 30-second exponentially increasing cooldown capped at five minutes. After cooldown, exactly one concurrent half-open probe is admitted. Success closes the circuit. Cancellation, request/task-quality errors and unknown errors are not counted as provider failures.
- HALO filters fallback candidates for tool use, streaming, system prompts, thinking, JSON schema and estimated context capacity before dispatch. Existing media handling remains: native-capable candidates are preferred, then the existing explicit downgrade path is retained.
- `recovery.maxAttempts` counts every RouterRuntime dispatch, including empty-response retries and fallbacks. HALO disables hidden transport retries for those dispatches. `recovery.deadlineMs` wraps each in-flight stream with a remaining-time abort and prevents a backoff whose delay would consume the remainder. Both cover the entire chain.

## Reproduced baseline pain

The deterministic `shared_failed_endpoint_then_healthy` scenario configures `a` and `b` as aliases of one rate-limited endpoint and `c` as independent and healthy. Static recovery dispatches `a -> b -> c`; HALO dispatches `a -> c`. This reproduces the redundant shared-failure-domain call in the real RouterRuntime path, not a separate policy mock.

## Configuration

HALO is opt-in and preserves existing behavior by default:

```yaml
router:
  recovery:
    enabled: true
    maxAttempts: 6
    deadlineMs: 30000
    health:
      capacity: 128
      recordTtlMs: 900000
      openDurationMs: 30000
      maxOpenDurationMs: 300000
      degradeThreshold: 2
      openThreshold: 3
      windowSize: 20
```

## Reproduction commands

```powershell
corepack pnpm install --registry=https://registry.npmmirror.com --frozen-lockfile
npm run build
node --test "dist/tests/router/halo-health.spec.js" "dist/tests/router/halo-recovery.spec.js" "dist/tests/router/config-parser.spec.js" "dist/tests/router/cache-plan-routing.spec.js"
node dist/scripts/halo-fault-experiment.mjs artifacts/halo
```

The experiment uses seed `20260911`, fixed scripts, a virtual logical clock and the same four-dispatch/10-second budget for both policies. It makes no network or paid model calls.

## Experiment result

| Scenario | Static attempts / invalid | HALO attempts / invalid | Static time | HALO time | Outcome |
|---|---:|---:|---:|---:|---|
| Healthy | 1 / 0 | 1 / 0 | 80 ms | 80 ms | both succeed |
| First failure, second recovers | 2 / 0 | 2 / 0 | 180 ms | 180 ms | both recover |
| Shared failed endpoint, healthy independent | 3 / 1 | 2 / 0 | 280 ms | 180 ms | both recover |
| Persistent shared 429 | 3 / 2 | 1 / 0 | 300 ms | 100 ms | both fail correctly |
| Persistent independent 5xx | 3 / 0 | 3 / 0 | 300 ms | 300 ms | both fail correctly |
| Partial stream failure | 1 / 0 | 1 / 0 | 100 ms | 100 ms | no unsafe replay |
| Tool call then failure | 1 / 0 | 1 / 0 | 100 ms | 100 ms | no unsafe replay |

On the recoverable shared-endpoint case, injected recovery time falls from 180 ms to 80 ms (55.6%) and invalid retries from one to zero (100%). Healthy logical overhead is zero additional dispatches and zero injected milliseconds. These are deterministic fault-injection results for the stated distribution, not online reliability evidence. Sample sizes are too small for a P95 claim; raw per-scenario observations are retained in `artifacts/halo/attempt-traces.jsonl`. Actual provider cost is unavailable; the JSON reports estimated and actual cost separately (`actualRecoveryCost: null`).

## Agent A and D integration

- Agent A continues to own the primary decision. HALO only reorders compatible configured fallback candidates after a failure; explicit scenario fallback semantics remain unchanged (`planFallback` still returns no fallbacks for `explicit`). Candidate availability is `state`, smoothed success rate `(successes + 2) / (samples + 4)`, latency EWMA (`0.8 old + 0.2 new`), cooldown remaining and endpoint identity. Ranking uncertainty is highest at cold start; equal cold candidates retain configuration order.
- Agent D can subscribe to `pilotdeck_router_attempt`. `start` contains global attempt number, provider/model and sanitized failure domain. `end` adds latency, error code, usage and finish reason. Existing fallback and retry-progress events remain unchanged.

## Limits and negative results

- Independent persistent 5xx showed no improvement; HALO intentionally retained all independent candidates. More aggressive suppression would reduce recovery opportunity.
- No answer-quality prediction was added. HTTP success updates availability only, never task/model quality.
- Cost is a small tie-breaker after endpoint health and independence; no learned policy was introduced.
- The latest full Windows spec run completed 521 tests with 495 pass, 22 fail, 3 cancelled and 1 skipped. Failures observed were pre-existing environment-sensitive Windows path separator, permission, timing, missing environment-variable, and Git safe-directory cases. HALO's latest targeted run passed 23/23, including full Retry-After and disabled-thinking compatibility regressions.
