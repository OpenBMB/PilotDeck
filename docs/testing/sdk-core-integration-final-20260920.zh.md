# SDK/Core Integration 系统回归最终报告（2026-09-20）

## 结论

当前分支 `codex/integrate-sdk-0901` 在固定产品基线 `origin/main` 上完成了 Core、SDK、native/production-sidecar 和架构边界回归。没有发现需要新增的 P1/P2 根因；上一轮已提交的九类修复在当前 HEAD 上全部有 focused regression 和 production trace 证据。本轮另修正 `PilotDeckClient.startup` 的初始化超时语义并补直接生命周期回归；最终代码修复与报告修正将在本轮提交，验证完成后保持 worktree 干净。

Frontend integration 不在本轮授权范围内，不能解读为已验收。

### 四项结论（按用户编号）

1. **所有模块解耦：部分成立。** AgentLoop/Module Protocol/sidecar 适用边界逐项核对通过；Session、Gateway、Workflow、Plugin、Cron、Always-On、Goal、Web 等宿主模块确认仍由 host 持有，但它们不是本次 AgentLoop sidecar port 契约的目标，不能据此宣称“所有仓库模块都已解耦证明”。完整归属、依据和未验证项见下文。
2. **所有模块 test 通过：按适用清单成立，绝对保证不成立。** 清单中的适用测试均通过；root 的 2 个 skip、host-only 未做 sidecar 对拍的模块和外部环境边界保留，不计为通过。
3. **所有模块接入真实 PilotDeck 前端：未验证且明确排除。** 本轮没有运行 Frontend integration。
4. **SDK 功能正确：已覆盖功能成立，完整 SDK 无条件正确不成立。** 所有公开 runtime 方法均列入 API 表并绑定实现/测试；类型/示例和真实外部 deployment 的限制单独标记。
5. **解耦版与 main 字面完全一致：不成立。** 当前 native/sidecar 在 shared projection 下通过；与 main 仍存在下列精确、已声明的语义差异和 19 个 main 缺失能力，是否接受这些扩展需要产品决策，不能由本报告替用户放宽“完全一致”标准。

## 固定基线

| 项目 | 值 |
| --- | --- |
| 当前分支 / HEAD | `codex/integrate-sdk-0901` / `b15d2080ed06f0330485c96f8add48b14b3b721d` |
| 产品行为基线 | `origin/main` = `cd52c9af812a84c27a9dd1b7ccf246f48540045f` |
| 架构边界基线 | `Kaguya-19/refactor/core_agent_loop_0831` = `e55b0a82d07ee3951e5812c34103400dfa6043f7` |
| 开始时工作区 | clean；保留策略已确认，无用户改动需要合并 |
| Runtime | Node `v22.23.1`，Python `3.12.2`，pnpm `10.32.1` |

## 行为契约矩阵

| 行为族 | main/native/sidecar 契约 | owner 与回归证据 | 结果 |
| --- | --- | --- | --- |
| admission、submit、abort、timeout、close、shutdown、dirty recreate、reload | admission fence、session publication、terminal 和后续副作用保持因果；close 后旧 admission 不得 submit | Gateway/session focused tests；`abort_turn prevents submit while session_creation is pending`；production `deadline`/`cancel`/parent-close | PASS |
| SDK config、MCP、seedReadState、flag 与 turn/maintenance 并发 | control 与 turn 共用 host admission；busy 检查后不能插入未受保护的新 turn | SDK control tests、seed-read-state、Gateway reservation tests | PASS |
| current/base permission mode | mode 由 Gateway permission registry 持有；plan wire override 不是第二 owner；失败、重建、退出保持 base | permission mode state、dirty recreation、plan-mode 两场景、sidecar permission traces | PASS |
| prepare、materialize、stream、retry、fallback、三类 compaction | preparation reference 只在 host model adapter 生命周期内；wire 只带 canonical request/reference；retry 保持冻结快照 | `llm-model-port`、context-cap、stream recovery、full/projected compaction budget | PASS |
| request controls、prompt/tools/cache/output cap、budget、usage、错误 | provider-visible request、独立 o200k evidence、错误 code/retryability 和 terminal 均逐字段比较 | comparator `53/53`、budget evidence `2/2`、model/tool error suites | PASS |
| durable-before-visible、callback failure、terminal、replay/reconnect | durable commit 先于可见 projection；callback failure fail-closed；`result_unknown` 只能由 host ledger reconcile | session replay/compaction/fork/deferred tests、operation ledger、sidecar reconnect traces | PASS |
| tools、subagent、live steer、interaction、lease、teardown | Tool/permission/subagent/lease/dispose owner 留在 host；sidecar 只消费 capability ports | module/capability/subagent/steer suites、production live-steer/elicitation/subagent scenarios | PASS |
| Gateway、SDK、Web replay/bridge、history、plugin | Gateway/session persistence 是 durable truth；SDK/Web/plugin 只消费 projection 或 host snapshot | root session/web/plugin suites、SDK package tests、`compact-replay`/fork projection | PASS |

## 模块与架构 inventory

| 模块族 | AgentLoop port | Native provider | Sidecar provider/consumer | Host adapter / state owner | 主要测试 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| model/LLM | `ModelExecutionPort`、routing、metadata、budget、auxiliary；`ModelInvokerPort` 仅兼容 | `routerModelInvokerAdapter` / host model runtime | `hostModelInvokerPort` + `model.prepare`/`stream` dispatcher | Router/provider preparation、retry、usage 由 host 持有 | `llm-model-port.spec.ts`、model override/retry/compaction | verified |
| context | prepare、tool-results、recovery、capture、compaction ports | `DefaultContextRuntime` / native compaction | `hostContextRuntime`，按 manifest 广告 operation | prompt/cache/token accounting/compaction durable owner 在 host | `context-host-runtime`、context-cap、replay | verified |
| capability/tool | `ToolPort` / `ToolExecutionPort` 与 authorization | `ToolScheduler` adapter | `hostToolPort`、`execute(_batch)`、plan/todo | ToolRuntime、permission preflight、side effects、checkpoint 在 host | capability-tool-port、tool/error/permission suites | verified |
| permission/interaction | permission decision、elicitation/dialog ports | PermissionRuntime/dialog runtime | `hostPermissionDecisionPort`、durable elicitation channel | current/base mode、audit、dialog lease 在 Gateway/session host | permission-mode、sidecar、SDK dialog tests | verified |
| checkpoint/seed | host-neutral seed projection | `HostToolCheckpoint` / native seed state | serialized `seedState` projection | file state map、read freshness、mutation owner 在 host | checkpoint seed projection、seed-read-state | verified |
| lifecycle/events | lifecycle dispatch 与 volatile event bridge | HookRuntime/event emitter | `hostLifecycleRuntime`、`hostAgentEventBridge` | plugin/hook environment、durable session event owner 在 host | lifecycle/event bridge/default-factory | verified |
| transport/protocol | 不向 AgentLoop 暴露 transport state | native adapter | stdio/TCP client/server、manifest、NDJSON Module Protocol v2 | connection/replay/operation ledger/dispose owner 在 transport/host composition | module-protocol、sidecar-client、TCP/replay | verified |
| turn/session/subagent | turn callbacks、execution identity、窄 lifecycle view | AgentSession/Gateway composition | sidecar turn composition，不创建第二 session truth | admission、session publication、subagent generation/lease 在 host | session router、agent inbox、subagent 及 close/abort suites | verified |

### 完整目录派生与适用性

下表从 `docs/trd/03-agent-loop-modular.zh.md`、`docs/agent-loop-modular-index.zh.md`、`src/agent/modules/**`、`src/agent/scope/**` 以及宿主 composition 入口派生。`in-scope` 表示必须满足 AgentLoop/sidecar 窄 port 契约；`host-owned` 表示状态/资源边界需要核对但不应迁入 AgentLoop；`not sidecar-target` 不是 PASS，也不是缺陷。

| 目录/模块族 | 边界依据与代表调用链 | state/dispose owner | 适用性与证据 | 结论 |
| --- | --- | --- | --- | --- |
| `src/agent/modules/llm`、`budget` | `AgentLoop -> ModelExecutionPort.prepare/stream -> hostModelInvokerPort -> model dispatcher`; routing/metadata/budget 为独立可选 ports | host Router/provider preparation、usage/budget；transport 只持有 operation | in-scope；`llm-model-port.spec.ts`、`default-factory.spec.ts`、sidecar compaction/stream raw trace | verified |
| `src/agent/modules/context` | `AgentLoop -> ContextPreparation/ToolResult/Recovery/Capture/CompactionPort -> hostContextRuntime -> context module_call` | ContextRuntime、prompt/cache/compaction persistence 在 host | in-scope；`context-host-runtime.spec.ts`、`context-cap.spec.ts`、`compaction-*` | verified |
| `src/agent/modules/capability` | `AgentLoop -> ToolAuthorization/ExecutionPort -> hostToolPort -> capability.execute(_batch)` | ToolRuntime/scheduler、permission preflight、tool side effects、checkpoint 在 host | in-scope；`capability-tool-port.spec.ts`、`ports-adapter.spec.ts`、tool/permission suites | verified |
| `src/agent/modules/permission`、`interaction` | `AgentLoop -> permission/elicitation ports -> hostPermissionDecisionPort/durable channel` | Gateway permission registry、audit、dialog pending/lease/dispose | in-scope；`permission-decision-port.spec.ts`、`host-permission-mode-state.spec.ts`、SDK dialog tests | verified |
| `src/agent/modules/checkpoint` | `AgentLoop seed -> serialize/validate seedState -> HostToolCheckpoint -> host terminal` | host file-state maps and durable checkpoint | in-scope；`checkpoint-seed-state-projection.spec.ts`、`seed-read-state.spec.ts` | verified |
| `src/agent/modules/lifecycle`、`events` | `AgentLoop event/hook -> hostLifecycleRuntime/hostAgentEventBridge -> Gateway projection` | plugin/hook environment and durable event store in host; event bridge is volatile | in-scope；`host-lifecycle-runtime.spec.ts`、`host-agent-event-bridge.spec.ts` | verified |
| `src/agent/modules/transport`、protocol v2 | `stdio/TCP connection -> hello/capabilities -> execute/module_call -> operation ledger -> terminal` | connection/replay/operation ledger/dispose in transport/host composition | in-scope；`module-protocol.spec.ts`、`sidecar-client.spec.ts`、`tcp-sidecar-transport.spec.ts` | verified |
| `src/agent/loop`、`turn` | `Session -> TurnRunner -> AgentLoop`; loop receives only `AgentTurnCapabilities` and lifecycle/context ports | Session/TurnRunner/inbox/admission remain host-owned | in-scope; `ports-adapter.spec.ts`, `agent-loop-factory.spec.ts`, turn/session suites | verified |
| `src/agent/session`、`sub`、`scope` | `Gateway -> AgentSession/AgentRuntimeScope -> AgentHandle -> AgentLoop`; subagent provider registry supplies scoped child | session publication, generation lease, child transcript and dispose in session/scope host | host-owned composition; `agent-session-runtime-bundle.spec.ts`, `session-router-lifecycle.spec.ts`, subagent suites | verified owner; not a second sidecar state owner |
| `src/session/events`, `persistence`, `projection` | `Gateway -> ProjectSessionDataPlane -> event store/persistence -> projection/checkpoint -> Web/SDK read side` | selected persistence provider and projection checkpoint | host-owned; `project-session-data-plane.spec.ts`, `session-event-store.spec.ts`, `session-projection-driver.spec.ts`, replay tests | verified owner; not sidecar-target |
| `src/session/catalog`, `history`, `search` | `Gateway/Web -> selected catalog/history/search ports`; no backend fallback when capability absent | selected provider owns catalog/read/search resources | host-owned; `project-session-read-side-bundle.spec.ts`, `project-session-transcript-reader.spec.ts`, `project-session-search-port.spec.ts`, Web catalog tests | verified owner; no sidecar proof required |
| `src/session/fork`, `replacement`, `filesystem` | Web/Gateway plans operation -> provider performs durable target write/backup/rewrite/finalize -> publication | selected fork/replacement provider and Gateway live reservation | host-owned; `fork-session-storage-provider.spec.ts`, `replace-last-turn-storage-provider.spec.ts`, replacement coordinator tests | verified owner; not sidecar-target |
| `src/extension/plugins`、skills/hooks | `PluginRegistry generation -> PluginRuntimeView/snapshot -> session/context/command composition` | PluginRegistry owns generation leases and final dispose; session gets immutable snapshot | host-owned; `plugin-registry-lifecycle.spec.ts`, `command-contribution-snapshot.spec.ts`, plugin/skill tests | verified owner; not AgentLoop module |
| `src/plan-todo` | `SessionPlanTodoBundle -> hostPlanTodoPort -> capability.plan_todo`; sidecar only gets validated active-session snapshot | Session projection is sole durable owner | host-owned optional capability; `native-plan-todo-runtime.spec.ts`, `host-plan-todo-port.spec.ts`, session plan bundle tests | verified boundary; not generic sidecar state |
| `src/cron` | `ProjectAutomationBundle -> CronControlPort/CronRuntime -> CronTaskStore/Scheduler` | project automation store and scheduler own records/run dispose | host-only; `cron-control-port.spec.ts`, `cron-agent-gateway-port.spec.ts`, cron editing tests | implemented host feature, not AgentLoop decoupling target |
| `src/always-on` | `AlwaysOnManager/Runtime -> AlwaysOnControlPort -> project storage/run context/channel lease` | project storage provider, run context registry and channel lease | host-only; `always-on-control-port.spec.ts`, session catalog consumer tests | implemented host feature, not AgentLoop decoupling target |
| `src/goal` | `SessionGoalBundle -> GoalPort/NativeGoalRuntime -> goal projection/checkpoint -> tool` | session-bound goal runtime/projection | host-only; `goal-runtime.spec.ts`, `project-goal-composition.spec.ts`, builtin goal tests | implemented host feature, not AgentLoop decoupling target |
| `src/workflow` | caller-owned Definition/Run/Control -> InMemory/JSONL event store -> run lifecycle | caller owns workflow run/store/dispose; no AgentLoop/Gateway takeover | host-only vertical core; `workflow-run.spec.ts`, `jsonl-workflow-event-store.spec.ts`, `workflow-composition.spec.ts` | generic core is decoupled; domain/sidecar integration is a separate product scope |
| `src/gateway`、`src/web`、SDK bridge | `SDK/Web -> Gateway protocol -> session/turn composition`; Web replay/bridge projects host events | Gateway owns session/turn/durable truth; SDK/Web owns only transport/projection handles | host integration; `sdk-controls.spec.ts`, `gateway-turn-completion-fence.spec.ts`, Web replay/fork/replace suites | shared entrypoints verified; frontend integration excluded |

静态边界检查确认 `AgentLoop` 没有重新引入 `Router`、`Gateway`、`SessionRuntime`、Plugin aggregate 或 `AgentRuntimeDependencies` 依赖；Router 只在 native adapter/application composition。`MODULE_PROTOCOL_VERSION` 仍为 `2.0`。sidecar raw trace 的 53 个场景均出现 `handshake_completed` 与 `module_call_received`，不是 test factory 或 fake runner。

### Host-owned 模块替换边界复核（2026-09-20）

host-owned 不等于未解耦。本轮对仍未作为 AgentLoop sidecar 目标的模块读取真实 import、port、状态和 dispose 路径，并按“已满足边界 / 存在具体耦合 / 需要产品决策”区分：

| 模块 | 真实依赖与状态 owner | dispose/替换边界 | 结论 |
| --- | --- | --- | --- |
| `src/workflow` | 只依赖自身 `protocol`；`WorkflowRun` 接收 caller-owned `WorkflowEventStore` 与 `WorkflowExecutionAdapter`，事件绑定和 snapshot 由 run/store 持有 | `WorkflowRun.dispose()` 取消并等待执行；`composeWorkflow` 返回 caller-held run/control，没有 registry、Gateway 或 AgentLoop 引用 | generic workflow core 已满足解耦；接入具体领域 caller 或 sidecar 需要单独产品决策，不是当前边界缺陷 |
| `src/cron` | `CronControlPort` + 仅三项操作的 `CronAgentGatewayPort`；project storage provider 持久化 task/run，`CronRuntime` 持有 scheduler/active runs | `CronRuntime.stop()`/`CronManager.stop()` 停 scheduler、等待启动、清理 runtime；Gateway 只替换窄 turn facade，不能替换 storage owner | 存在明确的 host automation 与 Gateway turn facade 耦合，但没有宽 Gateway/SessionRuntime 依赖；作为 host feature 合理，sidecar 化需产品决定 |
| `src/always-on` | `AlwaysOnControlPort` + `AlwaysOnAgentGatewayPort`；project storage、run-context registry、channel lease、session catalog/transcript reader 分别由 runtime/注入 provider 持有 | `AlwaysOnRuntime.stop()` 停 scheduler、等待 active control runs、清理 project contexts/overrides；Gateway 只提供窄 turn facade | 存在有意的 project/session read-side 耦合，owner 清晰且可由 provider 替换；不属于 AgentLoop port 违规，扩大到 sidecar 需产品决定 |
| `src/goal` | `GoalPort.forSession()` 只暴露 session handle；`NativeGoalRuntime` 依赖 `SessionProjectionDriver` + `AgentTranscriptWriter`，projection/transcript 是 durable truth | session id 校验阻止跨 session 使用；mutation tail 串行化，runtime 不拥有 Gateway/AgentLoop state | 已满足窄 port 与单一 host durable owner；这是 session data-plane 绑定，不是重复 owner |
| `src/plan-todo` | `PlanTodoPort.forSession()` 返回既有 tool-facing handle；native runtime 只依赖 projection/transcript ports | session id/turn id 校验；所有 mutation 先写 transcript event，projection 是唯一 snapshot owner | 已满足窄 port 与单一 owner；sidecar 仅消费 host snapshot，不能据此要求迁移 durable state |
| `src/gateway`/`src/web`/SDK bridge | Gateway composition 持有 session/turn/durable truth；Web/SDK 只消费 protocol/projection | Gateway shutdown/operation fence 与 Web replay/SDK transport 各自关闭；Frontend integration 按 goal 明确排除 | 是宿主边界而非 AgentLoop 解耦目标；真实前端遍历仍未验证，不能扩大为 PASS |

上述结论由 `WorkflowRun`/`WorkflowComposition`、`CronRuntime`/`CronManager`、`AlwaysOnRuntime`、`NativeGoalRuntime`、`NativePlanTodoRuntime` 及对应 port/type 文件的静态调用路径，结合各模块 focused tests 得出；未用“没有 sidecar 对拍”作为耦合判据。

### 模块测试映射与缺口

| 清单层 | 具体执行入口/测试名 | 结果与限制 |
| --- | --- | --- |
| AgentLoop ports/adapter | `tests/agent/modules/ports-adapter.spec.ts`: “capabilities expose only turn context...”, “accept explicit model port without a router”, “sidecar capabilities compose explicit ports...” | focused run included; PASS; covers dependency direction, not every host module |
| Model/context/capability/permission | `llm-model-port.spec.ts`, `context-host-runtime.spec.ts`, `capability-tool-port.spec.ts`, `permission-decision-port.spec.ts` representative names listed above | 433/433 focused PASS; provider/network external behavior excluded |
| Protocol/sidecar/replay | `module-protocol.spec.ts`: v2 validates handshake/execute/error; `sidecar-client.spec.ts`: durable persistence, stream, budget, compaction, reconnect; `tcp-sidecar-transport.spec.ts`, `stream-replay-store.spec.ts` | PASS; 53 production stdio proofs; no remote deployment claim |
| Session/scope/subagent | `session-router-lifecycle.spec.ts`: close/shutdown/dirty recreate; `agent-session-runtime-bundle.spec.ts`; `SubagentContinuationManager`/`OneShotSubagentPort` suites | PASS in root/focused suites; no claim that all provider implementations are exhaustively fuzzed |
| persistence/read-side/fork/replacement | `project-session-data-plane.spec.ts`, `project-session-read-side-bundle.spec.ts`, `project-session-transcript-reader.spec.ts`, `fork-session-storage-provider.spec.ts`, `replace-last-turn-storage-provider.spec.ts`, `transcript-replay-compaction.spec.ts` | PASS; selected provider contracts tested; external DB/object-store not run |
| plugin/skills/plan-todo | `plugin-registry-lifecycle.spec.ts`, `command-contribution-snapshot.spec.ts`, `native-plan-todo-runtime.spec.ts`, `host-plan-todo-port.spec.ts`, `session-plan-todo-bundle.spec.ts` | PASS; host-owned, not sidecar module ownership |
| cron/always-on/goal/workflow | `cron-control-port.spec.ts`, `always-on-control-port.spec.ts`, `goal-runtime.spec.ts`, `workflow-run.spec.ts`, `jsonl-workflow-event-store.spec.ts`; Node 22 dist boundary batch | `38/38 PASS` for listed local contracts and real stdio Goal composition; Workflow domain caller integration and frontend integration remain separate product scopes |
| Gateway/Web/SDK bridge | `sdk-controls.spec.ts`, `gateway-turn-completion-fence.spec.ts`, `compact-replay.spec.ts`, `fork-session-projection.spec.ts`, `replace-last-turn.spec.ts`, SDK `transport.test.ts` | PASS for Gateway/SDK/Web tests; real frontend all-module traversal excluded |

No applicable test in the above mapping was skipped. Root suite has exactly 2 unrelated skips; they remain reported as skips rather than PASS.

## SDK 公共 API/functionality matrix

| 能力组 | 公开入口 | 当前实现与测试 | 分类 |
| --- | --- | --- | --- |
| query/startup/stream/abort/steer | `query`、`startup`、`createQuery`、`PilotDeckQuery` | transport、stream、result_unknown、abort、live steer | correctly implemented and tested |
| session/history | client session list/info/messages、export/restore、rename/tag/fork/delete、replacement | Gateway authoritative session store；replay/fork/replace tests | correctly implemented and tested |
| settings/flags/permission | `resolveSettings`、`updateSettings`、`applyFlagSettings`、permission callbacks/mode | allowlist、busy rejection、current/base mode、redacted settings tests | correctly implemented and tested |
| MCP/tools | `defineTool`、`createSdkMcpServer`、MCP resource client、dynamic controls | stdio/HTTP/SSE alias、deferred tools、permission override、tool progress | correctly implemented and tested |
| context/checkpoint/budget/usage | `seedReadState`、`getContextUsage`、`usage`/`modelUsage`、max/task budget | host-owned accounting、retention clock、checkpoint replay | correctly implemented and tested |
| dialogs/hooks | terminal/browser/DOM/manual renderers、elicitation、user-dialog resources、hooks/deferred hooks | renderer validation/abort/lease/recovery/hook auth tests | correctly implemented and tested |
| subagents/plugins/skills | AgentDefinition、subagent messages、plugin/skill descriptors | validation before connect、Gateway ownership、session scoped composition | correctly implemented and tested |
| embedded | `@pilotdeck/sdk/embedded` host/client/tool registry | embedded Gateway ownership and detach/dispose tests | correctly implemented and tested |
| examples/docs | 14 SDK examples and public docs | package build plus `check-public-docs.mjs` (`46` runtime symbols, `2` exports) | correctly implemented and tested |
| external provider/deployment parity | real provider keys, remote/queued deployment, Desktop visual integration | intentionally not run in this worktree | not applicable / unverified |

SDK `127/127` tests cover the public surface listed below; no API was removed to obtain parity. SDK-only additions remain explicitly typed extensions and are not treated as main parity requirements.

### 完整 runtime exports 与对象方法

| 入口 | 完整方法/成员清单 | 实现锚点与具体验证 | 结论 |
| --- | --- | --- | --- |
| root `@pilotdeck/sdk` | `query`, `tool`, `startup`; `createQuery`, `createWarmQuery`, `createPilotDeckClient`; session helpers `listSessions`, `getSessionMessages`, `getSessionInfo`, `exportSessionTranscript`, `restoreSessionTranscript`, `prepareLastTurnReplacement`, `renameSession`, `tagSession`, `forkSession`, `resolveSettings`, `deleteSession`, `getSubagentMessages`, `listSubagents`; `defineTool`, `createPilotDeckMcpServer`, `createSdkMcpServer`; `GatewayTransport`, `AsyncEventQueue`, `mapError`, `PilotDeckError`, `AbortError`; `InMemorySessionStore`, `FileSessionStore`, `createSessionStoreFromAdapter`; terminal/browser/DOM/manual dialog factories; all type exports from `types.ts` | `src/index.ts`, `client.ts`, `transport.ts`, `session-store.ts`; package tests 1-123 and Gateway SDK E2E | runtime exports verified; type aliases compile |
| `PilotDeckClient` 顶层 | `connect`, `describeServer`, `close`, `query`, `startup` | `types.ts:1350-1355`, `client.ts:2966-3035`; facade/handshake/transport tests directly cover `connect`、`describeServer`、`close`、`query` and resource composition；新增 tests “client startup uses its connection defaults and Gateway-owned warm query”, “client startup applies initializeTimeoutMs to the handshake and closes the timed-out transport”, “client close rejects later asynchronous lifecycle calls...” | `connect`/`describeServer`/`close`/`query`/`startup` covered；`initializeTimeoutMs` 现在是 typed initialization timeout，默认连接参数、超时 transport teardown 和 close 后 Promise rejection 均有公共入口证据 |
| `PilotDeckQuery` | Async iterator `next/return/throw`; `close`, `result`, `interrupt`, `steer`, `cancelSteer`, `submitAsyncHookResult`, `respondUserDialog`, `abort`, `setPermissionMode`, `setMcpPermissionModeOverride`, `setModel`, `setMaxThinkingTokens`, `applyFlagSettings`, `updateSettings`, `initializationResult`, `reinitialize`, `supportedCommands`, `supportedModels`, `supportedAgents`, `mcpServerStatus`, `getContextUsage`, `usage`, `modelUsage`, `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, `readFile`, `reloadPlugins`, `reloadSkills`, `outputStyles`, `setOutputStyle`, `reloadOutputStyles`, `accountInfo`, `rewindFiles`, `seedReadState`, `reconnectMcpServer`, `toggleMcpServer`, `setMcpServers`, `streamInput`, `stopTask`, `backgroundTasks` | `types.ts:1082`; `client.ts` Query object; tests include “query maps Gateway tool progress...”, “streamInput forwards later user messages...”, “SDK thinking and rewind controls...”, “SDK MCP controls...”, “query round-trips permission and elicitation callbacks”, “query reports result_unknown...” | all except `accountInfo` have implementation evidence; `accountInfo()` is an intentional `unsupported_capability` stub documented in `packages/sdk/README.md` and the SDK roadmap, with no Gateway account contract. Therefore SDK full correctness is not claimed |
| `PilotDeckClient.sessions` | `create`, `get`, `resume`, `list`, `messages`, `info`, `exportTranscript`, `restoreTranscript`, `fork`, `prepareLastTurnReplacement`, `close`, `rename`, `tag`, `delete`; returned replacement has `start`/`rollback` | `types.ts:1279+`, `client.ts` session facade; tests “client exposes Gateway-authoritative session, run and resource facades”, “resumeSessionAt forks...”, “SDK exports and restores...”, transcript/replace E2E | covered |
| `PilotDeckClient.runs` | `start`; `PilotDeckRunHandle.events`, `result`, `steer`, `cancelSteer`, `abort` | `types.ts:1259+`; transport/run observation, active turn and steer tests | covered |
| `PilotDeckClient.projects/files/models/commands/skills` | projects `list/get`; files `list/read`; models `list/get/set/clear`; commands `list`; skills `list/read` | `client.ts` resource facades; package tests “client exposes Gateway-authoritative session, run and resource facades”, list/read/settings validation tests | covered for Gateway contract; no remote deployment claim |
| `PilotDeckClient.mcp` | `status`, `setServers`, `reconnect`, `toggle`, `setPermissionModeOverride` | package tests “SDK MCP controls are session-scoped...”, “SDK MCP permission override...”, dynamic MCP control tests | covered |
| `PilotDeckClient.dialogs` | `list`, `watch`, `claim`, `release`, `respond` | package tests “client projects and serializes live user-dialog renderer leases”, dialog recovery/lease E2E | covered |
| `PilotDeckClient.cron/config/extensions` | cron `create/list/update/delete/stop/runNow`; config `reload`; extensions `reload` | `types.ts:1368+`, `client.ts`; package/client resource tests and root cron/extension suites | covered for typed Gateway contract; no full frontend traversal |
| `@pilotdeck/sdk/embedded` | `createEmbeddedSessionStore`, `toEmbeddedTool`, `createEmbeddedQuery`, `createEmbeddedPilotDeckClient`, `createEmbeddedToolRegistry`, `createEmbeddedPilotDeckHost`; `PilotDeckEmbeddedTransport`, `PilotDeckEmbeddedToolRegistry`, host lifecycle methods | `embedded.ts`; tests “embedded host composes...”, “embedded transport uses Gateway wire frames...”, “embedded client exposes resource facades...” | covered |
| utility classes/functions | `GatewayTransport` (`connect`, `request`, `close`, notifications/reconnect); `InMemorySessionStore`/`FileSessionStore`/adapter; terminal/browser/DOM/manual dialog renderers; `HostedHookServer`; `PilotDeckMcpServerImpl`; `filterEscalatingDefaultMode` | respective source files; tests 1-23, 65-97, 110-114 | covered in deterministic/local host; external browser/provider not covered |

The package has two declared export targets (`.` and `./embedded`). `check-public-docs.mjs` checks documentation links and declared symbols, not API completeness; this report therefore uses `src/index.ts`, `embedded.ts`, `types.ts`, `client.ts` and the concrete tests above as the completeness source.

### SDK 未验证/仅类型或示例

`accountInfo()` is the one explicitly known missing runtime capability: its implementation throws `unsupported_capability`, matching the documented Claude account/login gap. Other listed runtime methods have direct or indirect deterministic transport/Gateway evidence, although not every method has a one-test-per-method case. Remaining limits are deliberate: real external provider billing/stream quirks, remote/queued deployment, arbitrary third-party MCP servers, and frontend-only rendering are not verified. Type aliases and examples are compile/documentation evidence, not independent behavioral proof.

## 与 origin/main 的严格差异

“字面完全一致”结论为 **不成立**。当前 same-version native/sidecar comparison 只证明两种当前 composition 在 comparator projection 下相同；baseline comparison 对以下差异按精确 path/value 声明扩展放行，不能把它们改写成 main 一致：

| 场景 | raw evidence | main baseline | 当前 native/sidecar | 差异类别与决策 |
| --- | --- | --- | --- | --- |
| `deadline` | `/tmp/pilotdeck-parity-sdk-core-final-20260920/deadline-pilotdeck-baseline-drift.md` 与四个 JSONL | **baseline** 只有 `agent.status.turn_timeout`，没有 `durable.status`；comparator 的 `partialOrder.left... = durable_before_visible -> missing` 是 baseline 规则预期/实际诊断，不是 baseline/current 值。baseline terminal `durableStopReason/resultType = null` | **current native** 有 `durable.status` sequence 4 先于 `agent.status` sequence 5，terminal `durableStopReason = aborted_streaming`、`resultType = aborted`；**current sidecar** 有 durable status sequence 22 先于 agent status sequence 23，operation outcome 另为 `result_unknown` | current 新增 durable-before-visible marker，且 native terminal 字段改变；两者都是共有 timeout/abort 的真实差异，当前契约虽精确声明为收口扩展，仍未获用户对“完全一致”的豁免 |
| `deadline_during_tool` | `/tmp/pilotdeck-parity-sdk-core-final-20260920/deadline_during_tool-pilotdeck-baseline-drift.md` 与 JSONL | **baseline** 只有 timeout/tool 侧的可见记录，没有 durable timeout marker；`partialOrder.left... = durable_before_visible -> missing` 表示 baseline marker 缺失 | **current native/sidecar** 均新增 durable timeout status，并在可见 timeout 前提交；差异报告中的 `missing` 是 baseline 缺失，不是 current 缺失 | current durable-before-visible marker 是真实共有行为扩展；精确声明不等于 main 一致 |
| `sidecar_live_steer` | `/tmp/pilotdeck-parity-sdk-core-final-20260920/sidecar_live_steer-pilotdeck-baseline-drift.md` 与 JSONL | **baseline** 没有 `durable_steer` marker；`partialOrder.left... = durable_before_applied -> missing` 表示 baseline marker 缺失 | **current native/sidecar** 均新增 durable steer record，并在 `parity-steer-1` applied 前完成 | current durable-before-applied marker 是真实共有行为扩展；精确声明不等于 main 一致 |
| `auto_compact` | `auto_compact-pilotdeck-baseline-drift.md` | `compactionCompletedCount = 0` | current native/sidecar `= 1` | current compaction lifecycle extension；provider-visible request/output remains comparable, but count differs |
| `checkpoint_resume`、`write_snapshot_resume` | corresponding baseline drift reports and JSONL | main lacks current SDK request composition/evidence shape | current adds host-linked request/budget evidence; no semantic difference after evidence contract | legal SDK extension, not main feature equality |
| 19 `notApplicable` scenarios | `/tmp/pilotdeck-parity-sdk-core-final-20260920/summary.json` | main cannot exercise listed capability | current has budget/elicitation/progress/compaction/seed/system-prompt/working-dir/subagent lifecycle | main-missing capability; cannot be PASS or “identical” |

The exact comparator declarations are in `tools/agent-loop-parity/run.py` (`BASELINE_COMPARISONS`). They are not a product decision that the user accepted all differences; they only prevent an unreviewed drift from being hidden. Product choice required: either accept these declared extensions as a compatibility policy, or require literal main equality and change/rebase the behavior accordingly. This round does not silently choose for the user.

## 九类问题处理清单

1. Recovery compaction preparation reference：host model adapter `WeakMap` 持有 reference，materialize 不污染 frozen canonical request；有 llm/default-factory/production budget 回归。
2. Close 后 pending admission：Gateway reservation/fence 在 close/abort/exception finally settlement；有 pending creation/admission tests。
3. SDK control 与新 turn 竞态：control 和 turn 共用 session reservation；有 config/MCP/seed/flag barrier tests。
4. Permission 丢失：permission registry 是唯一 current/base owner；有重建、plan entry/exit、sidecar round-trip tests。
5. Admission 泄漏：异常、取消、close、dispose 统一 unwind；有 pending config/attachment/model-selection tests。
6. Sidecar error-only terminal：保留原始 code、retryability 和 terminal outcome；有 model/tool/permission module failure tests。
7. Budget comparator：删除无条件 path waiver；independent request-linked evidence、breakdown consistency 和同步伪造负向测试均通过。
8. Runtime-context 顺序：跨 block/message projection、未知残余、重复标签、非文本 block 均严格拒绝；有 comparator/default-factory negative tests。
9. Lifecycle 因果：late request、close/abort、durable commit、副作用和 terminal 保持必要 happens-before；有 operation ledger/replay/sidecar close tests。

## 测试与产物

| 命令 | 结果 |
| --- | --- |
| `NODE_OPTIONS= PATH=... pnpm build` | PASS |
| `NODE_OPTIONS= PATH=... pnpm --filter @pilotdeck/sdk test` | `127/127 PASS`（含 top-level/client startup defaults/initialize timeout/close lifecycle 回归） |
| `PATH=Node22 NODE_OPTIONS= node --test dist/tests/workflow/*.spec.js dist/tests/cron/{cron-control-port,cron-agent-gateway-port}.spec.js dist/tests/always-on/always-on-control-port.spec.js dist/tests/goal/goal-runtime.spec.js dist/tests/plan-todo/native-plan-todo-runtime.spec.js dist/tests/agent/modules/host-plan-todo-port.spec.js dist/tests/cli/project-goal-composition.spec.js` | `38/38 PASS`，含正式 stdio sidecar Goal composition、Cron/Always-On stop、Goal/Plan-Todo session owner、Workflow caller-owned dispose |
| focused module/loop/session/sub/gateway/replay Node test | `433/433 PASS` |
| `NODE_OPTIONS= PATH=... pnpm test` | `1721 PASS / 0 FAIL / 2 SKIPPED`，日志 `/tmp/pilotdeck-root-test-sdk-core-final-20260920.log` |
| `python3 tools/agent-loop-parity/test_trace.py` | `53/53 PASS` |
| `NODE_OPTIONS= PATH=... node tools/agent-loop-parity/test_budget_evidence.mjs` | `2/2 PASS` |
| production parity runner (`--comparison both --surface gateway --scenario all`) | `53 scenarios; failed=0; blocked=0; oracleFailures=0`，`/tmp/pilotdeck-parity-sdk-core-final-20260920/summary.json` |
| `NODE_OPTIONS= PATH=... pnpm --filter @pilotdeck/sdk typecheck` | PASS |
| `NODE_OPTIONS= PATH=... node docs/sdk/tools/check-public-docs.mjs` | `46 runtime symbols, 2 package exports` |
| `git diff --check` | PASS |

完整 parity 的 19 个 `notApplicable` 与原因见 summary，不计入 PASS；包含 plan-mode、budget、elicitation、SDK progress、durable/projected compaction、seed、system prompt、working directories 和 subagent lifecycle。Frontend integration、真实外部 provider、remote/queued deployment、StaffDeck Harness/TaskFrame/SOP、Desktop 原生视觉检查仍未覆盖。

## 交付状态

本报告与 acceptance checklist、模块索引、roadmap 已按当前代码和验证产物更新。本轮新增 startup 握手超时 teardown 与 client 生命周期回归，代码和文档 diff 均可审查。提交并 push 后需把最终 commit、报告路径、四项结论和 `待独立验收` 发送给独立验收线程。
