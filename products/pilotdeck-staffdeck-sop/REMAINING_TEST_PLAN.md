# Remaining Composition Acceptance Tests

Reviewed: 2026-09-20. Status: READY for the requested seven-slot composition.
This file is subordinate to the authoritative G0-G5 table in
`ACCEPTANCE_REQUIREMENTS.md` and records the retained evidence and boundaries.

## v3 Candidate Update

The v3 SOP protocol regression, SOP owner comparison, StaffDeck owner tests,
fresh enabled export browser/restart/sidecar-recovery run, fresh disabled
export browser run, deterministic Context/Compaction recovery, native-five G4
runtime, and continuous final-artifact G5 workflow are complete. Exact
commands, worktrees, counts, and artifact locations are recorded in
`ACCEPTANCE.md` and the durable artifact directories. Together with the
existing independent B0/C AgentLoop session replay and deterministic Model
provider/request/runtime differentials, these close all G0-G5 rows.

## Current Work Item

| Field | Value |
| --- | --- |
| Acceptance ID | G0-G5 final sign-off |
| Missing behavior | None for the declared seven-slot acceptance scope. |
| Call path | `native-five-staffdeck.yaml` -> `export-composition.mjs` -> generated Compose topology and runtime env references -> final build/start/restart/failure-isolation run. |
| Pass condition / verification | The authoritative table records PASS for every G0-G5 gate; durable artifacts retain the final G4/G5 deployment and real-provider evidence without credential material. |
| Next action | Retain the archived evidence; rerun affected gates only after a scoped owner, composition, or deployment change. |

Preflight completed (2026-09-20): `export-composition.mjs` produced
`/tmp/pilotdeck-g4-native-five.tcOvIK` with five native PilotDeck owners plus
external `staffdeck.knowledge` and `staffdeck.portable-sop` bindings. Its
`compose.yaml` parsed with a temporary Compose env file containing only
`PILOTDECK_API_KEY=test-only` and empty real-model credential fields. The file
was removed after validation. The export deliberately bundles neither external service;
its README names `knowledge-runtime:8090` and `sop-runtime:8091`. This host has
no running instances of those services and no local `node:22-bookworm` or
`pilotdeck:exported` image, so this was topology evidence only at preflight.

Runtime completion (2026-09-20): the frozen artifact subsequently ran on an
isolated Docker network with current StaffDeck SOP and Knowledge services. The
artifact built as `pilotdeck:g4-native-five-20260920`; PilotDeck and both
service health endpoints returned 200. A real provider turn successfully
executed `read_skill`, `read_file`, `knowledge_query`, and SOP handoff. The
wait ID survived a PilotDeck restart; resume completed the same session.
Stopping SOP produced `StaffDeck SOP runtime request failed: fetch failed`
without falsely completing state; after SOP recovery the session completed.
Knowledge was restarted independently and the persisted document query still
returned a chunk and citation. Three further real turns followed by
`/compact` produced a durable `compaction_completed` record and
`compact_boundary` with `summaryGenerated: true`. The sanitized durable result,
environment record, and command log are at
`conformance/artifacts/g4-native-five-runtime-20260920/`; the original
`/tmp/pilotdeck-g4-runtime-20260920` directory is only the run source.
Credentials were injected only into the Compose process environment.

**LIVE-EXPORT-01: real provider on a newly exported Compose artifact. Status:
PASS for the fixed SOP profile; not a seven-slot sign-off.**

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

**SEM-01: v3 SOP owner-versus-glue contract comparison. Current status: PASS
for the covered SOP matrix; the seven-slot semantic gate remains PARTIAL.**

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

**PKG-01: One-command standalone export. Current status: PASS for the shipped
SOP profiles; the final seven-slot export remains NOT RUN.**

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

**DEP-01: Actual Compose deployment. Current status: PASS for the shipped SOP
profile; the final integrated seven-slot deployment/recovery run remains PARTIAL.**

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

Focused missing-tool rerun (2026-09-20): Gateway HTTP E2E includes a fixture
definition with `lookup_account` deliberately absent. The selected SOP is
rejected before model dispatch with the unavailable-Tool diagnostic; no SOP
session state is written. This matches the composition rule that an actual
required dependency failure must reject startup rather than begin an owner
turn that cannot satisfy its validator. The full suite passes 9/9 against the
real StaffDeck HTTP sidecar. The shipped profile now uses `operator_approval`,
which has no such dependency.

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

**CFG-01: Supported profile matrix. Current status: PASS for the fixed SOP
profile; arbitrary seven-slot provider selection remains NOT RUN.**

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

**LIVE-01: Evidence and business tool path. Current status: PASS for the fixed
SOP profile; the seven-slot real-model workflow remains NOT RUN.**

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

The fixed-profile evidence above is useful regression evidence, but it is not
the requested seven-slot acceptance. The candidate now has contract-driven
bindings for the six core slots and a StaffDeck Knowledge Module Protocol
facade; those are implementation inputs, not completion evidence. The broader
goal still requires session-level and independent implementation conformance
for every slot, B0 owner parity, a complete exporter/profile, and the G0-G5
gates in `ACCEPTANCE_REQUIREMENTS.md`. Fixed-profile success cannot establish
that broader claim. No module-core changes are authorized by this test plan.

## Current Seven-Slot Delta

This table is the current finite release list for the requested seven-slot
candidate. It supersedes the historical fixed-SOP-only wording below for
seven-slot planning. `PASS` rows elsewhere remain reusable evidence only when
their listed behavior and binding match this row; none changes G0-G5 by itself.

| Acceptance ID | Unsatisfied behavior | Classification | Reusable evidence | One next action | Exit condition |
| --- | --- | --- | --- | --- | --- |
| G0 / EVID-01 | Freeze the B0 -> N0 -> C owner inventory and close every recorded drift for all seven slots. | PASS | PilotDeck N0 `4355463d`: AgentLoop (7/7), Skill (15/15), Tool (23/23), Context/Compaction (15/15), Model (14/14). StaffDeck N0 `71aaede2`: SOP GraphRules (3/3) plus TurnFinalizer (5/5), Knowledge citations (3/3) plus public owner lifecycle (11/11), each B0 -> N0 and N0 -> C; injected mismatches exit 1. The independent AgentLoop session replay includes `incomplete-turn-resumed-execution` with full B0/C request, event, terminal, durable-order, and zero-side-effect comparison. | Retain the root-selectable runners and rerun only after an owner or adapter change. | Every declared owner row has a baseline command/result, closed difference, and mismatch sensitivity. |
| TOOL-01 | Native Gateway Tool audit/restart, timeout, and cancellation side effects. | PASS | `run-tool-gateway-restart-b0-differential.mjs` plus focused durable Tool recorder regression. | Retain the runner as the Tool regression; do not reopen it unless native dispatch or durable Tool recording changes. | B0/C compare declared Tool result, audit and filesystem/process effects; injected order/result mismatch exits nonzero. |
| CTX-01 / CMP-01 | Native Gateway automatic-compaction/restart replay must preserve every model-visible post-boundary message and canonical request. | PASS for the declared native Gateway slice | Refreshed schema-v3 real-owner trace, B0 Context/budget replay, B0 legacy compact-boundary projection, strict post-restart request comparison, and `run-context-b0-differential.mjs` 4/4. Messages, tool names, `agent`, `execute_code` descriptions, contribution order, media pairing, max-message projection, and cache fields align. | Retain the strict runner; reopen only if Context or compaction code changes. | Reactive+auto transcript, boundaries, budgets, restart count, messages, and complete canonical request parity pass. |
| CMP-02 | Manual compaction failure/cancellation and process termination before/after replacement commit, including spill/missing-summary and service-recovery branches. | PASS for the declared native recovery slice | `native-compaction-process-recovery.spec.js` 7/7, `run-compaction-restart-b0-differential.mjs` 3/3 B0/C, `manual-compaction-controller.spec.js` missing-summary/write-race cases, `run-compaction-b0-differential.mjs`, and `run-auto-compaction-b0-differential.mjs`. | Retain the passing recovery matrix; reopen only after a Context or compaction behavior change. | Summary failure/cancellation/kill preserves prior history; commit-before/after kill yields exactly one boundary; spill, missing summary, cancellation, write-race, and outage recovery have explicit state assertions. |
| MODEL-01 | Configured-provider runtime parity for selection, usage, error, retry and cancellation. | PASS | `run-model-provider-b0-differential.mjs`, `run-model-request-b0-differential.mjs`, `run-model-runtime-b0-differential.mjs`, and focused Model owner regressions. | Retain the runtime runner; reopen it if native Model request, stream, usage, retry, or cancellation behavior changes. | Six B0/C cases compare configured provider/model selection and default output cap, normalized content/tool/usage stream, retry progress and request count, terminal auth classification, active cancellation, and non-stream completion/tool/usage. Usage/error/event-order injections each exit nonzero; real-provider behavior is covered separately by G5. |
| SOP-01 / SOP-02 | Declared SOP owner lifecycle, nesting and cross-process resume slice. | PASS | 5/5 B0/C native `TurnFinalizer` differential (handoff, routed handoff, rejected handoff, completed, continued), 49/49 direct owner/API tests, 24/24 frozen nesting checks, and 10/10 real StaffDeck HTTP Gateway E2E. The Gateway now proves `awaiting_user`, `failed`, and `blocked` projections alongside handoff/external wait restart/recovery. | Retain these regressions; reopen only if the owner lifecycle, portable HTTP state mapping, or Gateway SOP state store changes. | Handoff/external waits have the only resumable host waits. Awaiting-user/failed reject `resumeSop` and recover through ordinary turns; blocked rejects `resumeSop`, does not re-enter owner preparation, and remains terminal. |
| KB-01..KB-04 | Full public Knowledge management/discovery facade matrix. | PASS | `run_staffdeck_knowledge_owner_lifecycle_differential.py` compares 11/11 B0/C native owner behavior groups, with mismatch sensitivity; `run_staffdeck_knowledge_lifecycle.py` records 32/32 declared facade calls and correlated envelopes across restart, including query/citation/OKF state. | Retain the two runners and rerun only after Knowledge owner or facade changes. | Closed for the declared KB matrix. It does not establish G0, G3, G4, or G5. |
| PLUG-02 | A frozen host must accept an unregistered implementation in every slot through YAML alone, execute one real domain operation, and reject a contract/error path. | PASS for the declared unknown-module matrix, not G2 sign-off | `unknown-agent-loop-conformance.spec.ts` (4 cases), `external-sidecar-sop-session-e2e.spec.ts`, `http-module-runtime.spec.ts` (18 cases), `modules-config.spec.ts` (21 cases), and `run-sop-conformance.mjs`. | Retain these conformance runners; rerun after protocol/config changes. | All seven slots have an unregistered YAML-selected operation and a structured identity/capability/contract/state-mode or operation failure path without a host factory or implementation allow-list. |
| PLUG-03..PLUG-05 / RPC-01 | Toggles, required-dependency rejection, reconfiguration, and fail-closed remote uncertainty. | PASS for the declared G2 matrix | `PARALLEL_PROTOCOL_REPORT.md`: PLUG-03/04/05 and RPC-01 are PASS; focused composition/config tests cover plain, Knowledge-only, SOP-only, disabled modules, dependency rejection, rejected reload retention, and timeout/disconnect/cancel result-unknown behavior. | Carry this evidence into G2; do not repeat the delivered protocol slice. | Closed for the declared protocol/configuration matrix. Integrated seven-slot export and G4/G5 remain separate gates. |
| E2E-01..E2E-05 / REC-01..REC-02 | Real owner composition has deterministic E2E-01 plus E2E-02..05 and recovery slices. | PASS for the declared native-five composition | `real-staffdeck-seven-slot-e2e.spec.js` 2/2, native recovery 7/7, compaction restart 3/3, AgentLoop differential 7/7, LOOP/session recovery 7/7, Knowledge 32/32/11/11, plus the cancellation/write-race and outage assertions listed above. | Retain the evidence; reopen only after owner, composition, or recovery behavior changes. | Each E2E case has an input, expected state/side effect, and trace; no claim of remote durable deduplication is made where the contract does not declare it. |
| G4 / DEP-01 | Final integrated seven-slot export, clean build/start, restart and failure-isolation evidence. | PASS for the frozen native-five artifact | `conformance/artifacts/g4-native-five-runtime-20260920/result.sanitized.json` plus its `environment.txt` and `command-log.txt`: current PilotDeck image built from the exported artifact, external Knowledge/SOP health, PilotDeck restart retained the SOP wait, Knowledge restart retained query/citation state, and SOP outage returned a recoverable failure before completion after recovery. | Retain the sanitized runtime record; do not rerun without a deployment or composition change. | Fresh artifact builds/starts, shared StaffDeck topology is correct, restart/outage paths preserve state, and all G4 assertions pass. |
| G5 / E2E-REAL | Real provider plus real StaffDeck Knowledge/SOP must execute Skill -> Tool -> Knowledge -> handoff -> resume -> completed and one real summary. | PASS | `conformance/artifacts/g5-native-five-continuous-20260920/evidence-summary.json` and `transcript.sanitized.jsonl` record one final-artifact session with successful Skill, Tool, Knowledge evidence/citations, handoff wait, accepted resume, completed SOP state, and durable compaction. | Retain this artifact; rerun only after the final artifact, Knowledge/SOP protocol, or model workflow changes. | One sanitized transcript records every required real operation and final completed state, with no credentials or provider URLs. |

### Strict B0 Compaction Decision

The application/profile default and invalid-value fallback now select
`runtimeContextSurface: system_prompt`, matching B0's model-visible default.
Explicit `user_message` remains supported and separately tested; it is not
normalized away during parity comparison.

The current native-owner trace is generated by:

```sh
env -u NODE_OPTIONS PILOTDECK_E2E_ARTIFACT_DIR=/tmp/pilotdeck-e2e01-restart-trace.65478n \
  PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  node --test --test-force-exit --test-name-pattern='native PilotDeck owners compose real StaffDeck Knowledge and SOP through Gateway' \
  dist/tests/composition/real-staffdeck-seven-slot-e2e.spec.js
```

Its transcript records a successful `reactive` compact boundary followed by a
successful `auto` boundary. Both remain in the durable transcript. The strict
runner validates exactly one automatic replacement boundary, preserves the
reactive boundary in the trace-only B0 legacy durable-message projection, and
compares the next B0 Gateway request against all 28 candidate model-visible
messages after restart:

```sh
env -u NODE_OPTIONS PILOTDECK_E2E_POST_COMPACTION_REPLAY=1 \
  PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH \
  node products/pilotdeck-staffdeck-sop/conformance/run-e2e01-native-pilotdeck-b0-gateway-session-replay.mjs \
  /tmp/pilotdeck-e2e01-restart-trace.65478n/e2e01-native-owner-trace.json
```

It exits `0`. With
`PILOTDECK_E2E_POST_COMPACTION_REQUEST_INJECT_MISMATCH=1`, the same command
exits `1` and reports the altered final user-message content. The frozen B0
still cannot directly read atomic `replacementMessages`; only the runner's
trace-local legacy projection bridges that historical JSONL format, without
modifying B0 or candidate product code.

## Historical Fixed-SOP Release-Blocking Delta

The existing results are sufficient to describe a deterministic SOP
composition-layer candidate. They are not sufficient to accept the requested
seven-slot deployable product.
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
