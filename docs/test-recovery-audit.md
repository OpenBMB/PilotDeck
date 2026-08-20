# Historical Test Recovery Audit

The forward-looking coverage and test expansion plan is maintained in
[`docs/test-quality-roadmap.md`](test-quality-roadmap.md). This audit records
historical contract mappings and evidence; the roadmap records future coverage
targets and staged gate changes.

## Scope and Method

This audit covers every deleted path under `tests/`, plus every deleted
`*.test.*` and `*.spec.*` path under `ui/`, reachable from
`746edb6e^..HEAD`. That includes the 203 test/spec files removed by `746edb6e`,
their deleted fixtures and runners, and later deletions such as `293abc32` and
`ce628798`. The inventory is derived from the current branch ancestry only;
unrelated remote branches are intentionally out of scope. Repeated
delete/re-add cycles are represented by the newest deletion in the audited
range.

The inventory is path-complete, while restoration is contract-based. A row's
contract family supplies the original behavior, current owner, and current
test mapping. Old files are not copied wholesale because many mixed helpers,
integration harnesses, and contracts for replaced implementations.

Classifications are fixed:

- `COVERED`: the behavior still exists and is covered by the mapped current tests.
- `RESTORE`: the behavior still exists but has no deterministic gate coverage.
- `OBSOLETE`: the implementation or contract was explicitly replaced or removed.
- `DEFER_EXTERNAL`: meaningful coverage requires a model, network, browser,
  Docker, child-process timing, or a channel platform.
- `SUPPORT_ONLY`: fixture, runner, or helper without an independent contract.

There are no unresolved `RESTORE` rows after batches 1-5. A `COVERED` row means
the current tests cover the surviving contract, not that every assertion from
the historical file remains applicable.

This path inventory is not a claim that every production commit changed a
test. A separate commit-level audit of non-merge commits since 2026-06-01 found
additional behavior contracts that were never represented by a deleted test
path. The P0 findings from that audit are now covered below; lower-priority
commit-level findings remain a separate follow-up backlog.

Inventory totals: 300 historical paths represented by 301 classification rows:
256 `COVERED`, 11 `DEFER_EXTERNAL`, 25 `SUPPORT_ONLY`, and 9 `OBSOLETE`.
`tests/benchmark/router-classify.test.ts` is intentionally represented twice
because its deterministic prompt/mock-judge contract and real-model accuracy
scenario now have different owners and gates.

## Commit-Level P0 Recovery

| Fix commits | Surviving contract | Current deterministic test | Status |
| --- | --- | --- | --- |
| `13484f9b`, `1e384736` | Quoted catastrophic deletes are denied and Git repository-context options cannot inherit read-only permission | `tests/tool/bash-permission-security.spec.ts` | `COVERED` |
| `ed1d509d` | Windows command shims use escaped, non-shell `cmd.exe` invocation semantics | `ui/server/utils/processSpawn.test.js` | `COVERED` |
| `699213bf` | `/files/write` rejects invalid path, content and encoding without writing | `tests/adapters/web-http-router-validation.spec.ts` | `COVERED` |
| `e88b239f` | Unsupported top-level and tool-result media is rejected without mutating the model request | `tests/model/request/unsupported-media.spec.ts` | `COVERED` |
| `f04fa5c5` | OpenAI Responses `response.failed` emits one complete assistant lifecycle | `tests/model/streaming/openai-responses-terminal.spec.ts` | `COVERED` |
| `5a1b3d76` | Google object unions are flattened without union leakage and SDK abort errors remain aborts | `tests/model/google-regressions.spec.ts` | `COVERED` |
| `626e8ec7` | MCP `ImageContent` remains an inline image while unsupported blocks remain structured JSON | `tests/mcp/plugin-image-content.spec.ts` | `COVERED` |
| `c1473d48` | Concurrent initial proxy installs share the first effective dispatcher install | `tests/cli/proxy-concurrency.spec.ts` | `COVERED` |

## Commit-Level P1 Recovery

P1 status uses two layers of evidence. `CURRENT_ONLY` means the deterministic
test passes on the fixed implementation but has not yet demonstrated a
reversed-fix failure. `COVERED / MUTATION_FAIL` means the test passes now and
the independent `pnpm test:regression-proof` runner applied one exact reverse
mutation that made its named test fail. `MUTATION_FAIL` is not a claim that an
old parent checkout was runnable; historical parent checks remain
`PARENT_FAIL` only where that checkout was actually verified.

| Fix commits | Surviving contract | Current deterministic test | Status |
| --- | --- | --- | --- |
| `d5208ac5`, `7f9dd9e9`, `8171a369` | Cron results route only to the originating IM chat; Feishu uses its text transport; rejection and exceptions remain delivery failures | `tests/adapters/im-cron-delivery.spec.ts` | `COVERED / MUTATION_FAIL` |
| `ab48bda4` | IM elicitation prompts preserve choices and descriptions, map answers to the original request, support cancellation, and isolate chats | `tests/adapters/im-elicitation-helper.spec.ts`, `tests/adapters/feishu-permission-reply.spec.ts` | `COVERED / MUTATION_FAIL` |
| `5bb4892d`, `15aff90c`, `5a4bbbe1`, `e8a8138b`, `d682ce11` | IM renderers suppress tool-start and successful-tool noise while retaining failed tools | `tests/adapters/im-renderers.spec.ts` | `COVERED / MUTATION_FAIL` |
| `f15813a4`, `fcae50f7` | A Weixin permission allow resumes tool activity after the configured delay, while explicit immediate resume remains available | `tests/adapters/im-live-reply-activity.spec.ts`, `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `09a247d8` | A pending Signal permission response cannot block consumption of later SSE lines | `tests/adapters/signal-stream-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `fd85320d` | Weixin snapshots messages and attachments arriving during an active chat, drains them FIFO, and bounds the per-chat backlog | `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `81017688`, superseded by `953abcce` and `5c043afd` | Workspace attachments are delivered through explicit Gateway `assistant_attachment` events; ordinary reply text is not treated as an authorized path list | `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `6c4de191` | Weixin file messages accept nested media URLs and decrypt encrypted known-file payloads before persistence | `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `3037ece9` | Start remains non-blocking during QR login and a later successful login starts polling | `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |
| `57456021` | iLink fetch removes caller-supplied `content-length` without changing unrelated requests | `tests/adapters/weixin-fetch-compat.spec.ts` | `COVERED / MUTATION_FAIL` |
| `baecbc00` | Recoverable poll failures rebuild the iLink client with its live cursor; non-network failures do not | `tests/adapters/weixin-lifecycle.spec.ts` | `COVERED / MUTATION_FAIL` |

## Contract Mapping

| Family | Historical behavior | Current owner | Current tests | Class | Batch |
| --- | --- | --- | --- | --- | --- |
| `GATEWAY` | Session busy/abort lifecycle, active replay, interactive request replay, event/run identity and socket cleanup | `src/gateway/**`, `ui/server/pilotdeck-bridge.js` | `tests/gateway/gateway-lifecycle-regressions.spec.ts`, `tests/gateway/gateway-server-smoke.spec.ts`, `tests/gateway/*.spec.ts`, `ui/server/pilotdeck-bridge*.test.js` | `COVERED` | 1 |
| `PERMISSION` | Permission precedence, plan-mode read-only boundary, safe bypass behavior and promptability | `src/permission/**`, `src/tool/**`, `src/agent/sub/**` | `tests/permission/permission-regressions.spec.ts`, `tests/tool/**/*.spec.ts` | `COVERED` | 1 |
| `CONFIG` | Config parsing/reload recovery, model conflict normalization, Router store lifetime and runtime wiring | `src/pilot/config/**`, `src/router/**`, `ui/server/services/pilotdeckConfig.js` | `tests/regressions/config-state-file-regressions.spec.ts`, `tests/pilot/config/*.spec.ts`, `ui/server/routes/{config,mcp}.test.js`, `ui/server/services/pilotdeckConfig.test.js` | `COVERED` | 2 |
| `FILES` | Project identity, safe editor/file mutation, backup, rollback, snapshot idempotence and eviction | `src/pilot/paths.ts`, `src/session/filesystem/**`, `ui/src/components/code-editor/**` | `tests/regressions/config-state-file-regressions.spec.ts`, `tests/tool/new-file-write.spec.ts`, `ui/src/components/code-editor/**/*.test.tsx` | `COVERED` | 2 |
| `CONTEXT` | Prompt assembly, attachment resolution, compaction budgets/replay and tool-result retention | `src/context/**`, `src/session/transcript/**` | `tests/context/*.spec.ts`, `tests/session/transcript-replay-compaction.spec.ts`, `tests/web/compact-replay.spec.ts` | `COVERED` | 3 |
| `MODEL` | Canonical message isolation, provider request/stream normalization, reasoning/schema/error behavior | `src/model/**` | `tests/regressions/model-router-regressions.spec.ts`, `tests/model/**/*.spec.ts` | `COVERED` | 3 |
| `ROUTER` | Abort propagation, fallback/retry, classification/orchestration, streaming recovery and session-store continuity | `src/router/**` | `tests/regressions/model-router-regressions.spec.ts`, `tests/regressions/config-state-file-regressions.spec.ts`, `tests/router/{classification-regressions,streaming-recovery}.spec.ts`, `tests/integration/router-orchestration-sticky.spec.ts` | `COVERED` | 3 |
| `ALWAYS_ON` | Discovery safety rules, plan terminal state, stores, contracts, history and workspace lookup | `src/always-on/**` | `tests/regressions/always-on-session-adapter-regressions.spec.ts`, `tests/always-on/state-context-regressions.spec.ts` | `COVERED` | 4 |
| `AGENT` | Agent loop recovery, subagent inheritance/filtering, turn environment and bounded context | `src/agent/**` | `tests/agent/**/*.spec.ts`, `tests/tool/builtin/agent-subagent-type.spec.ts` | `COVERED` | 4 |
| `SESSION` | Transcript event pairing/replay, storage metadata, session naming, artifacts and worktree helpers | `src/session/**`, `src/web/server/**` | `tests/regressions/always-on-session-adapter-regressions.spec.ts`, `tests/session/**/*.spec.ts`, `tests/web/*.spec.ts` | `COVERED` | 4 |
| `TOOL` | Registry, input validation, scheduler, read/write/edit/search behavior and result shaping | `src/tool/**` | `tests/tool/**/*.spec.ts`, `tests/permission/permission-regressions.spec.ts` | `COVERED` | 4 |
| `ADAPTER` | CLI/TUI/IM event reduction, persistence, permission replies, attachment paths and session mapping | `src/adapters/**` | `tests/regressions/always-on-session-adapter-regressions.spec.ts`, `tests/adapters/*.spec.ts`, `tests/gateway/weixin-*.spec.ts` | `COVERED` | 4 |
| `MCP_EXT` | MCP sanitization/registration and extension/skill discovery and migration | `src/mcp/**`, `src/extension/**` | `tests/mcp/**/*.spec.ts`, `tests/extension/**/*.spec.ts` | `COVERED` | 4 |
| `CRON` | Store concurrency, deletion/start races, scheduling/config semantics | `src/cron/**`, `ui/server/**` | `tests/cron/cron-regressions.spec.ts`, `ui/server/utils/cronJobSort.test.js`, `ui/src/components/main-content-v2/CronV2.test.tsx` | `COVERED` | 4 |
| `UI_STATE` | Cross-session isolation, request ordering, history/live reconciliation, reconnect and queued send | `ui/src/stores/useSessionStore.ts`, `ui/src/components/chat/**`, `ui/src/hooks/useProjectsState.ts` | Vitest mappings plus non-required `ui/e2e/history-fork.spec.mjs` for public UI/protocol smoke | `COVERED` | 5 |
| `UI_VIEW` | Current component rendering, settings, editor, shortcuts and local UI utilities | `ui/src/**` | co-located current Vitest files under `ui/src/**` | `COVERED` | 5 |
| `LEGACY_WEB` | Pre-bridge web reducer/server/parity implementation whose contract moved to Gateway and the UI store | `src/web/**`, `ui/server/**`, `ui/src/stores/**` | surviving behavior maps to `GATEWAY`, `SESSION`, and `UI_STATE`; implementation-specific assertions do not | `OBSOLETE` | - |
| `REMOVED` | Removed feature or implementation-specific contract with no current owner | none | none | `OBSOLETE` | - |
| `EXTERNAL` | Real model/network/Docker/benchmark/platform-channel behavior | external systems | `tests/external/*.external.ts` via `.github/workflows/external-nightly.yml`; platform-only rows remain deferred pending runners/accounts | `DEFER_EXTERNAL` | nightly |
| `SUPPORT` | Fixture, scenario, runner, grading, or helper code | historical test infrastructure | no independent test | `SUPPORT_ONLY` | - |

## Current Gate Layers

- `pnpm check` is the deterministic PR validation command. It includes the 31
  recovered offline contracts and the real-process Gateway smoke, but no
  browser, model, public-network, Docker, or user-home dependency.
- `pnpm --dir ui e2e` starts a repository-controlled fake provider, Gateway,
  Express and Vite under a temporary `PILOT_HOME`. The non-required
  `Browser Smoke / Playwright smoke (non-blocking)` workflow covers session
  creation, Stop/force-send, permission decisions, reconnect, session
  isolation, live/history consistency and history fork.
- `pnpm test:external` requires both `PILOTDECK_RUN_EXTERNAL=1` and an explicit
  `PILOTDECK_EXTERNAL_GROUP`. The scheduled/manual `External Nightly` matrix
  runs `model-protocol`, `agent-context-web`, `router-classify` and
  `wcb-docker` with configuration written only below `$RUNNER_TEMP`.

The external runner writes only redacted logs under `artifacts/external`.
Neither the temporary `PILOT_HOME` nor its decoded configuration is uploaded.

### Recovered Offline Mappings

| Historical path/contract | Current deterministic test |
| --- | --- |
| `tests/benchmark/taskLoader.test.ts` | `tests/benchmark/task-loader.spec.ts` |
| `tests/integration/classify-accuracy.test.ts` | `tests/router/classification-regressions.spec.ts` |
| `tests/integration/orchestrate-subagent.test.ts` | `tests/integration/router-orchestration-sticky.spec.ts` |
| `tests/integration/tokensaver-sticky.test.ts` | `tests/integration/router-orchestration-sticky.spec.ts` |
| `tests/router/streamingRecovery.e2e.spec.ts` | `tests/router/streaming-recovery.spec.ts` |
| `tests/benchmark/router-classify.test.ts` (offline) | `tests/router/classification-regressions.spec.ts` |
| `tests/benchmark/router-classify.test.ts` (real model) | `tests/external/router-classify.external.ts` |

The historical external model/protocol, agent/context/web-search and WCB
families map to `tests/external/model-protocol.external.ts`,
`tests/external/agent-context-web.external.ts` and
`tests/external/wcb-docker.external.ts`. They remain `DEFER_EXTERNAL` because
their nightly execution cannot be proven in a credential-free local run.

## Historical Validation

`PARENT_FAIL` means a representative regression test was checked against the
parent of its fixing commit and the missing behavior was observable. `CURRENT`
means the current test is deterministic and passes, but the historical file
could not be transplanted without depending on removed helpers or APIs.
`CONTRACT_ONLY` means the old implementation no longer builds in the current
toolchain, so the row is classified from source history rather than claiming a
test failure. External and support rows use `DEFERRED` and `N/A` respectively.

Representative parent checks and exact outcomes are recorded after the
inventory. Rows inherit the validation state of their contract family unless a
more specific value is shown.

## Inventory

| Historical path | Added | Deleted | Family | Class | Priority | Batch | Historical validation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tests/adapters/channel-cli.test.ts` | `0128d8e7` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/channel-feishu-session-mapper.test.ts` | `0128d8e7` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/channel-tui-reducer.test.ts` | `0128d8e7` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/channel-weixin.test.ts` | `a9db267f` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/ChannelStatePersistence.spec.ts` | `6b9b441a` | `733e91d5` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/ImLiveReplyController.status.test.ts` | `4446a238` | `a70f585f` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/web/http-router.test.ts` | `b2b830b0` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/web/project-files.test.ts` | `b2b830b0` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/adapters/web/project-git.test.ts` | `b2b830b0` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/AgentLoop.status.test.ts` | `4446a238` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/agentLoopEmptyOutput.spec.ts` | `53b60eec` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/agentLoopToolNameRepair.spec.ts` | `228ee2e4` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/context-runtime.test.ts` | `ed5b8403` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/e2e/real-tool-use.test.ts` | `0128d8e7` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/agent/e2e/run-real-agent-lifecycle-hooks.ts` | `e0b26852` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/agent/e2e/run-real-agent-loop.ts` | `1730a0ff` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/agent/executeCodeAgent.spec.ts` | `5d889878` | `2a8b7858` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/invalidToolLoopRecovery.spec.ts` | `26cc3113` | `2a8b7858` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/loop-circuit-breaker.test.ts` | `cde27f63` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/loop-output-token-recovery.test.ts` | `e8a30eae` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/loop-reactive-recovery.test.ts` | `e8a30eae` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/loop.test.ts` | `e7c3d64b` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/loop/AgentLoopPlanModeCache.test.ts` | `3cf8665b` | `592bfe49` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/agent/outputTokenRetry.test.ts` | `0107fe16` | `1e83da49` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/parity-dual-contract.test.ts` | `ed5b8403` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/agent/parity-dual-execution.test.ts` | `ed5b8403` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/agent/project-tool-results.test.ts` | `736b9bf5` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/recovery.test.ts` | `ed5b8403` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/resume.test.ts` | `ed5b8403` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/build-forked-messages.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/context-inheritance.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/depth-guard.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/filter-incomplete.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/subagent-session.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/sub/subagent-transcript-integration.test.ts` | `a0501023` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/subAgentTokenCaps.spec.ts` | `8ccc0272` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/transcript-jsonl.test.ts` | `ed5b8403` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/agent/TurnRunner.status.test.ts` | `a566aa8b` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/always-on/channel-lease-registry.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/chat-digest-builder.test.ts` | `4f3bf2eb` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/chat-history-tool.test.ts` | `4f3bf2eb` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/create-apply-handler.test.ts` | `4b0e995a` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-fire-deny-rules.test.ts` | `aee27337` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-fire-ensure-workspace.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-gates.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-plan-service.test.ts` | `8d7f5c1b` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-plan-status.test.ts` | `8d7f5c1b` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-plan-store.test.ts` | `f914ecdf` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-prompts.test.ts` | `102c0cd3` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/discovery-state-store.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/load-pilot-config-always-on.test.ts` | `3eedae66` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/always-on/parse-always-on-config.test.ts` | `3eedae66` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/always-on/plan-contract.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/report-contract.test.ts` | `3eedae66` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/run-history-service.test.ts` | `8d7f5c1b` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/always-on/workspace-tool.test.ts` | `102c0cd3` | `746edb6e` | `ALWAYS_ON` | `COVERED` | P1 | 4 | `PARENT_FAIL` |
| `tests/benchmark/executor.ts` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/benchmark/grade_bridge.py` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/benchmark/grading.ts` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/benchmark/pinchbench-runner.ts` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/benchmark/router-classify.test.ts` (prompt/mock-judge) | `8ac10169` | `746edb6e` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/benchmark/router-classify.test.ts` (real-model accuracy) | `8ac10169` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | nightly | `DEFERRED` |
| `tests/benchmark/taskLoader.test.ts` | `8ac10169` | `746edb6e` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/benchmark/taskLoader.ts` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/benchmark/workspace.ts` | `8ac10169` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/cli/create-local-gateway.test.ts` | `3103b097` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/cli/proxyDefaults.spec.ts` | `2a776309` | `a70f585f` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/context/attachment-resolver.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/auto-compaction-policy.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/cached-microcompaction-engine.test.ts` | `70d69a23` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/compaction-engine.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/compaction-enhancements.spec.ts` | `974404a1` | `a70f585f` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/context-overflow-recovery.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/contextOverflowRecovery.spec.ts` | `53b60eec` | `a70f585f` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/create-edgeclaw-memory-provider-from-config.test.ts` | `e014509b` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/default-context-runtime-memory.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/default-context-runtime.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/e2e/instruction-discovery-e2e.test.ts` | `cdf18457` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/context/e2e/real-context-prompt.test.ts` | `d7688811` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/context/edgeclaw-memory-provider.test.ts` | `0128d8e7` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/input-processor.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/instruction-discovery.test.ts` | `cdf18457` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/memory-attachment-builder.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/message-projector.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/microcompaction.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/plugin-runtime-extension-resolver.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/prompt-assembler.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/snip-engine.test.ts` | `70d69a23` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/strip-multimedia.test.ts` | `736b9bf5` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/token-budget-manager.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/tokenBudgetManager.spec.ts` | `53b60eec` | `a70f585f` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/context/tool-result-budget.test.ts` | `d7688811` | `746edb6e` | `CONTEXT` | `COVERED` | P1 | 3 | `CURRENT` |
| `tests/cron/cron-run-now.test.ts` | `8d7f5c1b` | `746edb6e` | `CRON` | `COVERED` | P0 | 4 | `PARENT_FAIL` |
| `tests/cron/cron-runtime.test.ts` | `194873fe` | `746edb6e` | `CRON` | `COVERED` | P0 | 4 | `PARENT_FAIL` |
| `tests/cron/cron-scheduler.test.ts` | `194873fe` | `746edb6e` | `CRON` | `COVERED` | P0 | 4 | `PARENT_FAIL` |
| `tests/cron/cron-task-store.test.ts` | `194873fe` | `746edb6e` | `CRON` | `COVERED` | P0 | 4 | `PARENT_FAIL` |
| `tests/cron/cron-tools.test.ts` | `194873fe` | `746edb6e` | `CRON` | `COVERED` | P0 | 4 | `PARENT_FAIL` |
| `tests/cron/load-pilot-config-cron.test.ts` | `194873fe` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/cron/parse-cron-config.test.ts` | `194873fe` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/desktop/onboarding-config-compat.test.ts` | `fd6bef55` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/e2e/framework-real-judge.test.ts` | `8d539c84` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/e2e/framework-real-routing.test.ts` | `8d539c84` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/e2e/framework-real-tooluse.test.ts` | `8d539c84` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/e2e/framework-wcb-smoke.test.ts` | `8d539c84` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/extension/plugin-mcp-instructions.test.ts` | `98d40724` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/extension/skills-migration.test.ts` | `790340de` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/extension/skills/skill-manager.test.ts` | `9c8f7e3a` | `eaa48b18` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/extension/skills/SkillManager.scan.spec.ts` | `15cd2775` | `2a8b7858` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/fixtures/agent/dual-parity/contractScenarios.ts` | `ed5b8403` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/agent/dual-parity/executionScenarios.ts` | `ed5b8403` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/lifecycle-hooks-plugins/dual-parity/contractScenarios.ts` | `579ce613` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/lifecycle-hooks-plugins/dual-parity/executionScenarios.ts` | `579ce613` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/tool/dual-parity/contractScenarios.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/tool/dual-parity/executionScenarios.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/fixtures/web-ui/parity-scenarios.ts` | `b2b830b0` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/gateway/in-process-gateway.test.ts` | `0128d8e7` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/InProcessGateway.status.test.ts` | `4446a238` | `a70f585f` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/InProcessGatewayPlanTools.test.ts` | `3cf8665b` | `592bfe49` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/map-agent-event-persist.test.ts` | `2f8c7b56` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/map-agent-event-tool-output.test.ts` | `2f8c7b56` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/mapAgentEvent.spec.ts` | `53b60eec` | `a70f585f` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/permission-bus.test.ts` | `86730b44` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/permission-decide.test.ts` | `86730b44` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/remote-gateway.test.ts` | `0128d8e7` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/gateway/session-router.test.ts` | `0128d8e7` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/helpers/agent.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/dualParityExecutionReport.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/dualParityReport.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/filesystem.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/gitFixture.ts` | `70d69a23` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/lifecycleHooksPluginContractReport.ts` | `579ce613` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/lifecycleHooksPluginExecutionReport.ts` | `579ce613` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/helpers/tool.ts` | `e7c3d64b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/integration/agent-router-integration.test.ts` | `8d539c84` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/integration/classify-accuracy.test.ts` | `8d539c84` | `746edb6e` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/integration/context-compaction-router.test.ts` | `8d539c84` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/integration/orchestrate-subagent.test.ts` | `8d539c84` | `746edb6e` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/integration/tokensaver-sticky.test.ts` | `8d539c84` | `746edb6e` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/integration/tool-permission-router.test.ts` | `8d539c84` | `746edb6e` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/lifecycle-hooks-plugins/agent-lifecycle.test.ts` | `579ce613` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/lifecycle-hooks-plugins/hook-runtime.test.ts` | `c358e4fc` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/lifecycle-hooks-plugins/parity-manifest.test.ts` | `579ce613` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/lifecycle-hooks-plugins/plugin-loader.test.ts` | `c358e4fc` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/lifecycle-hooks-plugins/protocol.test.ts` | `c358e4fc` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/lifecycle-hooks-plugins/tool-integration.test.ts` | `c358e4fc` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/mcp/in-memory-client.test.ts` | `2d873e28` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/mcp/runtime-tool-registration.test.ts` | `2d873e28` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/mcp/sanitize.test.ts` | `2d873e28` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/mcp/truncate.test.ts` | `2d873e28` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/mcp/wire-name.test.ts` | `2d873e28` | `746edb6e` | `MCP_EXT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/model/catalogOutputTokens.test.ts` | `0107fe16` | `1e83da49` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/config/catalog-integration.test.ts` | `98e4f031` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/config/parse-model-config.test.ts` | `01d3d31b` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/model/config/resolve-credentials.test.ts` | `01d3d31b` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/e2e/real-model-request.test.ts` | `e907801d` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/model/e2e/stream-real-model.ts` | `0bd91a82` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/model/errors.test.ts` | `c4a3143f` | `1e83da49` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/errors/normalize-error.test.ts` | `d7688811` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/google/request.test.ts` | `fdd19a35` | `1e83da49` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/google/runtime.test.ts` | `fdd19a35` | `1e83da49` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/helpers.ts` | `01d3d31b` | `746edb6e` | `SUPPORT` | `SUPPORT_ONLY` | P3 | - | `N/A` |
| `tests/model/litellmStreamingDefaults.spec.ts` | `2a776309` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/modelBestRealStreaming.smoke.spec.ts` | `2a776309` | `a70f585f` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/model/ollamaConfig.spec.ts` | `3f476914` | `733e91d5` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/openaiReasoningResponse.spec.ts` | `50c3da50` | `1b488aa1` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/openaiStreamCompletion.test.ts` | `0107fe16` | `1e83da49` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocol/clone.test.ts` | `b09501a3` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocolContract.spec.ts` | `53b60eec` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocols/anthropic-request.test.ts` | `01d3d31b` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocols/openai-request.test.ts` | `01d3d31b` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocols/response-and-stream.test.ts` | `01d3d31b` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/protocols/structured-output.test.ts` | `70d69a23` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/providerCatalog.spec.ts` | `31b44ff6` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/providerEndpoint.spec.ts` | `fb7b2870` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/providerEndpointFallback.spec.ts` | `f2b77cf8` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/providers/openai/request.test.ts` | `e0cd38de` | `293abc32` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/providers/openai/response.test.ts` | `75b75fb8` | `eaa48b18` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/request/thinkingAdapters.spec.ts` | `8df3f342` | `1b488aa1` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/runtime/model-runtime.test.ts` | `3b36119a` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/streaming/anthropic-thinking-signature.test.ts` | `d7688811` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/streaming/openai-reasoning.test.ts` | `21585b45` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/streaming/openai-think-tags.test.ts` | `ec67fd2f` | `746edb6e` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/streaming/parseTextToolCalls.spec.ts` | `53a0e993` | `2a8b7858` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/textToolCalls.spec.ts` | `76909ca7` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/model/tokenLimitParsing.spec.ts` | `53b60eec` | `a70f585f` | `MODEL` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/permission/permission-runtime.test.ts` | `e7c3d64b` | `746edb6e` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/pilot/config/classify-changes.test.ts` | `77297c70` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/pilot/config/gateway-config.test.ts` | `0128d8e7` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/pilot/config/load-pilot-config.test.ts` | `e907801d` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/pilot/config/memory-config.test.ts` | `0128d8e7` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/pilot/config/tools-config.test.ts` | `016c8f73` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/router/applyOrchestration.test.ts` | `5bc9923e` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/classifyAndRoute.test.ts` | `5bc9923e` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/decideScenario.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/fallback.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/fallbackPlan.spec.ts` | `2a776309` | `a70f585f` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/generateJudgePrompt.test.ts` | `5bc9923e` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/maxOutputTokens.test.ts` | `0107fe16` | `1e83da49` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/parseRouterConfig.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/parseTier.test.ts` | `5bc9923e` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/RouterDisabled.spec.ts` | `ba7a5e22` | `592bfe49` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/RouterRuntime.cacheAware.spec.ts` | `396f306c` | `733e91d5` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/runtime.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/sessionStore.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/streamingRecovery.e2e.spec.ts` | `2a776309` | `a70f585f` | `ROUTER` | `COVERED` | P0 | offline recovery | `CURRENT` |
| `tests/router/tokenStatsCollector.test.ts` | `5bc9923e` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/router/zeroUsageRetry.test.ts` | `7d08d896` | `746edb6e` | `ROUTER` | `COVERED` | P0 | 3 | `PARENT_FAIL` |
| `tests/scripts/bootstrap-pilotdeck-config.test.ts` | `02a54fc8` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/session/filesystem/backup-naming.test.ts` | `2d873e28` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/filesystem/create-restore-backup.test.ts` | `2d873e28` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/filesystem/file-history-store.test.ts` | `2d873e28` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/filesystem/tool-integration.test.ts` | `2d873e28` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/list-sessions.test.ts` | `0128d8e7` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/metadata.test.ts` | `0128d8e7` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/metadata/metadata-store.test.ts` | `631cb432` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/storage/list-all-sessions.test.ts` | `631cb432` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/storage/sanitize-session-id.test.ts` | `a6baabe7` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/storage/tool-results-dir.test.ts` | `d7688811` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/transcript/chain.test.ts` | `631cb432` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/transcript/control-boundary.test.ts` | `d7688811` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/transcript/replay-subagent.test.ts` | `a0501023` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/transcript/subagent-sidechain.test.ts` | `a0501023` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/worktree/find-canonical-project-root.test.ts` | `70d69a23` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/session/worktree/lru-map.test.ts` | `70d69a23` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/sessionListAiTitle.spec.ts` | `2be08654` | `ce628798` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/sessionTitleGenerator.spec.ts` | `2be08654` | `ce628798` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/status/agentStatus.test.ts` | `368c90e9` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/task/backgroundTaskRuntime.spec.ts` | `76909ca7` | `a70f585f` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/task/output-store.test.ts` | `2d873e28` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/task/runtime-lifecycle.test.ts` | `2d873e28` | `746edb6e` | `AGENT` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/ask-user-question.test.ts` | `98d40724` | `746edb6e` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/tool/bash-permissions-windows.test.ts` | `4dfeafa0` | `746edb6e` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/tool/bash.spec.ts` | `76909ca7` | `a70f585f` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-agent.test.ts` | `e8a30eae` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-bash-progress.test.ts` | `e8a30eae` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-bash.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-edit-notebook.test.ts` | `05f1a97e` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-edit-write.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-glob.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-grep.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-read-file.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-registry.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-skeleton.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin-web-search.test.ts` | `bbac2907` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin/bash/commandRunner.test.ts` | `8bcd7c90` | `8fc4894f` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/builtin/bash/permissions.test.ts` | `8bcd7c90` | `8fc4894f` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/tool/builtin/glob.spec.ts` | `07304675` | `bc228876` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/device-paths-windows.test.ts` | `4dfeafa0` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/e2e/real-web-search.test.ts` | `bbac2907` | `746edb6e` | `EXTERNAL` | `DEFER_EXTERNAL` | P2 | deferred | `DEFERRED` |
| `tests/tool/edit-normalization.test.ts` | `19d1c80f` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/executeCode.spec.ts` | `5d889878` | `2a8b7858` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/execution/PlanModeRuntimeConstraints.test.ts` | `3cf8665b` | `592bfe49` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/tool/input-validation.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/parity-legacy-contract.test.ts` | `e7c3d64b` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/tool/protocol-result.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/registry.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/runtime.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/scheduler.test.ts` | `e7c3d64b` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/task-tools.test.ts` | `2d873e28` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/taskTools.spec.ts` | `42c281b8` | `a70f585f` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/todo-write.test.ts` | `28a951b2` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/todoWrite.spec.ts` | `413f569b` | `2a8b7858` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/toolAvailability.spec.ts` | `76909ca7` | `a70f585f` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/web-fetch.test.ts` | `98d40724` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/webSearchAvailability.spec.ts` | `76909ca7` | `a70f585f` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tool/write-snapshots.test.ts` | `19d1c80f` | `746edb6e` | `TOOL` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tui/format-tool-summary.test.ts` | `2f8c7b56` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tui/group-consecutive-tools.test.ts` | `2f8c7b56` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tui/permission-prompt-detail.test.ts` | `329eaf6f` | `746edb6e` | `PERMISSION` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/tui/reducer-tool-output.test.ts` | `2f8c7b56` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tui/sidebar-helpers.test.ts` | `d747cd56` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/tui/truncate.test.ts` | `2f8c7b56` | `746edb6e` | `ADAPTER` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/turnRunnerSessionTitle.spec.ts` | `2be08654` | `ce628798` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/ui-server/download-headers.test.ts` | `115ff73d` | `eaa48b18` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/ui-server/no-dist-runtime-imports.test.ts` | `d2ab8522` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/ui-server/pilot-paths.test.ts` | `7eebf09f` | `293abc32` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/ui-server/pilotdeck-bridge.test.ts` | `8e2c731b` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/ui-server/skills-import-upload.test.ts` | `a652de85` | `eaa48b18` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/web-ui-client/gateway-browser-client.test.ts` | `b2b830b0` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/web-ui-client/protocol-sync.test.ts` | `b2b830b0` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/web-ui-client/web-message-reducer.test.ts` | `b2b830b0` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web-ui-parity/abort-turn-parity.test.ts` | `b2b830b0` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/web-ui-parity/dual-parity-text-stream.test.ts` | `b2b830b0` | `746edb6e` | `GATEWAY` | `COVERED` | P0 | 1 | `PARENT_FAIL` |
| `tests/web-ui-parity/history-vs-live-equivalence.test.ts` | `b2b830b0` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web-ui-server/flatten-canonical-message.test.ts` | `b2b830b0` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web-ui-server/legacy-session-presentation.test.ts` | `4fe2bebf` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web-ui-server/list-projects.test.ts` | `b2b830b0` | `746edb6e` | `FILES` | `COVERED` | P0 | 2 | `PARENT_FAIL` |
| `tests/web-ui-server/read-session-messages.test.ts` | `b2b830b0` | `746edb6e` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web-ui/parity-scenarios.test.ts` | `b2b830b0` | `746edb6e` | `REMOVED` | `OBSOLETE` | P3 | - | `CONTRACT_ONLY` |
| `tests/web/forkSession.test.ts` | `9619fa92` | `73c03d59` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/web/webMessage.status.test.ts` | `4446a238` | `a70f585f` | `SESSION` | `COVERED` | P1 | 4 | `CURRENT` |
| `tests/wiring/feature-wiring.test.ts` | `75ecded8` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `tests/wiring/runtime/createLocalGateway-tool-context.test.ts` | `75ecded8` | `746edb6e` | `CONFIG` | `COVERED` | P1 | 2 | `PARENT_FAIL` |
| `ui/server/utils/processSpawn.test.js` | `8bcd7c90` | `8fc4894f` | `UI_VIEW` | `COVERED` | P2 | 5 | `CURRENT` |
| `ui/src/components/app-shell/MainAreaV2.test.tsx` | `92ab221c` | `6b117859` | `UI_VIEW` | `COVERED` | P2 | 5 | `CURRENT` |
| `ui/src/components/chat-v2/linkifyFilePathsOutsideCode.spec.ts` | `81418efa` | `f32f973c` | `UI_STATE` | `COVERED` | P0 | 5 | `PARENT_FAIL` |
| `ui/src/components/chat-v2/MessageRowV2.test.tsx` | `760a47ee` | `73c03d59` | `UI_STATE` | `COVERED` | P0 | 5 | `PARENT_FAIL` |
| `ui/src/components/chat/hooks/useChatComposerState.attachments.test.tsx` | `df6705bf` | `c1a8ff77` | `UI_STATE` | `COVERED` | P0 | 5 | `PARENT_FAIL` |
| `ui/src/components/chat/hooks/useChatMessages.test.ts` | `760a47ee` | `73c03d59` | `UI_STATE` | `COVERED` | P0 | 5 | `PARENT_FAIL` |
| `ui/src/components/settings/view/tabs/PilotDeckConfigTab.cron.test.ts` | `979eefc7` | `65712c55` | `UI_VIEW` | `COVERED` | P2 | 5 | `CURRENT` |
| `ui/src/components/settings/view/tabs/PilotDeckConfigTab.webSearch.spec.ts` | `617b42fd` | `65712c55` | `UI_VIEW` | `COVERED` | P2 | 5 | `CURRENT` |

## Representative Parent Checks

All checks used Node 22.23.1 and a detached temporary worktree at the fixing
commit's parent. The test version from the fixing commit was used when it
existed; otherwise the focused current regression file was transplanted. Every
temporary worktree and log directory was removed after the run.

| Fix | Contract checked | Parent result |
| --- | --- | --- |
| `0f638c2c` | active-turn replay after refresh | `PARENT_FAIL` |
| `77cd3618` | replay only unresolved permission/elicitation requests | `PARENT_FAIL` |
| `e89746fd` | WebSocket disconnect aborts the in-flight turn | `PARENT_FAIL` |
| `629fcc6c` | plan-mode and safety permission precedence | `PARENT_FAIL` |
| `d52f2a34` | Router shutdown preserves an externally owned session store | `PARENT_FAIL` |
| `a166f14c` | agent/router default model conflict soft recovery | `PARENT_FAIL` |
| `ca8300bc` | collision-resistant project lookup | `PARENT_FAIL` |
| `320c9098` | failed editor load cannot save an empty replacement | `PARENT_FAIL` |
| `b09501a3` | nested canonical message/tool input clone isolation | `PARENT_FAIL` |
| `7d867bf3` | Anthropic cache breakpoint and transient retry semantics | `PARENT_FAIL` |
| `aee27337` | Always-On execution denies `git push` and `git remote` | `PARENT_FAIL` |
| `f914ecdf` | terminal plan status synchronizes `executionStatus` | `PARENT_FAIL` |
| `2536cbdb` | MCP save invokes extension reload with project/path scope | `PARENT_FAIL` |
| `3e3098d0` | sentinel API-key providers and orphan Router refs are purged | `PARENT_FAIL` |

## Deferred Matrix

The non-required `External Nightly` workflow now owns real-model/provider,
agent/context/web-search, Router accuracy and WCB/Docker smoke. Those rows stay
classified `DEFER_EXTERNAL` relative to the deterministic PR gate and retain
`DEFERRED` historical validation until a credentialed run records evidence.

Platform IM channels, desktop updater, Office integration and cross-platform
installation remain deferred beyond this workflow. They require dedicated
runners and test accounts and must not be reported as executed by either
`pnpm check` or the browser smoke.

## Current Batch Evidence

The following public-entry tests and reverse-mutation proofs were added after
the initial audit. `MUTATION_FAIL` means the current test passed, the exact
reverse mutation compiled, and the named test produced one behavioral failure
in an isolated copy. Items without that proof remain `CURRENT` and are not
promoted by implication. For paths listed here, this evidence supersedes the
older `CURRENT` marker in the historical row.

| Current path | Public contract | Proof case | Status |
| --- | --- | --- | --- |
| `tests/adapters/wecom-lifecycle.spec.ts` | WeCom AI Bot subscribe, callback/permission pairing, heartbeat, close abort, reconnect and intentional stop | `wecom-close-abort` | `COVERED / MUTATION_FAIL` |
| `tests/adapters/webhook-entrypoint.spec.ts` | Webhook health, route/HMAC validation, delivery/reply, duplicate suppression and port release | deterministic entry test | `COVERED` |
| `tests/gateway/gateway-lifecycle-regressions.spec.ts` | busy-session rejection, abort unwind, active replay filtering, WebSocket close abort | `gateway-busy-session`, `gateway-abort-awaits-unwind`, `gateway-active-replay-pending-only`, `gateway-ws-close-abort` | `COVERED / MUTATION_FAIL` |
| `tests/regressions/config-state-file-regressions.spec.ts` | config model conflict recovery, externally-owned router store, collision-resistant IDs, idempotent history and snapshot eviction | `config-model-conflict-soft-recovery`, `router-store-survives-shutdown`, `project-id-collision-resistance`, `file-history-idempotent-first-snapshot`, `file-history-snapshot-eviction` | `COVERED / MUTATION_FAIL` |
| `tests/regressions/model-router-regressions.spec.ts` | nested message/tool clone isolation, Anthropic cache cap/transient retry, fallback suppression and zero-usage retry | `model-tool-result-clone-isolation`, `model-tool-call-clone-isolation`, `anthropic-cache-breakpoint-cap`, `anthropic-transient-retryability`, `router-fallback-hides-failed-attempt`, `router-zero-usage-retry` | `COVERED / MUTATION_FAIL` |
| `tests/router/streaming-recovery.spec.ts` | deterministic SSE recovery order and continuation context | `router-stream-recovery-order` | `COVERED / MUTATION_FAIL` |
| `tests/regressions/always-on-session-adapter-regressions.spec.ts` | bypass safety deny, terminal plan-state sync and transcript/TUI event pairing | `always-on-bypass-deny`, `always-on-plan-terminal-sync`, `tui-tool-event-pairing` | `COVERED / MUTATION_FAIL` |
| `ui/src/components/chat/hooks/useChatComposerState.busySend.test.tsx` | queued attachment snapshot survives edits until the active turn completes | `ui-queued-attachment-snapshot` | `COVERED / MUTATION_FAIL` |
| `ui/src/contexts/WebSocketContext.lifecycle.test.tsx` | token replacement isolates stale close callbacks from reconnect state | `ui-stale-websocket-close` | `COVERED / MUTATION_FAIL` |
