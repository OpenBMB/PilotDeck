# SDK/Core Integration 系统回归最终报告（2026-09-20）

## 结论

当前分支 `codex/integrate-sdk-0901` 在固定产品基线 `origin/main` 上完成了 Core、SDK、native/production-sidecar 和架构边界回归。没有发现需要新增的 P1/P2 根因；上一轮已提交的九类修复在当前 HEAD 上全部有 focused regression 和 production trace 证据。当前 worktree 在本轮验证前后保持干净。

Frontend integration 不在本轮授权范围内，不能解读为已验收。

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

静态边界检查确认 `AgentLoop` 没有重新引入 `Router`、`Gateway`、`SessionRuntime`、Plugin aggregate 或 `AgentRuntimeDependencies` 依赖；Router 只在 native adapter/application composition。`MODULE_PROTOCOL_VERSION` 仍为 `2.0`。sidecar raw trace 的 53 个场景均出现 `handshake_completed` 与 `module_call_received`，不是 test factory 或 fake runner。

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

SDK `123/123` tests cover the public surface; no API was removed to obtain parity. SDK-only additions remain explicitly typed extensions and are not treated as main parity requirements.

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
| `NODE_OPTIONS= PATH=... pnpm --filter @pilotdeck/sdk test` | `123/123 PASS` |
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

本报告与 acceptance checklist、模块索引、roadmap 已按当前代码和验证产物更新。代码逻辑在 `b15d2080` 已完成上一轮修复，本轮没有新增 runtime diff；文档 diff 可审查。提交并 push 后需把最终 commit、报告路径、四项结论和 `待独立验收` 发送给独立验收线程。
