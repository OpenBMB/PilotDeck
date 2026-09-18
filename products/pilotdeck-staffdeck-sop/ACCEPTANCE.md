# PilotDeck + StaffDeck SOP Acceptance

Date: 2026-09-18

## Scope

This profile composes PilotDeck AgentLoop, tools, and model providers with the
portable StaffDeck SOP runtime. Preserving existing module semantics is a
release requirement, not a conclusion established by the passing tests below.

## Acceptance Decision

Final acceptance is **READY** for the declared fixed composition as of the
2026-09-18 review. The exported-container deployment, recovery, browser,
real-model path, protocol regression, and independent StaffDeck v3 owner oracle
all pass. The retired historical legacy-versus-sidecar runner is not an
acceptance dependency for this profile.

A focused diagnostic reproduced a semantic divergence in the former portable
engine: for a required `name` slot containing three spaces, StaffDeck's
original `slot_is_filled` returns `False`, while that copied implementation
accepted completion. The copied engine has been removed. The HTTP sidecar now
calls StaffDeck's existing `SopResultValidator`, `GraphRules`, and
`SopRuntime`; its whitespace response is `422 REQUIRED_SLOT_MISSING`.
Host-side state projection preserves the terminal frame and clears only the
per-step PilotDeck tool receipts.

See [REMAINING_TEST_PLAN.md](REMAINING_TEST_PLAN.md) for the ordered test plan,
source references, execution prerequisites, and release criteria.

## Passing Gates

These are previously recorded results, not reruns during the acceptance review.

| Gate | Command | Result |
| --- | --- | --- |
| SOP composition and recovery | `npm run test:sop:core` | 16/16 PASS |
| Gateway to real StaffDeck HTTP runtime | `STAFFDECK_SOP_E2E_ENDPOINT=... npm run test:sop:http-e2e` | 7/7 PASS |
| Cross-process handoff/resume | `node products/pilotdeck-staffdeck-sop/scripts/run-process-restart-smoke.mjs` | PASS, duplicate resume rejected |
| StaffDeck portable runtime | `python -m pytest -q portable_sop/tests` | 10/10 PASS |
| Related config/Gateway contracts | focused Node test command | 37/37 PASS |
| Web SOP route | `npm --prefix ui test -- --run server/routes/sop.test.js` | 8/8 PASS |
| Web SOP banner | `npm --prefix ui test -- --run src/components/chat-v2/SopWaitBanner.test.tsx` | 2/2 PASS |
| TypeScript and production UI | `npm run build:web` | PASS |
| Deployment manifest | `PILOTDECK_API_KEY=test-only docker compose -f products/pilotdeck-staffdeck-sop/docker-compose.yml config` | PASS |
| Browser workflow | `read_file -> handoff -> refresh -> resume -> completion` | PASS; one completion reply, no wait banner |

## Current Reruns

| Gate | Command | Result |
| --- | --- | --- |
| StaffDeck adapter core | Containerized direct `prepare`/`submit` against original StaffDeck module | PASS; valid tool/slot advance and whitespace rejection |
| v3 SOP module contract | PilotDeck build and focused tests; portable `pytest`; real HTTP Gateway suite | PASS: `sop.runtime` advertises `sop.lifecycle/v2` protocol `2.0`; envelopes, semantic error pass-through, identity, idempotency, revision fencing, and owner-vs-glue parity passed (`21/21`, `28/28`, `9/9`). |
| Gateway to current adapter | `STAFFDECK_SOP_E2E_ENDPOINT=http://127.0.0.1:18091 node --test --test-force-exit dist/tests/sop/staffdeck-sop-gateway-http-e2e.spec.js` | 9/9 PASS, including enabled -> disabled -> enabled restoration and a declared-but-unbound `lookup_account` fixture path. |
| SOP recovery suite | `node --test --test-force-exit dist/tests/sop/staffdeck-sop-agent-loop.spec.js` | 15/15 PASS, including a child-process `SIGKILL` after reply durability and before delivery-journal cleanup. Recovery re-homes exactly one visible terminal reply without a second model invocation or SOP submission. |
| Cross-process handoff/resume | `node products/pilotdeck-staffdeck-sop/scripts/run-process-restart-smoke.mjs` | PASS; `sopStatus: completed`, duplicate resume rejected |
| YAML export profiles | `export-composition.mjs` plus `docker compose config` | PASS for SOP enabled and disabled profiles; build contexts are inside each export |
| Local browser workflow, current adapter | `run-local-web-smoke.sh` with the Node 22.23.1 runtime; manual browser exercise | PASS at desktop and 390x844: `read_file` permission/tool result -> SOP handoff -> page refresh -> recoverable continuation -> one terminal reply. Mock provider only. |
| Exported SOP-enabled deployment boot | `PILOTDECK_API_KEY=test-only docker compose --project-name pilotdeckexportverify ... up --detach` | PASS: both images built from `/tmp/pilotdeck-export-deploy.qpGccG`; `sop-runtime` became healthy, PilotDeck HTTP returned 200, and its Gateway connected. No model turn was sent. |
| Portable adapter state recovery | isolated Python 3.12 venv, `pytest -q portable_sop/tests` | 22/22 PASS after restoring the native coordinator's `awaiting_user -> active` transition before a completed resumed submission; slot matrix and handoff/wait/transition/capability-receipt contracts preserve original semantics. |
| Original SOP composition contract | isolated Python 3.12 venv, `pytest backend/tests_harness/test_composition.py backend/tests_harness/modules/test_sop_definition.py` | 16/16 PASS: current StaffDeck owner supports sub-SOP definition metadata and cycle validation; adapter projects `subSopId` without inventing lifecycle entry/return behavior. |
| Exported SOP-disabled deployment boot | `pilotdeck-only.yaml` export, `docker compose --project-name pilotdeckdisabledverify up --detach` | PASS: Compose contained only `pilotdeck`; HTTP and Gateway started without any StaffDeck service. |
| Module profile validation | Node 22, `node --test --test-force-exit dist/tests/pilot/config/modules-config.spec.js` | 6/6 PASS: absent modules, disabled SOP, unsupported ownership, and invalid endpoint/definition/default-id/timeout fail or resolve before startup as specified. |
| Mounted profile restart | shared-volume Compose project `profileflipverify`: disabled -> enabled -> disabled | PASS: the mounted YAML took effect after each restart; `sop-runtime` appeared only for the enabled profile and became healthy. `auth.db` remained in the reused volume. |
| SOP wait UI race guards | `npm --prefix ui test -- --run src/components/chat-v2/SopWaitBanner.test.tsx` | 4/4 PASS: double-click submits one resume request; delayed status from a prior session cannot replace the current banner. |
| Browser stale-tab handoff | local mock-provider deployment, two tabs on one handoff session | PASS: one tab accepted and prepared the continuation; the other tab's stale acceptance was rejected with no second continuation. |
| Browser interruption and profile behavior | `run-local-web-smoke.sh` with the deterministic local model/SOP adapter | PASS: desktop and 390x844 complete `read_file -> handoff -> refresh -> continuation -> terminal`; an offline status request shows `Failed to fetch` and reconnect preserves the same wait; waiting/completed session switching does not leak a banner; `PILOTDECK_WEB_SMOKE_SOP_ENABLED=false` completes ordinary `read_file` chat without SOP control UI. |
| Real-model tool/SOP workflow | local PilotDeck home + real `provider1/qwen3.6-flash-distill` + original StaffDeck adapter | PASS: real `read_file -> handoff -> host resume -> completed`; sanitized Gateway event summary contains successful `tool_call_finished` for `read_file`, and persisted SOP state is `completed`. |
| Exported real-model Compose workflow | fresh `operator_approval` export, Docker Compose, `provider1/qwen3.6-flash-distill`, browser | PASS for deployment/restart/recovery: real-model handoff survived independent SOP and PilotDeck restarts; browser refresh restored the same wait and UI resume returned it to the ordinary AgentLoop path, where the real model completed the SOP. A stopped SOP sidecar returned actionable `StaffDeck SOP runtime request failed: fetch failed` without state advance; the same persisted session completed after recovery. The shipped definition declares no `lookup_account` binding. Exported UI single-reply coverage remains listed in `REMAINING_TEST_PLAN.md`. |
| Exported browser UI smoke | `run-exported-web-smoke.mjs` using the local deterministic OpenAI-compatible model | PASS: a fresh export built and ran in Compose. At 1280x900 and 390x844, browser handoff survived refresh, UI resume prepared the ordinary composer turn, and exactly one terminal reply was rendered without a residual wait banner. A stale second tab could not prepare another continuation; a completed and waiting session did not leak banners; exported screenshots were retained and the test project, network, and volume were removed. |
| Exported SOP-disabled browser smoke | `PILOTDECK_EXPORTED_WEB_SOP_ENABLED=false run-exported-web-smoke.mjs` | PASS: the export contained only PilotDeck. At 1280x900 and 390x844, the browser explicitly selected Full Access, executed the ordinary PilotDeck `read_file` tool turn, rendered one terminal reply, and never rendered the SOP wait banner. |
| Malformed profile rejection | temporary malformed `pilotdeck.yaml` via `loadPilotConfig` | PASS: rejected before startup with `CONFIG_YAML_INVALID`; no runtime was created. |

Compose `config` validates manifest parsing only. The mock-browser and local
real-model checks are intentionally complementary to the exported generic SOP
deployment: the default export does not include account onboarding or
`lookup_account`. This closes LIVE-01 for the declared profile. SEM-01 remains
the direct v3 owner-versus-glue matrix described in `REMAINING_TEST_PLAN.md`.

`./products/pilotdeck-staffdeck-sop/scripts/run-local-e2e.sh` runs the first
three deterministic gates together against a real local StaffDeck HTTP
process.

The recovery suite covers:

- an ordinary PilotDeck tool failure followed by a successful retry in the
  same session;
- model stream interruption and explicit cancellation without SOP progress;
- recovery after a successful tool result but before SOP submission;
- recovery after SOP state commit but before reply durability;
- recovery after reply durability but before the terminal event, including a
  child-process `SIGKILL` before delivery-journal cleanup, with one visible
  reply after transcript replay and no second model/SOP invocation.
- persisted v1/v2 SOP waits and pending deliveries migrating to v3 without
  losing their revision, wait identity, slots, or delivery record;
- invalid JSON being rejected without silently overwriting it with a new SOP
  session.

The current browser rerun was executed against the current StaffDeck adapter,
not the removed copied runtime. It covers desktop/mobile refresh recovery,
disconnect/reconnect, session isolation, and the SOP-disabled profile. The
component suite and two-tab run cover synchronous double-click and stale-tab
resume rejection.

## Retired Historical Runner

Historical StaffDeck legacy-versus-sidecar parity is not a gate for this v3
composition. The requested
StaffDeck checkout at `/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop`
tracks `codex/dsh-pluggable-runtime` but does not contain either required
entrypoint:

- `tools/agent-loop-parity/run.py`
- `tools/real-deployment-e2e.py`

That historical comparison remains unavailable without a ported baseline.
Original SOP module sources and tests are instead the owner oracle for the
current v3 module-contract comparison.

On 2026-09-17, a side-effect-free `pure_text` probe ran the preserved historical
runner against the current two checkouts. After its test-only import path was
made aware of the current `backend/src`, both historical adapter modes failed
before executing a turn because current `app.core.turn_coordinator` no longer
exports the runner's required `TurnPlanner` API. The runner reported two
`BLOCKED` adapters (exit `2`) and no semantic comparison. This confirms that
the runner is an adapter/API-porting task, not an untested deployment failure.

The target's actual engine routing confirms that this cannot be repaired by a
test-only import alias: `AgentLoop._open_engine()` always selects `EngineHost`,
and `EngineHost.open()` explicitly rejects `engine.harness_v2` as
`HARNESS_V2_RETIRED`. Only `engine.harness_v3` is a live execution owner. The
historical runner's legacy-vs-sidecar mode switch therefore has no valid pair
to execute here. Reinstating a legacy route merely for parity would change the
module-selection semantics being accepted; a replacement requires an approved
baseline and mapping rather than a fabricated second path.
# v3 Candidate Addendum (2026-09-17)

This addendum is the current candidate evidence. It is deliberately separate
from the historical entries below. Scope is the fixed composition: PilotDeck
AgentLoop, tools, and model provider plus the StaffDeck `operator_approval`
SOP. It does not deploy account onboarding, `lookup_account`, or unimplemented
sub-SOP execution.

| Gate | Command / result | Status |
| --- | --- | --- |
| PilotDeck protocol and loop regression | `npm run build`; `node --test --test-force-exit dist/tests/sop/staffdeck-sop-client.spec.js dist/tests/sop/staffdeck-sop-agent-loop.spec.js` | PASS, 25/25. Includes malformed operation payloads, legal owner `null` optional fields, timeout/cancel retryability, error projection, revision fencing, and no reply-journal mutation on rejection. |
| Portable SOP and independent owner oracle | `PYTHONPATH=portable_sop/src:backend:backend/src ... pytest -q portable_sop/tests` | PASS, 49/49. `test_owner_contract.py` invokes native `SopRuntimeModule.submission_validator()`, `build().after_execution()`, and `GraphRules`; it does not use portable `prepare`/`submit` to construct expected values. |
| StaffDeck SOP owner tests | `PYTHONPATH=backend:backend/src ... pytest -q backend/tests_harness/test_composition.py backend/tests_harness/modules/test_sop_definition.py` | PASS, 16/16. Sub-SOP coverage remains metadata/validation only because this owner has no child execution lifecycle. |
| Fresh enabled export, browser and recovery | `run-exported-web-smoke.mjs` with Chrome executable, artifacts `/tmp/pilotdeck-v3-enabled-artifacts/result.json` | PASS. 1280x900 and 390x844 handoff/refresh/UI resume/one terminal reply, stale-tab rejection and session isolation. While waiting, PilotDeck and `sop-runtime` were restarted and retained the wait id; stopping the sidecar rejected completion without state advance, then the same session completed after recovery. Screenshots are in that artifact directory. |
| Fresh disabled export, browser | `PILOTDECK_EXPORTED_WEB_SOP_ENABLED=false run-exported-web-smoke.mjs`, artifacts `/tmp/pilotdeck-v3-disabled-artifacts/result.json` | PASS. 1280x900 and 390x844 executed the ordinary `read_file` tool flow with no SOP service or wait banner. |
| Exported Compose real provider | `PILOTDECK_EXPORTED_WEB_REAL_MODEL=1 ... run-exported-web-smoke.mjs`; artifacts `/tmp/pilotdeck-v3-real-model-artifacts/result.json` and `real-model-completed.png` | PASS. A newly exported Compose deployment used `provider1/qwen3.6-flash-distill`; the browser submitted the initial turn, entered StaffDeck handoff, resumed through the SOP UI, and reached structured `completed` without relying on exact generated wording. The temporary YAML contained only `${PILOTDECK_REAL_MODEL_API_KEY}`; the credential was injected through the Compose process environment and was not printed or copied. Containers, network, and volume were removed. |

The sidecar receives `idempotencyKey` in the v2 envelope, but this candidate
does **not** claim durable server-side idempotency/deduplication was verified.
The owner comparison above is an independent v3 contract oracle; the older
adapter-direct-call comparison remains only a transport regression.
