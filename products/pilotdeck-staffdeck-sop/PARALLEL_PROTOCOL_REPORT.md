# G2 Parallel Protocol Report

Scope: PilotDeck composition/configuration boundary and `tests/composition`.
StaffDeck SOP/Knowledge remain external protocol owners. This is a G2
third-party protocol/conformance report, not an owner-parity or whole-program
sign-off.

## Snapshot

- PilotDeck B0: `ecedc5c32f2b8c8e5387cb2faba70cccf65650fd`
- StaffDeck B0: `7adc7c84f61bd6cca13ff0380a811cbb3ae3c544`
- Candidate inspected: `d9eb6f8af6f33cdaff814e675473106da2b3f134`
- Worktree: `/Users/a1/Desktop/claw/openbmb/PilotDeck-delivery-protocol`
- Fixture transport: local deterministic TCP/HTTP module servers. No model
  credential or external provider is used.

## Focused Result

Command (exit `0`):

```sh
PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH npm run build
PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH node --test --test-force-exit --test-concurrency 1 dist/tests/pilot/config/loadPilotConfig.spec.js dist/tests/pilot/config/modules-config.spec.js dist/tests/composition/http-module-runtime.spec.js dist/tests/composition/unknown-agent-loop-conformance.spec.js dist/tests/composition/external-session-e2e.spec.js dist/tests/composition/external-sidecar-sop-session-e2e.spec.js dist/tests/cli/model-provider-runtime-lifecycle.spec.js
PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH node products/pilotdeck-staffdeck-sop/conformance/run-model-request-b0-differential.mjs
PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH node products/pilotdeck-staffdeck-sop/conformance/run-tool-runtime-b0-differential.mjs
```

The focused runner completed with exit `0`. The expected session-title provider
retries are from intentionally unreachable providers used by Gateway fixtures;
they do not affect the module assertions.

## G2 IDs

| ID | Status | Focused evidence and remaining requirement |
| --- | --- | --- |
| PLUG-01 | PASS | YAML selects native/external bindings. `external-session-e2e` records live Model, Tool, Context, Skill, and Knowledge calls; `external-sidecar-sop-session-e2e` adds SOP over the external AgentLoop path. This is binding conformance only; owner parity is reported by the main task. |
| PLUG-02 | PASS | No factory/allow-list is added for the fixture identities. `unknown-agent-loop-conformance`, `http-module-runtime`, and the sidecar SOP fixture execute a domain operation for all seven slots; wrong identity, missing streaming capability, malformed manifest, and structured failures are rejected. |
| PLUG-03 | PASS | Live Gateway cases cover plain, Knowledge-only, and SOP-only profiles. Disabled Skill/Knowledge modules expose no session tool or remote call. The required-tool SOP profile returns `gateway_submit_failed` before an SOP call when `lookup_approval_record` is absent. |
| PLUG-04 | PASS | `modules-config` rejects incomplete external bindings, invalid contracts/state modes, missing Tool catalog/capabilities, and incompatible identity/configuration combinations without native fallback. |
| PLUG-05 | PASS | `loadPilotConfig` proves rejected external-contract reload retains the active snapshot and diagnostics. `model-provider-runtime-lifecycle` proves a failed candidate does not replace the published runtime, while its existing session/stream lease tests retain the old generation until the session drains. |
| RPC-01 | PASS | `http-module-runtime` rejects bad/contradictory envelopes and preserves `result_unknown` for disconnect, timeout, and cancellation without automatic replay. The sidecar Gateway E2E now blocks a contradictory Knowledge response after SOP state is active, verifies its normalized error reaches the next canonical model request, and proves no SOP submit, wait, terminal status, or corresponding journal field advances. |
| EVID-01 | PASS | Executed `run-model-request-b0-differential.mjs` compares four provider protocols and detects a reversed tool order; executed `run-tool-runtime-b0-differential.mjs` compares five ToolRuntime outcomes and detects a changed error code. B0-to-N0-to-C owner-parity ledger execution belongs to the main task and is not used as a third-party protocol prerequisite here. |

## Change

`tests/pilot/config/loadPilotConfig.spec.ts` verifies that an external module
contract/schema change is rejected during reload without publishing or
replacing the active config snapshot. The test deliberately uses a different
implementation identity to ensure this is not a native-owner allow-list case.

`tests/composition/external-session-e2e.spec.ts` adds a live Knowledge-only
Gateway turn. `tests/composition/external-sidecar-sop-session-e2e.spec.ts`
adds a live SOP-only handoff and a required dependency failure that is visible
at the public Gateway boundary and leaves no SOP state.

The same seven-slot sidecar test injects one contradictory Knowledge response
only after its SOP state is durable. The protocol normalizer exposes
`Successful module response contains failure fields.` in the following
canonical model request. The successful Skill and Tool calls may legitimately
advance `successful_tool_names`; the SOP status remains `active`, wait remains
absent, no SOP `submit` occurs, and the journal status/awaiting fields remain
unchanged.

## Handoff Boundary

The main task still owns the independent B0/N0/C owner-parity ledger and the
G0-G5 aggregate sign-off. This delivery does not repeat every RPC error class
through a persisted SOP state: bad ID/version, timeout, disconnect, and cancel
remain covered at the module adapter boundary in `http-module-runtime`; the
representative contradictory-envelope Gateway/SOP path is the state-projection
evidence added here.
