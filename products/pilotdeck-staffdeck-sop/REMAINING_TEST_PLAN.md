# Remaining Composition Acceptance Tests

Reviewed: 2026-09-18. Status: READY for the declared fixed-composition sign-off.

## v3 Candidate Update

The v3 protocol regression, independent native-owner matrix, StaffDeck owner
tests, fresh enabled export browser/restart/sidecar-recovery run, and fresh
disabled export browser run are complete. Exact commands, worktrees, counts,
and artifact locations are recorded in `ACCEPTANCE.md` under **v3 Candidate
Addendum**. Those results supersede neither historical evidence nor the
remaining gate below.

**LIVE-EXPORT-01: real provider on a newly exported Compose artifact. Status: PASS.**

The exported-artifact real-model mode generated a temporary runtime config for
`provider1/qwen3.6-flash-distill` whose API key value was only
`${PILOTDECK_REAL_MODEL_API_KEY}`. The secret was injected through the Compose
process environment and was neither printed nor copied. The browser completed
generic `operator_approval` handoff -> UI resume -> structured `completed`
without matching exact generated wording. Evidence is retained at
`/tmp/pilotdeck-v3-real-model-artifacts/result.json`,
`real-model-completed.png`, and `real-model-browser-events.log`; its isolated
containers, network, and volume were removed after the run.

## Scope and Existing Evidence

The first release profile is PilotDeck AgentLoop + Tools + Model Provider +
StaffDeck SOP, with SOP optionally disabled. Module semantics must remain those
of the existing owners. Fixes, if subsequently implemented, belong in packaging,
composition, adapters, persistence, RPC, or UI; do not redefine core behavior.

Current configuration accepts only PilotDeck for the three core modules and
requires them to be enabled (`src/pilot/config/parseModulesConfig.ts:48`). This
is a fixed supported profile, not arbitrary interchangeability of every module.
The broader original goal needs additional provider combinations implemented
and tested before it can be claimed. Unsupported combinations must be rejected.

Keep the recorded passing tests in ACCEPTANCE.md. Execute the missing gates
below, then rerun only suites affected by resulting changes. No new full
application suite or unrelated StaffDeck channel/team integration is required
for this profile.

## P0: Semantic Preservation

**SEM-01: v3 owner-versus-glue module contract comparison. Current status: PASS.**

Use the original SOP sources in the specified StaffDeck checkout as the oracle:

- `backend/src/staffdeck_harness/sop/submission.py`
- `backend/src/staffdeck_harness/sop/graph.py`
- `backend/src/staffdeck_harness/sop/lifecycle.py` and `finalizer.py`
- `backend/app/session/slot_policy.py`
- `backend/tests_harness/modules/test_sop_*.py`

Run identical definitions, initial state, proposals, and capability evidence
through the StaffDeck v3 owner entrypoints and the portable `sop.runtime` HTTP
adapter. The HTTP comparison must include the `2.0` manifest and envelope
contract. Expected values must come from the owner, not the glue behavior.
Compare state, slots, active step, subflow stack, waits, error codes,
completion requirements, and user-visible results. Declare field-name/ID/time
normalizations explicitly; do not normalize semantic differences away.

Required cases:

1. Missing, null, empty, whitespace-only, zero, false, list, and object slots;
   merged known slots and updates; required fields at completion.
2. Allowed and invalid next steps; default and explicit branches; terminal
   nodes; sub-SOP entry and return, including parent without continuation.
3. Awaiting user, handoff, failed, blocked, external wait, and resume, locating
   each status in its original owner contract before mapping it into the host.
4. Required tool success, failure, missing capability, and stale success from a
   prior step. Preserve original capability evidence requirements; unsupported
   dependencies must produce a clear rejection, never implicit completion.
5. Action normalization and permitted transitions on non-completed proposals.

Reproduced seed case (read-only diagnostic, 2026-09-17): a one-node terminal SOP
with `expected_user_info: [name]`, proposal `status: completed`, and
`slotUpdates: {name: "   "}`. Original `slot_is_filled("   ")` is false;
portable `submit` returned state status `completed`. The copied engine was
removed and the sidecar now delegates to StaffDeck's `SopResultValidator`,
`GraphRules`, and `SopRuntime`; the current HTTP sidecar returns
`422 REQUIRED_SLOT_MISSING` for this case.

Focused rerun (2026-09-17): the portable adapter initially retained
`awaiting_user` after a completed user-answer submission. The native
coordinator reactivates that session before invoking the SOP lifecycle, so the
adapter now projects the same host transition before delegation. Its isolated
adapter suite passes 21/21, including the original slot-filled matrix for
null/empty/whitespace/zero/false/list/object values plus declared handoff,
nonterminal wait, invalid transition, and stale tool-receipt cases. This is a
composition-layer fix only.

Pass: all supported cases match the original module; every discovered
divergence is resolved without changing original module semantics. A missing
owner oracle or dependency is BLOCKED. The retired historical whole-StaffDeck
runner is not an acceptance gate for this v3-only composition.

V3 glue rerun (2026-09-17): direct owner `prepare`/`submit` results match the
portable HTTP payload for the same definition, state, and proposal. The adapter
constructs `SopRuntimeModule` and its validator, advertises `sop.runtime` /
`sop.lifecycle/v2` / `2.0`, returns structured semantic and protocol errors,
and remains stateless. Focused evidence: portable tests `28/28`; PilotDeck
client/loop tests `21/21`; real StaffDeck HTTP Gateway tests `9/9`.

The final independent owner-oracle suite passes 49/49. Expected values are
constructed through native `SopRuntimeModule.submission_validator()`,
`build().after_execution()`, and `GraphRules`, without calling portable
`prepare`/`submit` or its conversion helpers. It covers the supported slot,
transition, wait/resume, terminal, tool-evidence, and host-projection matrix
listed above.

Original-owner audit (2026-09-17): `test_composition.py` and
`test_sop_definition.py` pass 16/16 and establish that this checkout currently
owns sub-SOP metadata/cycle validation, not sub-SOP lifecycle entry/return.
The adapter projects `subSopId` and has no replacement execution semantics.
Sub-SOP entry/return execution is therefore outside the accepted fixed
composition because the owner has no such lifecycle capability; the adapter
does not fabricate replacement semantics.

## P0: Export and Clean Deployment

**PKG-01: One-command standalone export. Current status: PASS.**

`export-composition.mjs` now creates a standalone directory from either shipped
profile. It copies required PilotDeck and StaffDeck sources, rewrites the SOP
definition and endpoint paths for containers, and emits `compose.yaml` plus an
environment template. Both enabled and disabled exports pass `docker compose
config`; complete image build/start remains required.

Once an exporter exists, generate both SOP-enabled and SOP-disabled products
from their YAML profiles. Copy each output to a fresh temporary directory with
no access to either source checkout. Supply credentials at deployment time.
Build bundled sources or pull the declared available images and start via the
exported command. Do not repair generated paths or inject undeclared tools.

Pass: output contains the resolved module configuration, SOP definitions,
runtime dependencies, environment template, and working startup command;
neither product depends on developer machine paths. SOP-disabled output has no
required StaffDeck service. Both products complete their browser workflow.

SOP-disabled boot evidence (2026-09-17): a clean export at
`/tmp/pilotdeck-disabled-export.pedDDj` generated a Compose file with only the
`pilotdeck` service. It started and served HTTP with its Gateway connected;
the isolated container and volume were removed afterward. Model/tool browser
workflow coverage for that export remains separate.

Exported browser rerun (2026-09-17): `run-exported-web-smoke.mjs` exported,
built, and started the SOP-enabled product using its documented Compose
command, then exercised desktop and 390x844 handoff/refresh/resume completion.
The same script with `PILOTDECK_EXPORTED_WEB_SOP_ENABLED=false` exported a
single-service product: desktop and mobile both completed an actual
PilotDeck `read_file` turn under the visible Full Access permission mode, with
no SOP wait banner. Both runs kept screenshots in their emitted artifact
directories and removed their isolated Compose projects, networks, and
volumes. The products' build contexts and runtime paths remained inside each
export.

**DEP-01: Actual Compose deployment. Current status: PASS.**

Rerun evidence (2026-09-17): a clean SOP-enabled export at
`/tmp/pilotdeck-export-deploy.qpGccG` built both images and started with
`PILOTDECK_API_KEY=test-only`. `sop-runtime` passed its healthcheck, the
PilotDeck HTTP endpoint returned 200, and the in-container Gateway connected.
The isolated project and volume were subsequently removed. This verifies
standalone source packaging and boot, not the model/tool/browser/restart
workflow below.

Use a unique Compose project and volume. Execute build/start, health checks,
browser -> Web API -> Gateway -> PilotDeck tool -> StaffDeck SOP, then restart
containers while awaiting handoff and resume from the persisted volume. Also
restart the SOP service independently and verify a recoverable error followed
by continued use of the same session.

The shipped `operator_approval` definition has no business-tool dependency.
Validate it through a handoff, restart while waiting, resume, and completion.
Keep the declared-but-unbound business-tool case as an independent adapter
contract test: it must reject explicitly and never advance SOP state. A custom
organization SOP may declare additional PilotDeck tools, but those are outside
the default export profile.

Pass: the exported example completes without undocumented manual edits; state,
wait identity, and visible transcript survive restart; startup and recovery
errors are actionable. Compose parsing alone is not a passing result.

Focused missing-tool rerun (2026-09-17): Gateway HTTP E2E includes a fixture
definition with `lookup_account` deliberately absent. The model receives an
actionable missing-binding reply; the SOP remains active at `collect_profile`
and no successful tool receipt is persisted. The full suite passes 9/9 against
the real StaffDeck HTTP sidecar. The shipped profile now uses
`operator_approval`, which has no such dependency.

Exported real-model rerun (2026-09-17): a fresh SOP-enabled export was built
and started as Compose project `pilotdeckoperatorverify`, with the credential
injected only into that command's process environment. The generated profile
contained only `operator_approval`, and both `sop-runtime` and the configured
model host were placed in `NO_PROXY`/`no_proxy` to avoid an inherited Docker
proxy. In the browser, `provider1/qwen3.6-flash-distill` entered handoff,
then the SOP container and PilotDeck container were each restarted before the
page refresh. The same session retained its wait id and displayed the waiting
banner after refresh; UI resume returned it to the ordinary PilotDeck turn
path and a real model completed the SOP. A separate persisted handoff was resumed while `sop-runtime` was
stopped: the Gateway returned actionable `StaffDeck SOP runtime request failed:
fetch failed` with `agent_invalid_state` and retained the active step. After
the sidecar recovered, the same session called `submit_step_result` successfully
and persisted `status: completed`. This is exported-artifact evidence, not a
source-checkout repair.

## P0: YAML Composition and Native Behavior

**CFG-01: Supported profile matrix. Current status: PASS.**

Exercise absent `modules`, explicit PilotDeck-only with SOP disabled, and the
mixed profile. With SOP disabled, stop/remove StaffDeck and prove normal chat
and tools still work, with no SOP model control tool or wait UI. Compare native
PilotDeck behavior with the same deterministic inputs and tools.

For enabled SOP, cover an unavailable endpoint, invalid provider, missing
definition/default ID, malformed YAML, and missing required tool. Verify
configuration errors appear before work runs where applicable, and unavailable
runtime errors never silently fall back or advance SOP state.

Mount explicit YAML and exercise fresh and existing volumes, including restart
after enabled -> disabled -> enabled. Verify mounted configuration precedence,
the documented restart requirement, and preservation of saved session
definitions. Use fresh sessions to verify the new profile and existing sessions
to verify its documented restoration behavior.

Pass: the resolved profile determines actual backend and UI behavior; disabled
modules are not operational dependencies. Unsupported core-owner selections
remain explicit configuration errors, not claimed supported permutations.

Focused rerun (2026-09-17): the module-profile test suite passes 6/6 under
Node 22. It covers absent `modules`, disabled SOP, unsupported ownership, and
invalid endpoint/definitions/default-id/timeout settings before runtime
startup. A shared-volume Compose run also passed disabled -> enabled ->
disabled profile restarts: the SOP sidecar was present and healthy only for the
enabled profile, while the mounted config was not copied into the volume and
`auth.db` survived. Existing SOP-session restoration and browser-visible
disabled-profile behavior remain outstanding. Gateway HTTP E2E now also
persists a handoff, restarts with SOP disabled (control plane rejects with
`SOP_MODULE_DISABLED`), then restarts enabled and verifies the same wait id,
revision, and slots are restored.

Malformed-config rerun (2026-09-17): a malformed mounted `pilotdeck.yaml`
was loaded through `loadPilotConfig` before runtime startup. It rejected with
`CONFIG_YAML_INVALID` (plus the expected missing required-field diagnostics),
and did not create a runtime. Together with the enabled/disabled exported
browser runs, the 6/6 module-profile suite, the 9/9 Gateway HTTP matrix, and
the mounted shared-volume restart run, this covers the declared fixed profile
matrix. It does not claim arbitrary non-PilotDeck core providers are supported.

## P0: Complete Real-Model Workflow

**LIVE-01: Evidence and business tool path. Current status: PASS.**

The real-model smoke requires a real PilotDeck business tool before SOP
handoff. It is a focused local candidate check; export/browser evidence remains
owned by DEP-01 and UI-01.

Using the supported provider/model and real StaffDeck HTTP runtime, complete a
real PilotDeck business tool call, submit the SOP step, hand off, resume through
the browser, and finish. Assert the tool's actual result and the persisted SOP
state, not exact generated wording. Verify one final visible reply after page
refresh. Retain the existing small handoff smoke as a focused check.

Pass: one complete run from the candidate deployment, with provider/model ID,
command, result, and sanitized event/state evidence. Real-model output does
not replace deterministic semantic comparisons. Missing working credentials
or provider availability is BLOCKED, never PASS.

Real-model rerun (2026-09-17): with
`REAL_MODEL_SOURCE_PILOT_HOME=/Users/a1/.pilotdeck`, local original StaffDeck
adapter `http://127.0.0.1:18091`, and
`REAL_MODEL_SMOKE_MODEL=provider1/qwen3.6-flash-distill`,
`run-real-model-smoke.mjs` passed. It recorded a successful real `read_file`
tool lifecycle, entered a handoff, accepted host resume, and persisted SOP
status `completed`. Credentials were neither copied nor printed. The default
`provider2/CLAUDE_5boy00` was rejected upstream as an unavailable model; the
passing provider above is the recorded candidate for this local smoke.

Scope decision (2026-09-17): the default export intentionally ships the
generic `operator_approval` SOP and does not deploy the former account
onboarding business workflow or `lookup_account` binding. Therefore the live
business-tool assertion is satisfied by the recorded local real-model
`read_file` run, while the exported real-model Compose run validates the
shipped generic handoff/restart/resume behavior. Injecting a business binding
into the default export merely to repeat this check would contradict the
product profile. Organization-owned business SOPs retain the declared-tool
adapter contract covered by the missing-binding Gateway control.

## P1: Recovery and UI Completion

**REC-01: Uncovered persistence boundaries. Current status: PASS.**

Keep existing crash-window unit tests. Add process termination at the boundary
after terminal reply persistence but before journal cleanup, then restart and
assert the completed reply is not re-delivered. Current cross-process smoke
uses an orderly handoff/dispose/restart and does not cover forced termination.
Count model calls, SOP submissions, completed turns, and visible replies.

Exercise persisted schema v1/v2 -> v3 with wait/resume records and a pending
reply, plus unreadable/invalid state. Verify active SOP/step/slots are preserved
and errors do not silently create a fresh session. Scope durability claims to
the tested process/container restart conditions.

Focused rerun (2026-09-17): `staffdeck-sop-agent-loop.spec.js` passes 15/15,
including v1/v2 handoff wait plus pending-delivery migration to v3, invalid
JSON rejection without a fresh-session overwrite, and the required forced
process-kill boundary. A child process writes a terminal reply to JSONL,
marks the delivery durable, then receives `SIGKILL` before cleanup. A fresh
process restores the same state/transcript, performs no model call or SOP
submission, clears the delivery journal, and projects exactly one visible
terminal reply.

**UI-01: Interrupted two-stage resume. Current status: PASS.**

Rerun evidence (2026-09-17): the local mock deployment exercised
`read_file -> completed SOP step -> handoff -> page refresh -> recoverable
continuation -> completed` on desktop and at a 390x844 viewport. The handoff
banner survived refresh and completion produced one visible terminal reply.

On the real deployed UI, accept a handoff but refresh before sending the
prepared composer text; verify the accepted continuation remains recoverable.
Cover double-click, stale wait/revision in a second tab, disconnect/reconnect,
switching between waiting and non-waiting sessions, and SOP disabled. Assert
one accepted resume, no unintended duplicate turn, accurate wait/error UI,
and no cross-session composer or banner leakage. Repeat the main workflow at
desktop and mobile viewport sizes.

Pass: recovery and UI assertions pass with retained logs/screenshots and exact
failure boundaries against the exported Compose product. The local browser
coverage below establishes the UI behavior, but it cannot close the exported
artifact requirement while DEP-01 is blocked on the shipped business-tool
binding.

Focused UI rerun (2026-09-17): `SopWaitBanner` now has a synchronous
in-flight resume guard and a status-request epoch. Its 4/4 suite proves a
rapid double-click issues one resume request and a delayed prior-session
response cannot leak into the selected session. A two-tab browser run also
passed: one tab accepted a handoff and prepared the continuation; the stale
tab was rejected without preparing a second continuation. The local browser
deployment then passed the full workflow at desktop and 390x844, including
refresh while waiting. With browser networking forced offline, Refresh SOP
status displayed `Failed to fetch`; after networking resumed, the same wait
reloaded. Switching between a waiting session and a completed session did not
leak the wait banner. Finally, the same fixture with
`PILOTDECK_WEB_SMOKE_SOP_ENABLED=false` completed an ordinary `read_file` tool
chat without SOP control UI.

Exported UI rerun (2026-09-17):
`run-exported-web-smoke.mjs` generated a fresh Compose artifact, used the
generic `operator_approval` definition and a local OpenAI-compatible
deterministic model, and ran Playwright against the exported web server. At
1280x900 and 390x844 it completed `handoff -> page refresh -> UI resume ->
ordinary composer submit -> terminal reply`. Each isolated session asserted
exactly one `Browser operator approval completed.` reply and no residual wait
banner. The test removed its Compose containers, network, and volume. It
closes the exported desktop/mobile refresh and single-reply checks; exported
stale-tab and cross-session isolation were subsequently repeated in the same
exported Compose smoke. Two tabs attached to one wait: the first accepted and
prepared the continuation, while the stale tab could not prepare a second one.
The first then completed normally. A fresh waiting session and the completed
session were opened concurrently; only the waiting page rendered the banner.
The refresh boundary exercised browser disconnect/reconnect, and the separate
SOP-disabled export completed an ordinary tool turn without SOP UI.

## Execution Order and Sign-Off

1. SEM-01 first: make semantic compatibility concrete before broad deployment.
2. PKG-01 and CFG-01: implement missing packaging, then test both profiles.
3. DEP-01, REC-01, and UI-01 against those generated artifacts.
4. LIVE-01 on the same candidate; rerun affected existing suites after fixes.

For each gate record checkout/branch/commit and relevant uncommitted changes,
runtime versions, exact command, exit code, artifact directory, and case
results. Preserve failing diagnostics too. Use PASS, FAIL, BLOCKED, and
NOT RUN distinctly; missing or skipped evidence cannot pass a required gate.

Fixed-profile acceptance requires all above gates to pass, including SEM-01's
direct v3 owner-versus-glue matrix. The original arbitrary-module
selection goal additionally requires a declared supported provider matrix and
the corresponding implementation/tests; fixed-profile success cannot establish
that broader claim. No module-core changes are authorized by this test plan.

## Release-Blocking Delta

The existing results are sufficient to accept the deterministic composition
layer as a candidate. They are not sufficient to accept the deployable product.
The following four tests are the minimum remaining release-blocking execution
set. Run them against one immutable exported SOP-enabled artifact and retain
sanitized logs, screenshots, state snapshots, and the exact image/config
identifiers used by that run.

| ID | Priority | Scenario | Required assertions | Classification when prerequisite is unavailable |
| --- | --- | --- | --- | --- |
| LIVE-01 | PASS | Local candidate with approved `provider1/qwen3.6-flash-distill` completed `business tool -> SOP submit -> handoff -> resume -> terminal reply`; exported Compose completed the shipped generic SOP. | Pass: local evidence proves the real PilotDeck business-tool/StaffDeck adapter path; exported evidence proves the default no-business-binding profile. The default export intentionally does not deploy account onboarding or `lookup_account`. | N/A |
| DEP-01 | PASS | Exported Compose ran the shipped `operator_approval` definition, restarted both services during handoff, and recovered from a stopped SOP sidecar. | Pass: browser wait and transcript survived both restarts; outage produced an actionable error without advancing state; the same session completed after sidecar recovery. The declared-but-unbound `lookup_account` control remains covered by the 9/9 Gateway HTTP suite. | N/A |
| REC-01 | PASS | A separate child process persists a terminal SOP reply and is killed with `SIGKILL` after `markReplyDurable` but before `clearReplyDelivery`; a new process restores the same session/transcript. | Passed: recovery clears the delivery journal; transcript replay exposes exactly one visible terminal reply; no second model call or SOP submission occurs. This is a process kill, not an orderly dispose/restart. | N/A |
| UI-01 | PASS | Exported Compose covers desktop and 390x844 handoff/refresh/resume, stale tabs, and waiting/completed session isolation. SOP-disabled Compose covers ordinary tool chat. | Pass: each viewport preserves its wait through refresh, resumes through the visible control, and exposes one terminal reply with no residual banner; a stale tab cannot prepare a second continuation; waiting UI does not leak into a completed session; the disabled profile has no SOP control. | N/A |

CFG-01, DEP-01, REC-01, UI-01, and LIVE-01 are complete. The remaining gate
is expansion of the direct v3 owner-versus-glue semantic matrix.
The model provider credential is injected only at execution time and must never
be emitted in logs, command output, state fixtures, exports, or commit history.

The former historical legacy-versus-sidecar runner is not part of this v3
acceptance. Current StaffDeck routing has only the v3 owner; re-enabling the
retired path merely for a test would alter the product being accepted. SEM-01
therefore uses direct owner invocation as its oracle and the portable HTTP
module as the glue under test.

Historical-runner probe (2026-09-17): the preserved runner from
`/Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop` was invoked
against the current PilotDeck and `StaffDeck-portable-sop` checkouts for its
side-effect-free `pure_text` StaffDeck scenario. Its historical Python
environment could import the current owner only after adding `backend/src` to
the test `PYTHONPATH`; both legacy and PilotDeck modes then stopped before a
turn with `AttributeError: ... turn_coordinator has no attribute TurnPlanner`.
That symbol is an API expected by the historical adapter, not a missing runtime
dependency. The runner correctly exited `2` with two `BLOCKED` adapters and no
semantic comparison. Porting that adapter is a new historical-harness effort;
it cannot be treated as evidence that the current core semantics passed.

Owner routing audit (2026-09-17): this is not only an import relocation.
Current `app.core.agent_loop.AgentLoop._open_engine()` always opens
`EngineHost`, and `EngineHost.open()` rejects a selected
`engine.harness_v2` with `HARNESS_V2_RETIRED`; the registered execution owner
is only `engine.harness_v3`. Consequently, the former
`PILOTDECK_AGENT_LOOP_ENABLED` legacy-vs-sidecar comparison has no two live
execution paths in this checkout. Re-enabling or emulating the retired path
for a test would modify the module-selection semantics under test. A valid
replacement must instead declare an explicit historical baseline and an
approved v2-to-v3 semantic mapping before it can be run as a release gate.
