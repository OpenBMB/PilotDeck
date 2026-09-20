# DSH 与 PilotDeck 当前架构核对及执行 Roadmap

状态：执行稿（2026-09-14 模型栈解耦更新）
核对日期：2026-09-14
适用分支：`Kaguya-19/refactor/core_agent_loop_0831`

核对源码基线：DSH `0a53fb55bea101816fa226bb964ae2bed71c343b`
（`0.1.2-alpha.2`）；PilotDeck `20b88268dc8fd8d600facf7fc68af907769cc36d` 加本 worktree
未提交改动。

本文件是当前执行入口。它压缩并取代以追加记录为主的
[04 DSH 风格模块化 Roadmap](04-dsh-modularization-roadmap.zh.md) 的排期功能；04 保留为
决策、对拍和已完成切片的审计历史。

### 2026-09-15 Sidecar 组合解耦

sidecar 已改用 `SidecarAgentTurnCapabilityComposition`：其 public composition 不接收 Router 或
`AgentRuntimeDependencies`。主模型只要求 `ModelExecutionPort`；没有显式
`AuxiliaryModelPort` 时，不再隐式回退到 Router `stream`。Router fallback 仅保留在 native
compatibility composition。

host 工具边界拆为独立的 `ToolAuthorizationPort` 与 raw `ToolExecutionPort`：授权 policy 可以替换，
capability execution 不再拥有 permission decision。默认 adapter 保持原来的批量、并发、参数 rewrite 和
拒绝结果语义。sidecar transport 将 model/capability/permission/context/lifecycle/event 作为显式 per-turn
handler composition；Module Protocol v2 的 module 名称、字段和 durable owner 均未改变。

Context consumer 进一步按 prepare/tool-result/recovery/capture/compaction 拆为独立 ports；sidecar
handler 只调用相应 port，context runtime aggregate 与 `budgetEvaluator` 都不跨 protocol 边界。

### 2026-09-15 Sidecar 完整 composition 收口

sidecar 现以独立 `SidecarAgentLoopPorts` 构建冻结 capabilities，不再将 sidecar input cast 为
`AgentRuntimeDependencies` 或调用 native `createAgentTurnCapabilities()`；default factory 也不再注入
假的 registry/scheduler。`AgentLoop.fromDependencies()` 仅保留为 native compatibility facade，循环本体
不再引用宽 native dependency type。

工具授权 adapter 只产生 allow/deny/input rewrite；host 广告 `execute_batch` 时，批准调用单次交给 raw execution
port，避免把一个 host batch 按并发属性拆成多个 batch；非 batch provider 保留原有调度。`SidecarTurnProtocol` 只处理 transport
事实，Plan/Todo handler、permission-mode result observer 和可替换 module handler registry 都在 host
composition 层组装。宽 `PilotDeckToolRuntimeContext` 已移至独立 tool-context builder；该 builder 消费
turn identity、checkpoint 与窄 ports，不暴露 router、session 或 persistence object。

### 2026-09-15 Sidecar 纯 view 收口

`AgentTurnCapabilities.ts` 现只定义冻结的 consumer view 与 sidecar builder；宽 native bag、Router decision、
scheduler 和 legacy `opaque` 处理移入 `nativeAgentTurnCapabilitiesAdapter.ts`。`AgentLoop` 不再 import Router
类型或解析 `PreparedModelInvocation.opaque`；Router 仍可通过 native compatibility adapter 提供 routing 和
turn-bound auxiliary-model port。sidecar tool context 改为显式最小 `SidecarToolContextPorts`，不再取得 aggregate。

`sidecarTurnComposition` 是 host per-turn 领域 composition owner：负责 PermissionMode lifecycle、Plan/Todo
handler、result observer 与 handler registry；transport 只消费该 contract。Plan/Todo refresh 改为独立
`ToolResultObserver`，不再包装 execution port。协议字段、批量工具边界、durable owner 和 terminal 语义保持不变。

### 2026-09-17 Sidecar parity safety closure

本轮继续收紧 sidecar 与 native 的既有语义，而不增加产品能力。turn 的 `permissionRules` 现在只替换
user-owned rule，project/session/policy/cli policy 保持 host-owned，wire 不能伪造非 user rule。host 的动态工具目录
通过可选 `capability.list_tools` 在新 model request 边界刷新；runner、AgentLoop 和 permission lookup 均消费同一个
live descriptor view，未广告时保持 admission snapshot。

sidecar runner 在连续 child execute 之间只保留易失 `modelState` 投影：route token calibration 与 persistent hard
context/output cap 会交给下一 child，但绝不写进 Session durable event、projection 或 checkpoint。`prepare()` 的公开
request materialization 同时保持原样，AgentLoop 只在其后合并自己拥有的 token cap。默认非 streaming `complete()`
恢复线性、无默认 jitter 的 request retry；stream retry policy 不变。

live steer 的 attachment path 只有在 canonical steer message durable 后才写入 `HostToolCheckpoint` 并 ack。host tool
完成后，即使后续 durable callback 失败，runner 也保留其 file checkpoint 作为下一 turn seed；callback failure 仍按
本 turn 的失败语义结算。启用 `includeToolProgress` 时，runner 在未完成的 host capability call 中轮询 host event
buffer，让 volatile `tool_progress` 早于最终 tool result 可见，且不创建第二份 durable truth。

本轮新增 production loopback factory 契约，覆盖动态 catalog、prepared request、durable steer authorization、跨 child
hard cap、live progress 和 callback-failure checkpoint；另有独立 permission override 与 non-stream retry regression。
这些证据证明正式 factory 路径而非测试注入 runner。当前正式 Gateway stdio 证据以本地 PilotDeck `run.py` 的 53
场景 matrix 为准：52 个场景 strict shared，`deadline` 保留 2 条精确声明的 transport settlement difference；exact
contract 后 `FAIL=0`、`BLOCKED=0`、oracle failure `=0`。Gateway gate 仍独立于 loopback 契约执行。

### 2026-09-17 Sidecar parity gap follow-up（已完成）

在上述历史基线之后，针对 merge/sidecar audit 发现的边界缺口继续收口：agent config 现在显式投影
`permissionModeBeforePlan`，因此 child 即使在启动时已处于 `plan`，退出时仍恢复 host 保存的 base mode；Gateway
仍只消费 host-confirmed capability result 与同一 mode-change event，不新增第二份 durable mode state。

sidecar compaction 的 host budget reconstruction 会对 candidate canonical request 重新执行 host context preview，但不再次
调用 `ModelExecutionPort.prepare()`，也不重跑 Router selection；wire 仍只传 canonical payload、预算标量和 stage，不传
Router 或 provider object。`budgetStage` 同时恢复为 host
context port 的显式输入。compaction persistence callback 拒绝不再被 AgentLoop 吞掉：直接 runner 不会继续模型调用；
Gateway 的既有 durable bracket/abort owner 保持不变。

post-routing compaction 还通过可选 model operation `materialize_prepared_request` 复用同一个 host preparation：sidecar
仅传 `preparationId` 与 candidate request，host 再以窄 routing port materialize，不重跑 prepare/route selection。direct
execution provider 未广告该 operation 时仅更新 messages，避免覆盖 provider-owned prompt、tools、cache 与 output cap。

large-file recovery 的 session output target 进入易失 `modelState` projection，与 calibration/hard cap 一样跨同一
sidecar runner child 往返但不进入 Session durable state。普通 prepared request 的较小 output cap 不会再被 config
cap 放大；明确的 retry/recovery override 与 provider hard cap 仍优先受限。

host event buffer 现在经 sidecar runner 的单一外部 timeline projector 输出，补齐 child tool progress 派生的
`subagent_status` 与 heartbeat，不将 host/child timeline 作为两套可见坐标链。deprecated batched `model.stream`
未带 request 时复用已保存的 preparation request；带 request 的旧调用和 `stream_next` 仍使用显式 request。durable
tool decorator 与 `list_tools` 也完整等待并转发可选 `refresh()`。

上述行为已由 direct/loopback contract 覆盖；最终 production Gateway matrix 已完整执行 53 个场景，其中 52 个
native/sidecar strict shared，`deadline` 按精确 transport settlement contract 验收。`plan_mode_bypass_host_policy` 已将非默认 `bypassPermissions` base 的四 turn 恢复纳入正式 Gateway case；其余
routed materialization budget、cross-child large-file cap、host event timeline/status、legacy stream/reconnect 与 refresh-only
catalog 的独立 oracle 仍是 focused contract。production proof 文件逐场记录 stdio transport、
正式 handshake/binding 与 host module calls；任一证据缺失都应为 `BLOCKED`。

### 2026-09-14 模型栈可插拔解耦

参考 DSH 的 `llm`、`llm-retry`、`token-meter` 与 bundle 分层，AgentLoop-facing model view
现按 execution、routing、metadata、budget、auxiliary 五类 consumer port 组织。显式
直接构造 capabilities 时，`ModelExecutionPort` 可以在没有 Router 的情况下装配；`AgentRuntimeDependencies`、session
scope 和 Local Gateway native composition 仍将 Router 作为 legacy 必填/默认资源。Router 仍作为 legacy
routing/compatibility facade 保留一个兼容周期。第三方 provider adapter 只通过稳定的 model port contract 接入，负责
provider/model 选择和 canonical stream 转换，provider registry、session、
lifecycle 与 dispose 仍归 application composition。

旧 `model.invoker`、`model.routing`、`model.tokenAccounting` 及 metadata lookup 字段暂保留为
deprecated adapter；新生产代码使用 `model.execution`、`model.routing?`、`model.metadata`、
`model.budget?` 与 `model.auxiliary?`。实际 routing 视图名称为 `AgentTurnRoutingPort`；缺失 metadata 使用明确 conservative fallback，不回读
Router 私有状态；`PreparedModelInvocation.opaque` 仅用于兼容旧 Router adapter。二次模型调用
优先消费 `AuxiliaryModelPort`，未注入时才由兼容 routing facade 提供 turn-scoped fallback。

### 2026-09-13 路线决策

本路线固定在当前单一 Local Gateway 产品组合基线上：不做第二个完整 deployment（headless、remote 或 SDK），
不把第二模型或第二 routing provider 作为产品目标，也不为这些目标建立 provider 产品矩阵。R4 的窄 port seam 与可选
integration 仍按本路线维护。P1（`PARITY-H` 与
R5-Z parity coverage）完成后，下一主线是设计新的通用 Workflow 模块（`WF-D`）；当前已经完成不接入既有领域 owner
的核心 runtime vertical slice，后续只冻结 Definition、caller/adapter contract、run owner、状态真源、状态机、
故障 settlement 和 ownership matrix，不立即接入领域 caller。
已有 Plan/Todo、Cron、Always-On、Goal 的 durable/live owner 不迁移、不合并。

本轮复核使用 Node 22 完成 `pnpm build` 与 `git diff --check`；provider-selected session
storage 的 catalog/history/fork/replace focused suites 为 **49/49 通过**，standalone read-side
composition 及其 Always-On/automation 邻接回归为 **23/23 通过**，provider-selected session search
focused suites 为 **8/8 通过**。本轮 context storage focused suites 为 **9/9 通过**，其中
`createLocalGateway` -> real session -> `SessionContextRuntimeBundle` 的实际模型请求证明了
application-selected instruction provider 的消费；upload lifecycle 的 TypeScript/HTTP focused suites
为 **17/17 通过**，Gateway attachment provider composition focused suite 为 **8/8 通过**，tool-result artifact
provider focused suite 为 **6/6 通过**。这些结果只确认当前 worktree 的模块边界与回归，不代表已完成远程
provider、attachment query/retention policy 或第二 persistence backend 的需求触发工作。

sidecar dynamic policy 的 R5-Z（Z1 + Z2）已重新验证：Node 22 `pnpm build`、
`host-permission-mode-state` **1/1**、`sidecar-client` **23/23** 与
`tcp-sidecar-transport` **8/8** 通过；此前冻结的 38-scenario native/sidecar matrix 为 **38/38**。
Z2 已使 runner 在连接前接管 submit-time `runMode`，并以 host config 覆盖 context callback 中的
`permissionMode` / `runMode`；真实 host `ToolRuntime` 的 `ask` write-gate 与 forged-context、跨 turn
live-mode 回归均已覆盖。2026-09-12 对当前带未提交 adapters/scenarios 的 StaffDeck harness 执行 60-scenario
`--pair all` 时，PilotDeck `multiple_tool` 曾只因两个 `concurrencySafe` callback 的 completion trace 顺序不同而被
误判；现已改为唯一 `toolCallId`、显式并发安全、zero-side-effect 三条件同时成立才归并。`auto_compact` 已实测为
native/sidecar 同样的 `failed/prompt_too_long`，oracle 已固定。P1 已回归当前 worktree 的完整 matrix；
enter-plan -> host callback -> next turn -> exit-plan 已由 native/sidecar focused contract 与 TCP replay 覆盖，均不需要
新增 runtime 模块或协议。

本轮还完成 Always-On 项目级持久记录 provider 的结构化边界复核：`AlwaysOnRuntime` 与独立 apply
handler 的 focused suites 为 **19/19 通过**，`pnpm exec tsc --noEmit --pretty false` 与 `git diff --check`
通过。该 provider 只选择项目记录与路径布局，不代表远程 scheduler、分布式锁或 workflow runtime 已模块化。

Cron 项目记录 provider 也已完成结构化接入：Cron manager/runtime/scheduler/fire 的 focused 回归为 **25/25
通过**，包含纯对象 task-store provider 驱动的 manager 启动、项目发现、task 创建/读取和 teardown。

Memory provider composition 也已完成：`ProjectMemoryProvider` 的 application selection、真实 Gateway
session retrieval/capture 和 generation disposer 回归纳入本轮 **49/49 combined focused suites**；EdgeClaw
仍是 native default，maintenance 仍由 application-owned controller 调度。

Router session provider composition 也已完成：application-owned volatile state 与 per-generation
custom-router registry 均可由 Local Gateway 选择，reload 保持 state identity，registry teardown 精确一次；
本轮相关 focused suites 合计 **49/49 通过**。同时补齐 `router.transientRetry` 配置解析，确保
retry policy 的 YAML 开关真正进入 runtime composition。

Compaction provider composition 也已完成：`createLocalGateway({ compactionProviderFactory })` 选择
project-generation `CompactionPort`，真实 Gateway session turn 已调用该 provider；generation bundle
对 factory 创建的 provider 精确执行可选 `dispose`，native `CompactionOrchestrator` 仍是默认实现，
provider 不拥有 Session durable state、AgentLoop 或 Gateway live state。

Prompt-cache coordinator composition 也已完成：`createLocalGateway({ promptCacheCoordinatorFactory })`
按 project generation 选择 session-scoped volatile cache provider，真实 turn 已消费其 `createPlan`；
session dispose 只释放当前 session 的 cache generation，不把 cache state 写入 Session durable log。

本轮还修正两处 application composition 漏洞：`createLocalGateway()` 现在透传
`UploadLifecyclePort`，并以真实 `submitTurn` 验证 provider lease 进入模型请求；Always-On 禁用时的
standalone apply fallback 现在与 enabled manager 共用同一个 `alwaysOnStorageProvider`。相关 CLI composition
回归为 **18/18 通过**。

## 结论

PilotDeck 已具备 DSH 最重要的三个架构性质：

1. `SessionRuntime` 是 session durable truth 的唯一串行 append owner；persistence 和
   projection 都从 committed event 派生。
2. `AgentRuntimeScope`、`ScopedServiceRegistry`、`AgentFactoryProvider` 已将 service
   visibility、generation lease、publication rollback 和 drain/dispose 接入 native agent
   生命周期。
3. `AgentLoop` 已只消费 `AgentTurnCapabilities`，正式外部 loop factory 只接收
   `config + capabilities + seedState`，不会把 `Session`、`Gateway`、`Router`、child inbox
   或 persistence 暴露给 sidecar。

因此，当前的主问题不是继续按 DSH package 名称拆目录。Module Protocol sidecar 已有可直接
组合的 stdio process provider；`result_unknown` 已绑定 session-owned、可从 JSONL 重放的 fail-closed
operation ledger，sidecar 也提供同连接的 live `status` snapshot。transport 已有可直接组合的 local TCP
provider：同一 sidecar process 跨连接保存 bounded replay state，client 在显式 reconnect 后恢复 stream；现有 stdio
provider 仍明确不声明可恢复。Local Gateway 已可按 deployment profile 选择该 provider；同一存活 TCP instance
的 permission/question pending host-module reply 也可在断线后恢复。R5-Z 的 permission transition、context policy
canonicalization 与 submit-time run-mode owner（Z1 + Z2）均已由 host owner 闭合。P1 的 deterministic harness、
并发安全 callback identity 对拍、`auto_compact` oracle 以及 plan-mode transition 的跨 native/sidecar scenario 已完成；
后续缺口仅是产品侧非幂等副作用的 status-query provider，以及远程 subagent 部署语义。sidecar process
restart 已会进入 host-owned reconciliation：新的实例不会
伪装成可 resume 的旧实例。
任何下一步都不能复制 durable state
或把 host owner 移进 transport。

Plan/Todo 已在 native 路径保持为 session projection，并在 sidecar 路径通过可选的
`capability.plan_todo` host callback 闭合：host 仍是唯一 durable owner，sidecar 只缓存经校验的本 turn
投影以构建 prompt 和执行 gate。它不是 generic workflow 的起点。

Goal 的 durable native/local 和 sidecar host-execution 闭环已完成：sidecar 通过既有
`capability.execute` 在 active host session context 中执行 `create_goal` 等工具。它不保留 Goal projection、cache
或 mutation API；`goal_changed` 仍只由 host Session durable writer 追加。

Lifecycle/Hook 也已通过可选 `lifecycle.dispatch` host callback 闭合：插件 registry、匹配、环境、async
completion 与 teardown 继续是 host deployment state；sidecar 只消费当前 hook event 的 serializable result。

AgentLoop 的 volatile 事件也已通过可选 `event.emit` host callback 闭合：sidecar 将已产生的
`AgentEvent` 串行回传至 host emitter，并在发送最终 execute event 前等待已经受理的 event delivery。
它不写 Session、不能参与 `result_unknown` 恢复；host event consumer 失败也不改写 AgentLoop 的业务终态。

项目级 background task durable state 已完成 native M3：`task_*` 通过 Project execution-world provider
使用 project-scoped JSON snapshot 与 output spill；task metadata 可恢复，live child handle 和 completion bus
仍严格保持 live-only。进程损失后的未终态 task 显式变为 `unknown`，而不是尝试跨重启接管旧 PID 或伪造完成。

## 核对基线

DSH `0.1.2-alpha.2` 的参考价值是 ownership discipline，不是 Cordis 本身：

| DSH 性质 | 发布实现锚点 | PilotDeck 对应实现 | 核对结论 |
| --- | --- | --- | --- |
| 同一 scope identity 决定可见性、事件路由和注册释放 | `packages/core/scope/src/{index,store}.ts`：`createScope`、`scopeTarget`、`ScopedLayers.effect` | `src/agent/scope/{AgentRuntimeScope,ScopedServiceRegistry}.ts` | native service scope 已具备继承、lease、stop-new、child-first dispose；prompt/tool/hook 仍由各自 exact owner 管理，不伪造为一个通用 registry。 |
| session log 是模型事实和恢复的真源，projection/persistence 可独立装配 | `packages/core/session/`、`packages/session/session-projection/`、`session-persistence-*` | `src/session/{events,persistence,projection,storage}/` | `SessionRuntime` 的 required persistence subscriber、projection driver、checkpoint 和 replay 已闭环；Gateway live state 不是 durable truth。 |
| Agent create/resume 先 setup，再 publish；失败完整回滚 | `packages/core/agent/`、`packages/core/agent-loop/` | `src/agent/scope/{AgentFactoryProvider,AgentHandle,AgentRegistry}.ts` | native M3：unpublished setup、replace、drain 和 rollback 都有明确 owner。 |
| loop 只消费运行 capability；provider 在 composition 选择 | `packages/core/agent-loop/` 与 base bundle | `src/agent/loop/{AgentTurnCapabilities,AgentLoopRuntimeFactory}.ts`、`src/agent/session/AgentSessionRuntimeBundle.ts` | `AgentRuntimeDependencies` 已留在 native composition；`AgentLoop` 构造器不再是宽 dependency bag contract。 |
| subagent 是 definition、provider、tool consumer 与 child owner 分离的 seam | `packages/subagent/` | `src/agent/sub/` | continuable native 路径已具备 provider registry、durable FIFO inbox、manager、cold resume；one-shot 已有 native port，远程部署尚未验证。 |
| profile/bundle 负责有序 provider selection 与 boot rollback | `packages/boot/app-boot/`、`packages/bundle/base/` | `src/cli/{ProjectRuntimeRegistry,LocalGatewayBootstrapBundle,*Bundle}.ts` | local deployment 已有 stage/publish/retire、lease 和 reverse teardown；没有第二 deployment 时不应提前复制 DSH profile/patch matrix。 |

## 成熟度与未闭环项

成熟度不是目录数量：M1 是 Definition 或本地 adapter；M2 是 Definition、Provider、Consumer、Composition
在 native 路径闭环；M3 还要求 durable truth 或 publication lifecycle、rollback、drain/replay 等关键故障
语义闭环。

| 能力族 | 成熟度 | 已形成模块边界 | 尚未闭环的事实 |
| --- | --- | --- | --- |
| Session persistence / projection | M3 native | `SessionRuntime` -> persistence -> `SessionProjectionDriver` -> checkpoint/replay | 第二 persistence backend、外部 query/retention policy 仅在出现产品 consumer 后立项。 |
| Session read-side（catalog / history / search） | M2 native | `SessionCatalogPort`、`SessionTranscriptReaderPort`、`SessionSearchPort`；`ProjectSessionReadSideBundle` 组合 catalog/history，`createProjectSessionSearchPort()` 选择 search；Gateway、Web、Always-On、CLI/channel consumer 和 `ProjectAutomationBundle` composition | catalog/search 仅在 selected provider 明确声明时可跨 backend 枚举或查询，未声明即 fail-closed；没有统一跨 backend query/retention contract。Web fork/replace 分别归 provider-owned write capability（R5-E/R5-F）；sidechain 的原子改写、资产复制和路径约束仍不是 read-side capability。 |
| Scope / agent publication | M3 native | scoped services、factory transaction、`AgentHandle`、live event owner | 不需要且不应强行把所有 contribution 合进一个 global registry。 |
| Core AgentLoop | M2 native/direct | capability view、`ModelExecutionPort`、`AgentTurnRoutingPort`、`ModelMetadataPort`、`ModelBudgetPort`、`AuxiliaryModelPort`、native/direct provider、session/child composition | Router facade、retry、fallback、health、cache、judge 与 orchestration 仍由 native composition 拥有；旧聚合字段仅保留兼容周期。 |
| Router session policy / custom router | M2 native | `RouterSessionStatePort`、`RouterSessionCustomRouterPort`、`ProjectRouterRuntimeBundle`；`createLocalGateway({ routerSessionState, routerSessionCustomRouterFactory })` 可分别选择跨 generation volatile state 与 per-generation registry | state 只拥有 routing policy cache，custom-router registry 只拥有 session registration index；两者不写 Session durable truth，custom-router contribution disposal 仍归 plugin/session lease | 未定义跨项目 routing cache、remote router deployment 或 generic policy registry；外部 state provider 由 application 保持，不由 registry 清理 |
| Model / tool / context / permission | M2 native + host callback | durable wrapper、host port、sidecar module_call dispatch、session operation ledger；`createLocalGateway({ modelInvocationProviderFactory })` 可选择 model invocation provider | 同一存活 TCP sidecar process 的 reconnect/replay、binding replacement、pending permission/question host reply、`resume`/`ack`、实例重启 -> host reconciliation 与 late host capability result 的单一 terminal 已验证。R5-Z 已使 host-confirmed capability result 驱动 permission transition，并使 submit-time `runMode` 与 context callback 一律读取 host config；forged wire mode 无法绕过 host `ask` gate。P1 comparator、oracle 与完整 plan-mode deterministic parity 已验收；默认 deployment 没有非幂等 side effect status-query provider，stdio 可恢复性与 remote deployment parity 未完成。 |
| Context storage / compaction / prompt cache | M2 native | `InstructionStoragePort`、`ToolResultSpillPort`、`CompactionPort`、`PromptCacheCoordinatorPort`、`ProjectContextStorageBundle`；`createLocalGateway({ contextStorage, compactionProviderFactory, promptCacheCoordinatorFactory })` 在 project generation 冻结 provider，经 `ProjectSessionRuntimeBundle` 传至 `SessionContextRuntimeBundle` | provider 只拥有 I/O、compaction stage 或 session-scoped cache generation；`InstructionDiscovery` 继续拥有层级与 prompt 顺序，`ToolResultBudget` 与 `CompactionOrchestrator` 继续拥有 policy，session/turn state 不移入 provider；没有远程 context storage 产品需求。 |
| Memory retrieval / capture | M2 native | `MemoryResolver`、`ProjectMemoryProvider`、`EdgeClawMemoryProvider`、`ProjectMemoryBundle`、`DefaultContextRuntime` 与 `ProjectMemoryMaintenanceController`；`createLocalGateway({ memoryProviderFactory })` 可选择 project-generation provider，retrieval/capture 通过 ContextRuntime consumer | EdgeClaw SQLite service 的 durable DB、索引和维护调度仍由 provider 内部拥有；目前没有产品化的第二 memory backend、跨项目 memory query 或 retention contract；memory failure 继续隔离于 turn terminal。 |
| Plan / Todo | M3 native + M2 host callback | session projection、native `PlanTodoPort`、可选 `capability.plan_todo`、sidecar validated cache | sidecar cache 只服务当前 turn 的 prompt/gate；没有统一 workflow caller/run owner，不能扩张为 generic workflow registry。 |
| Goal | M2 native + M2 sidecar host callback | `goal_changed` durable event、`goal.state` projection/checkpoint、session-bound `GoalPort`、`get_goal` / `create_goal` / `update_goal` tools，以及 Local Gateway native/stdio sidecar model consumer | host capability dispatch 以 active session identity 重建 `GoalSessionPort`；stdio E2E 证明 sidecar 调用只在 host Session log 中写入一次 `goal_changed`。自动 continuation、remote goal provider、跨 session query 和统一 workflow run owner 仍不在范围内。 |
| Lifecycle / Hook | M2 native + M2 host callback | `LifecycleRuntime`、可选 `lifecycle.dispatch`、host environment reconstruction | hook/plugin registry、async completion 和 resource lease 仍是 host deployment state；remote async-hook delivery 仅在真实 consumer 出现后单独立项。 |
| Volatile Agent event | M2 native + M2 host callback | `AgentEventEmitter`、可选 `event.emit`、sidecar final 前 flush | event 只做当前 execute 的有序 live projection，不写 Session、不承诺 replay/reconnect；host event consumer failure 不得改写业务 terminal。 |
| Continuable subagent | M3 native | provider registry、descriptor、child inbox、manager、cold resume、Gateway consumer | remote/queued provider 的 replacement、restart 与 late terminal parity 未证明。 |
| One-shot subagent | M2 native + M2 host callback | `OneShotSubagentPort`、native provider、tool consumer、parent-derived child storage、Web history consumer；sidecar `capability.execute` host context 重建 | R3.1 已将 parent `operationDeadline` 收紧为 native scheduler 看到的 child budget，且 timeout/parent-abort 语义仍可区分。R5-C 已使 native sidechain write/read 遵循 selected `ProjectSessionStorageProvider`，并保持 JSONL sidechain path。loopback、Local Gateway + TCP 以及 bundled stdio 的 parent-abort、deadline/late terminal 已验证；remote provider parity 仍待真实 consumer。 |
| Interaction | M2 native | profile-selected provider、permission/question audit、reconnect projection | profile/bundle registry 仍是 local composition，尚无第二 deployment 驱动的抽象需求。 |
| MCP extension lifecycle | M2 native | project generation、session exact registration、resource lease；`createLocalGateway({ builtinPlugins, mcpRuntimeFactory })` 可选择 frozen plugin contribution 和 runtime provider | 其他独立 extension consumer 出现前不建 generic lifecycle registry。 |
| Channel adapter lifecycle | M2 local | `ChannelAdapterBundle`、`ChannelLifecyclePort`、`ChannelStatePersistence`、`PilotDeckServer`；server 独占 started handle，adapter mapper state 由 channel store 持久化 | 各渠道网络协议和业务映射仍由具体 adapter 所有；当前 lifecycle composition 只覆盖 local server，没有 remote adapter deployment 或跨渠道统一 durable message contract。 |
| Local boot / Gateway live coordination | M2 local | bootstrap rollback、runtime generation、replay/replacement/telemetry owners | local 之外没有已验证 deployment profile。 |
| Gateway tool-result preview artifacts | M2 local | `GatewayToolResultArtifactStorePort`、native store、`GatewayAgentEventProjector`、`InProcessGateway` 与 Local Gateway application selection | preview artifact 是 advisory live projection，不是 Session transcript、operation terminal 或 replay truth；没有 retention/query 或 remote artifact provider contract。 |
| Module Protocol sidecar | M2 protocol / M2 local deployment | capability-only client、server、stdio 与 TCP provider、identity/order validation、v2 handshake、host module callback、terminal seed projection、live `status`、session-backed fail-closed unknown reconciliation；transport-local bounded replay、binding replacement、pending module-call replay/cache、`resume`/`ack`、instance-restart reconciliation 与单次 reconnect；Local Gateway deployment profile | stdio provider 保持不可恢复；TCP 已有 session-level reconnect/replay、permission/question host reply recovery、active deadline、late host result 单 terminal、instance-restart host reconciliation 以及 Local Gateway model/tool side-effect fault E2E。R5-X 已补齐 host capability execution 的 mutable file checkpoint、attachment authorization 和 known-terminal seed parity；R5-Z（Z1 + Z2）已使 host 成为 dynamic permission/run-mode 的唯一 live owner。P1 的 comparator、oracle 与 plan-mode deterministic parity 已验收；产品侧非幂等 status-query provider 与 remote/queued deployment parity 仍待真实需求。 |
| Interactive terminal | M2 local UI | `TerminalPtyPort` Definition、Node `node-pty` provider、shell WebSocket consumer、`TerminalSessionRegistry` live owner | PTY 重连、buffer、timeout 与 exact teardown 已在 UI 进程闭环；服务重启后没有 durable terminal/session recovery，也没有 remote deployment contract。 |
| Background task / job | M3 native | `BackgroundTaskPort`、`BackgroundTaskRuntime`、`BackgroundTaskSnapshotStore`、detached-shell provider、completion event bus、output restore 和 project execution-world composition | 本地重启将未终态 task fail-closed 为 `unknown`，终态 task 可按 session fence 读取 output 且不重发 completion；远程 worker/queue、process adoption 与 retention policy 仍未定义。 |
| Gateway attachment I/O / projection | M2 local | `AttachmentPort`、Node provider、`AttachmentResolver`、`GatewayAttachmentTurnComposer`、`GatewayDialogBundle` 和 `createLocalGateway` provider selection | I/O provider 只读 declared path；resolver 保持 MIME/size/model projection，composer 保持 turn mapping；没有 remote attachment provider 或跨项目 query contract。 |
| Browser upload artifact lifecycle | M2 local | `UploadLifecyclePort`、native `UploadStore` provider、`GatewayUploadedAttachmentBundle` lease consumer、`createUploadRoutes(lifecycle)` HTTP consumer | provider 拥有 admission、metadata、artifact integrity、retention 和 cleanup；Gateway 只持有 turn-local lease。UI server 与 Gateway 是两个进程，各自默认组合 native provider；自定义 provider 必须在两个应用入口分别装配，当前没有 remote upload provider、跨项目 query 或通用 attachment registry。 |
| Always-On project durable records | M2 native | `AlwaysOnProjectStorageProvider`、native filesystem provider、runtime / scheduler / `DiscoveryFire` / standalone apply consumer，以及 `ProjectAutomationBundle` composition | provider 只选择 paths 与 state/plan/cycle/report/event 的结构化 record ports；run context、Gateway control、workspace 和 scheduler lifecycle 仍由现有 runtime owner 持有。没有 remote scheduler、distributed lock、generic workflow 或 Session owner 转移。 |
| Cron project durable records | M2 native | `CronProjectStorageProvider`、native filesystem provider、`CronManager` project discovery/migration、`CronRuntime` / `CronScheduler` / `CronFire` task-store consumers，以及 `ProjectAutomationBundle` composition | provider 只选择 task/run records、legacy migration、project discovery 和 marker；schedule timer、active run、Gateway control、Session override 和 result delivery 仍由 Cron runtime/manager 所有。没有 remote queue、distributed scheduler、generic workflow 或 Session owner 转移。 |
| Workflow | M2 native/local core | 当前只有 plan/todo、cron、Always-On 等各自的产品运行时；`src/workflow/` 已提供 caller-owned DAG、durable JSONL/InMemory event store、event replay、pause/resume/cancel/deadline/dispose/unknown settlement 与 control composition | 核心运行时已可由明确 caller 组合；仍无获批领域 caller，因此不迁移现有 owner、不新增 generic registry，也不将该核心误称为领域 workflow 产品。 |
| Cross-platform sandbox | M2 shell/detached-shell | `ShellPort`、`DetachedShellPort` 与 sandboxed Node providers；`createLocalGateway({ executionWorldBundleFactory })` 可选择 project execution-world provider | 不把 shell provider 的局部能力扩张为通用跨平台 execution runtime。 |
| Attachment query / cross-provider retention / second persistence backend | M0-M1，按项不同 | browser upload 的 provider-owned retention、file artifact、upload lease 和 JSONL session persistence | upload lifecycle 的本地 retention 不等于跨 provider query/retention contract；后两项仍须由明确产品 caller 单独立项。 |

### 本次 DSH 源码复核新增结论（2026-09-12）

本次对照 DSH `session-title`、`lsp`、`workflow`、`goal`、`terminal`、`jobs` 与
`boot/app-boot` 的发布源码后，补充以下判断。这里把“没有对应实现”和“已有实现但没有完整
Definition/Provider/Consumer/Composition”分开，避免把 DSH 包名直接当成 PilotDeck 的待办目录。

| DSH 能力 | PilotDeck 当前事实 | 判断 | 下一步门槛 |
| --- | --- | --- | --- |
| `session-title` | `SessionTitlePort`、native model provider、`createLocalGateway -> ProjectRuntimeResourcesBundle -> ProjectSessionRuntimeBundle -> TurnRunner` composition；`SessionMetadataStore` 写入 `aiTitle`，metadata projection 可恢复标题 | **M2 native+**。provider selection、真实 turn consumer、generation dispose、provider/model provenance、user-pinned source 和 accepted-input sequence 投影已闭合；仍未把 DSH 的独立 `user/message` seq 全量投影到标题事件；失败仍 fail-soft，不影响 turn terminal | `R5-S` 已完成兼容扩展；若要跨端精确 message-seq 对拍，再补独立 transcript event contract；不引入第二模型或第二 title provider |
| `lsp` | `src/lsp/{protocol,runtime,provider}/` 已形成 service definition/registry、Node stdio provider；`createLspTool` 是真实 model consumer，`CreateLocalGatewayOptions.lspServiceFactory` 完成 project-generation composition | **M2 native/local**。插件 manifest 仍只保留 `lspServers` 原始配置，不把静态配置误当成 provider runtime | 已完成本地 server lifecycle、workspace containment、AbortSignal 取消、结果规范化、`LSP_TIMEOUT` 映射、`workspace/configuration` / workspace-folder request reply、拒绝 server workspace edit 和 protocol shutdown；remote provider、持久 server pool、插件 manifest 自动装配和 editor consumer 仍需独立需求，不默认扩张 sidecar/Session owner |
| `workflow` | Plan/Todo、Cron、Always-On 各自仍拥有领域运行时；通用 core 已有 caller-owned composition，但没有获批领域 caller | **M2 native/local core** | `WF-D` 已实现通用 caller、run/event 真源、状态机、暂停/取消/deadline/dispose、late completion、恢复和 adapter contract；不建 generic registry，不迁移 Plan/Todo、Cron、Always-On 或 Goal 的 durable owner |
| `goal` | session-scoped durable goal 已通过 event/projection/port/tool/composition 闭环 | **M2 native/local** | 只有需要自动 continuation、跨 session goal query、remote provider 或 provenance 时，才扩展 goal lifecycle；不得把它直接升级成 generic workflow |
| `terminal` | UI 侧 `TerminalPtyPort`、Node `node-pty` provider 和 live registry 已闭环 | **M2 local**，但不是 DSH durable terminal parity | 只有出现 PTY 重连、服务重启恢复或 remote terminal consumer，才启动独立 remote terminal work package；不得把 UI registry 直接升级为 Session owner |
| `jobs` / detached task | `BackgroundTaskPort`、snapshot/output store、unknown recovery 和 access fence 已在 native 路径闭环 | **M3 native / M0 remote**。本地 durable metadata 不等于 worker adoption 或队列语义 | 出现 remote worker/queue 后，单独定义 lease、adoption、retention 和 unknown settlement；不得把 process PID 伪装成可恢复 owner |
| DSH `profile` / `bundle` | PilotDeck 已有 runtime profile、project-generation bundle、boot rollback；完整 application 仍以 `createLocalGateway` 为组合根 | **M2 local**，明确不扩展第二完整 deployment | 不做第二个完整 deployment（headless、remote 或 SDK）；保留当前 Local Gateway 组合根和既有 profile，不启动 `R5-U`，不复制 Cordis patch 层 |

这张表也修正“未模块化”的口径：LSP 已完成 native/local seam，但仍没有 remote provider、持久 server pool
或插件 manifest 自动装配；`session-title` 已补 provider/model provenance、user pin、source turn 与 accepted-input sequence 的兼容投影，但尚未引入独立逐消息事件；`workflow` 已完成可持久化的通用 core，但没有领域 caller adapter；`goal` 已完成 native/local 基础闭环；terminal、jobs、profile
则已有 native/local 模块，但缺少远程或 durable 扩展。几类问题的交付方式不同，不能合并为一次目录重排。

### 2026-09-11 Session/Storage 复核

DSH 的 projection registry 将可版本化的纯 fold 与 session log 分开，checkpoint 只作为 replay shortcut。
PilotDeck 的等价路径已实际接入，而非仅有 Definition：`ProjectSessionStorage.restore()` 先恢复
`SessionRuntime` 的唯一 durable log，再仅在 checkpoint 的 format/version/session/anchor 与 log 一致时注入
`SessionProjectionDriver`；否则完整 replay。`SessionProjectionCheckpointBinding` 在 turn terminal、flush 和
dispose 时保存 cache，失败只报告诊断，不影响已提交 session event。`AgentSession` 已用该 projection 读取
durable conversation、usage、permission denials 和 metadata，保留 live admission/inbox state 的本地 owner。

结论：Session/Storage 保持 M3 native，不应新建 checkpoint wire module、第二 SessionRuntime 或为了目录对称
引入 generic storage registry。后续仅在真实的第二 persistence provider、retention/query consumer 出现后，按 R5
以独立 owner 和恢复语义立项。

### 2026-09-11 Session read-side 复核

此前 Always-On 的 chat digest 与 `always_on_read_chat_history` 各自推导 chat JSONL 路径并读取 transcript，
使它们绕过了 application-selected `ProjectSessionStorageProvider`。这不是 DSH 风格的 provider selection：同一
session 的 write-side 已可选 backend，真实 read-side consumer 却固定在 JSONL。

现已以 `SessionTranscriptReaderPort` 收口。`ProjectSessionTranscriptReader` 的完整读取调用
`readAgentProjectSessionPersistence()`，因此从选定 provider 获得 durable entries；默认 JSONL provider 仍可在
其内部用 `readSessionLite()` 做有界 digest 优化。`ChatDigestBuilder` 和 `AlwaysOnChatHistoryTool` 只消费该 port；
`AlwaysOnRuntime`、`AlwaysOnManager`、`DiscoveryFire`、standalone control、`ProjectAutomationBundle` 与 CLI
完成同一 reader 的 composition。In-memory persistence contract 与 consumer injection test 证明该路径不依赖
JSONL 文件。

这使 session history read-side 达到 M2 native，而非把 JSONL 细节移到新的 facade。它不改变以下边界：

1. `SessionRuntime` 仍是 durable event、persistence 与 projection 的唯一 truth owner；reader 不能 append 或恢复 live session。
2. `SessionCatalogPort` / `SessionSearchPort` 分别是枚举和 Node JSONL search capability，尚未构成统一的跨 backend query/retention API。
3. Web `forkSession` 与 `replaceLastTurn` 都是已有 Gateway/Web caller，因此分别以 R5-E/R5-F 的 provider-owned write capability 闭环。replace 的 provider 必须拥有 prepared backup、commit/rollback 与启动 recovery；Gateway 只拥有 live reservation。background sidechain 的原子改写、asset copy 或相对路径验证仍不能误接为 read-only transcript port。one-shot subagent sidechain 是例外：parent 已记录 `subagentSessionId`，native child storage factory 和 Web history 都已有真实 consumer，故以 R5-C 复用 provider selection，而不是等待一个泛化 write/fork API。

### 2026-09-11 Session catalog provider-selection 复核

`SessionCatalogPort` 以前虽然是读侧 Definition，但它的默认 composition 仍可能独立创建
`createNodeSessionCatalog()`。因此 session write/history 已选择非 JSONL provider 时，Gateway 或 Always-On 的
enumeration 仍可能扫描 JSONL，造成不同 read-side consumer 看到不同 session 集合。

现由 `createProjectSessionCatalog({ storageProvider })` 收口：native JSONL provider 明确贡献
`listProjectSessions`；非 native provider 必须显式贡献 `catalog`。`createGateway`、`createLocalGateway`、
`ProjectRuntimeRegistry` 和 `ProjectAutomationBundle` 都从同一个 application-selected provider 选择 catalog；
显式注入 `SessionCatalogPort` 仍保持最高优先级。`GatewaySessionCatalog` 只将 `projectRoot` 与 `pilotHome`
传给 Definition，不再把 backend provider 泄漏给 consumer。

**failure mapping**：selected non-native provider 未声明 `catalog` 时，项目/session 枚举抛出
`ProjectSessionCatalogUnavailableError`，绝不回退扫描 JSONL。精确 session history 仍可由 selected persistence
provider 读取并从 durable entries 推导 metadata；这不等于 enumeration 可用。

这只完成已有 catalog consumer 的 provider selection，不将 `SessionCatalogPort` 扩展为 search、retention、
fork/replace 或跨 backend query API。

### 2026-09-12 独立 read-side composition 复核

`ProjectAutomationBundle` 已统一选择 provider-owned catalog/history，但 Always-On 的 native factory、manager
和 standalone control 仍可各自默认创建 Node JSONL reader。这样的默认分支会让 application 明明选择了
non-native persistence，却在独立入口退回另一份 durable backend。

现以 `createProjectSessionReadSideBundle()` 作为这两个既有 read-side Definition 的狭窄 composition：显式
`sessionCatalog` / `sessionTranscriptReader` 保持最高优先级；否则两者从同一个
`ProjectSessionStorageProvider` 派生。它没有 search、retention、fork/replace、persistence instance、
`SessionRuntime` 或 projection owner。`AlwaysOnRuntime`、`AlwaysOnManager`、`createApplyHandler` 与
`ProjectAutomationBundle` 都复用该选择，因此直接 factory 与 full application boot 不再分叉。

`project-session-read-side-bundle` contract 覆盖 selected provider、explicit override，以及 non-native provider
没有 catalog 时 enumeration fail-closed、但 exact history 仍经 selected persistence 的三种情形。该 bundle 是
composition 收口，不是新的 session facade 或跨 backend query API。

同一复核还发现 CLI/channel 的 `SessionSearchPort` 虽已有多个 consumer，但 server 默认总是创建 Node JSONL
实现。现新增 `ProjectSessionStorageProvider.search?` 与 `createProjectSessionSearchPort()`：显式 selected
provider 提供 search 时由它负责查询；未提供时抛 `ProjectSessionSearchUnavailableError`，禁止读取另一份 JSONL。
`startPilotDeckServer` 在没有显式 search port 时使用该选择点，因此 channel startup 与 server composition 不再
绕过 selected backend。search 仍是只读能力，不拥有 SessionRuntime、写入或 retention。

### 2026-09-11 One-shot Sidechain Storage 复核

这里存在一个狭窄但真实的 provider-selection 断点。`ProjectSessionStorage` 已经通过
`createSubagentProjectSessionStorage()` / `readSubagentProjectSessionPersistence()` 将 continuable child
交给 selected `ProjectSessionStorageProvider`；但 `ProjectSessionRuntimeBundle` 把
`storage.transcript` 传给 `SessionSubagentTranscriptBundle`，后者调用
`JsonlTranscriptWriter.forSubagent()`。因此 one-shot child 总是新建 JSONL writer，尽管 parent
session 已选择另一个 backend。`readSubagentWebMessages()` 也直接按 parent JSONL 和
`transcriptRelativePath` 读取，`GatewaySessionHistoryBundle` 没有把 `storageProvider` 传入该 reader。

这不是将 sidechain 伪装成 `SessionTranscriptReaderPort` 的理由，也不是新建 generic storage registry 的
理由。它有两个已存在的 consumer：`agent` tool 的 one-shot child durable transcript，以及 Web subagent
history；并且 parent durable `subagent_started` 已包含 `subagentSessionId`。R5-C 已以 parent storage owner
派生 child storage，使 logical child identity 进入 provider，而 native filesystem 保持
`<parent>/subagents/<subagentId>.jsonl` 兼容布局。

### 2026-09-12 Context Storage 与 Browser Upload Lifecycle 复核

`InstructionDiscovery` 和 `ToolResultBudget` 之前已经有窄 I/O port，但项目 generation 没有统一选择点；
这会让 future provider 必须越过 session composition，或让 consumer 重新构造 Node I/O。现由
`ProjectContextStorageBundle` 在 `ProjectRuntimeResourcesBundle.stage()` 选择
`InstructionStoragePort` / `ToolResultSpillPort`，并由 `ProjectSessionRuntimeBundle` 将冻结的同一实例交给
`SessionContextRuntimeBundle`。真实 `createLocalGateway` session 回归证明 injected instruction provider 的内容
确实进入模型 `systemPrompt`，而不仅是 bundle identity test。

该 seam 的 owner 没有变化：instruction provider 只读文件/目录，discovery 仍决定 layer order、dedupe 和 prompt
policy；spill provider 只执行 exclusive write/copy，budget 仍决定何时替换模型可见 tool result。它不拥有 prompt
registry、compaction、session durable state、turn state 或 model routing。因此它是 M2 native composition，不是
generic context/storage registry，也不预示远程 storage backend。

浏览器上传的正确 seam 是整个 artifact lifecycle，而非把 `UploadStore` 的文件路径泄漏给 HTTP 或 Gateway。
`UploadLifecyclePort` 定义 create/get/part/complete/cancel/fail/subscribe/cleanup 和窄的 artifact lease view；
native `UploadStore` 仍拥有 manifest admission、integrity、metadata、artifact retention 与 cleanup。
`GatewayDialogBundle` 只选择 lifecycle provider，`GatewayUploadedAttachmentBundle` 只在 turn admission 获取并释放 lease，
`createUploadRoutes(lifecycle)` 只作为 HTTP/SSE consumer；`CreateLocalGatewayOptions.uploadLifecycle` 现在是主应用
入口的显式选择点。测试覆盖 custom lifecycle 的 Gateway composition、真实 local Gateway turn 和 HTTP route
creation/cancellation，因而当前状态为 M2 local。

这里的“provider selection”仍是应用入口级别的局部选择：`ui/server` 作为独立 HTTP 进程继续默认创建自己的
native `UploadStore`。跨进程共享自定义 upload backend 需要明确的部署 contract 和故障恢复语义，不能仅凭两个进程
使用相同磁盘路径就宣称已经完成。

附件内容投影与 upload lifecycle 不是同一 provider。`AttachmentPort` 只负责 `stat/readText/readBytes`；
`AttachmentResolver` 继续拥有格式、大小、MIME 和 canonical content policy，
`GatewayAttachmentTurnComposer` 继续拥有 channel attachment 到 agent input 的 turn-local mapping。
此前 `createLocalGateway` 无条件构造 Node attachment provider，虽然下层可注入却不能由应用选择；现
`CreateLocalGatewayOptions.attachmentPort` 通过 `GatewayDialogBundle` 交给 resolver。真实 Gateway turn
回归证明 injected text provider 被调用，产物进入模型 canonical request；不改变 `AgentLoop`、Session durable
state、path authorization 或 upload lease owner。

同样地，`GatewayToolResultArtifactStorePort` 已是 `GatewayAgentEventProjector` 的既有 live projection
dependency，但 Local Gateway 之前固定创建临时目录的 Node store。现由
`CreateLocalGatewayOptions.toolResultArtifactStore` 选择该 provider，并把同一实例交给 projector 和
`InProcessGateway`。真实 tool turn 回归确认 injected store 收到 `sessionId/turnId/toolCallId/text`，返回路径出现在
Gateway `tool_call_finished` frame；它不会影响 canonical tool result、Session transcript 或 turn terminal。

这不完成通用 attachment registry、跨项目/跨 provider query、远程 upload provider 或产品 retention policy。出现
第二 provider 或上述明确 caller 前，禁止以抽象对称性把它们并入 `SessionRuntime`、Gateway live state 或 AgentLoop。

### 2026-09-12 Session title provider composition 复核

DSH 的 `session-title` 同时包含 provider registration、标题来源和可恢复 projection；PilotDeck 原先只有
`SessionTitleGenerator` 函数。现已新增 `SessionTitlePort`，native model-backed generator 作为 provider，
并由 `ProjectRuntimeResourcesBundle` 在 generation stage 选择 provider、在 generation dispose 时精确释放；
`ProjectSessionRuntimeBundle` 和 `TurnRunner` 只消费该 port。`sessionTitleGenerator` 仍保留为兼容入口，
因此 direct/native 现有调用不变。

`createLocalGateway({ sessionTitleProviderFactory })` 的真实 turn 回归证明 provider 收到正确的
`sessionId`、`turnId` 和用户文本，Gateway dispose 后 provider disposer 只调用一次。provider 只提出标题；
`SessionMetadataStore`、Session transcript 和 metadata projection 继续是 durable owner，标题失败仍为
fail-soft，不会改写 turn terminal。

这使该能力达到 **M2 native+**：metadata 已记录 provider/model provenance、user-pinned source、source turn
和 accepted-input sequence，并保持旧 `title/aiTitle` 读取兼容。由于 PilotDeck 的 accepted input 仍是一个聚合
transcript event，本轮没有伪装成 DSH 完整 parity；独立 `user/message` seq 投影仍需单独 transcript contract，
只有出现跨端精确对拍需求时再扩展，不引入第二模型或第二 title provider。

### 2026-09-12 Always-On 项目记录 provider 复核

Always-On 以前在 `AlwaysOnRuntime` 与独立 `createApplyHandler()` 中分别直接构造 state、plan、cycle、report
和 event store。即使调用方已选择相同路径，这仍让 runtime 与 standalone apply 可能选择不同的 durable backend；
初版 provider 直接返回这些具体类，但类的私有路径字段会使第三方 provider 无法在 TypeScript 边界实现它。

现由 `AlwaysOnProjectStorageProvider` 统一选择 project paths 和五个结构化 port：
`DiscoveryStateStorePort`、`DiscoveryPlanStorePort`、`WorkCycleStorePort`、`DiscoveryReportStorePort` 与
`AlwaysOnEventStorePort`。每个 port 只声明 runtime、scheduler、phase tool 和 apply flow 实际调用的方法；native
filesystem provider 继续复用现有 JSON/Markdown/JSONL layout。`AlwaysOnManager`、`ProjectAutomationBundle`、
`AlwaysOnRuntime` 与 standalone control 都传递同一个 application-selected provider，因此 enabled scheduler
和 disabled-Always-On 时仍可用的 apply 入口不再绕过选择点；fallback control 也透传相同 provider。

回归使用完全不实例化 native store 的 plain-object provider：runtime 与 standalone apply 都从它读取 missing
cycle，任何未预期的 state/plan/report/event 调用都会立即失败。这证明 Definition 可被替换，而不只是 native
factory 的构造去重。

**明确边界**：provider 不拥有 scheduler timer、signal watcher、workspace、run-context registry、Gateway
live control、lease 或 Session durable truth；也不提供 remote scheduler、distributed locking、跨项目 record
query、generic workflow、自动 retry 或第二 persistence backend。只有这些能力出现真实产品 caller 与 owner 时再
分别立项。

### 2026-09-12 Cron 项目记录 provider 复核

Cron 之前虽然已有 `CronControlPort`，但 durable task/run records、legacy migration、启动时项目发现和
`.cwd` marker 仍由 `CronManager` 直接实现；每个 `CronRuntime` 也直接构造 `CronTaskStore`。这使 manager 与
runtime 的 project record backend 无法由应用组合选择。

现由 `CronProjectStorageProvider` 统一提供 `CronTaskStorePort`、legacy migration、project key discovery 和
record marker。native provider 保持现有 `tasks.json`、`run-history.jsonl`、run-event 与 marker 布局；
`CronManager` 只负责多项目生命周期和 active-run 聚合，`CronRuntime` / `CronScheduler` / `CronFire` 只消费
task-store port。`ProjectAutomationBundle` 将 application-selected provider 透传到 manager 和其后创建的
runtime。

纯对象 provider 回归覆盖 manager 的启动、发现、创建、查询和停止路径，所有 storage 方法均为 provider-owned
实现，不依赖 native `CronTaskStore`。这样既验证了结构化替换边界，也保持 direct `store` 注入作为旧测试和
低层 native caller 的兼容入口。

**明确边界**：provider 不拥有 schedule timer、active run、Gateway turn、session override、result delivery、
control aggregation 或 Session durable truth；不提供 distributed scheduler、remote worker/queue、跨项目
query、generic workflow、自动重试或 retention policy。只有出现对应真实 caller 与 owner 时再单独立项。

### 2026-09-12 Memory provider composition 复核

Memory 原先只有 `ProjectMemoryBundle` 内部的 EdgeClaw factory，底层 `MemoryResolver` 虽然可替换，
application entrypoint 却不能选择第二实现。这使 Definition 存在，但 Provider/Composition 只在 native 路径闭合。

现已定义窄的 `ProjectMemoryProvider` contract：provider 必须提供 `MemoryResolver`，可选提供仅含
`runDueScheduledMaintenance` 的 maintenance port，以及由 bundle 精确拥有的 `dispose`。native
`createEdgeClawMemoryProviderFromConfig` 仍是默认 provider，并由 `ProjectMemoryBundle` 适配为同一 contract；
EdgeClaw SQLite service 的 durable DB、索引和维护实现继续归 provider 内部，不向 ContextRuntime 泄露。

`DefaultContextRuntime` 是 retrieval/capture consumer，`ProjectMemoryMaintenanceController` 是异步维护
consumer；`createLocalGateway({ memoryProviderFactory })` -> `ProjectRuntimeRegistry` ->
`ProjectRuntimeResourcesBundle` 在每个 project generation 冻结 provider。generation retire/drain 后，bundle
才执行该 provider 的 disposer；resolver 错误产出诊断并隔离于 turn terminal，maintenance 错误只进入 telemetry
和 diagnostic，不阻塞已完成 turn。

真实 Gateway session 回归证明 application-selected resolver 被调用并接收 capture，runtime dispose 对自定义
disposer 精确执行一次。该切片不创建 generic memory registry、不复制 Session durable truth、不把 scheduler
放入 memory provider，也不宣称远程 memory、跨项目 query 或 retention 已完成。

### 2026-09-12 Router session provider composition 复核

Router 的 sticky decision state 跨 project runtime generation 共享，但它是 volatile routing policy，不是
Session durable event。此前 `ProjectRuntimeRegistry` 固定创建并在 shutdown 时清理 native state，应用无法选择
自己的 bounded/TTL state provider；session custom-router index 也固定由每个 generation 构造。

现由 `CreateLocalGatewayOptions.routerSessionState` 选择 application-owned `RouterSessionStateProvider`，
并由 `routerSessionCustomRouterFactory` 为每个 project generation 选择 `RouterSessionCustomRouterPort`。
Registry 只清理由自己创建的 native state；generation bundle 精确拥有并 dispose 自己创建的 custom-router index。
RouterRuntime 仍是 state/custom-router consumer，plugin contribution lease 仍拥有 router 实例本身。

真实回归覆盖：selected state 的 get/set 在 reload 后继续被新 RouterRuntime 消费，shutdown 不清理外部 provider；
selected custom-router 被真实 `RouterRuntime.decide` 使用，并在 generation teardown 后 dispose 一次。该切片不
复制 Session durable state、不迁移 plugin lifecycle、不提供 remote router 或 generic policy registry。

### 2026-09-12 Session Goal native/local 闭环

DSH 的 goal 参考价值是把 session 的目标状态从 prompt 文本中拿出来，交给 event truth、projection 和
tool consumer 形成可恢复边界；它不要求 PilotDeck 预先拥有 generic workflow engine。现已新增
`goal_changed` full-snapshot / null-tombstone event，`goal.state` projection 和 checkpoint codec。`GoalPort` 按
session identity 限制访问，`NativeGoalRuntime` 串行化 mutation 并以 revision CAS 拒绝过期写入；domain validation
也要求 revision 连续，因而坏 provider 不能先写入 durable log、再等 projection 报错。

`get_goal`、`create_goal`、`update_goal` 是真实模型工具 consumer：create、edit、pause、resume、complete、block
和 clear 都通过 runtime 写入 `AgentTranscriptWriter.recordSessionEvent()`。`ProjectSessionRuntimeBundle` 在现有
storage/projection 准备完成后经 `SessionGoalBundle` 组合该 capability；它只向 `AgentLoop` 的 tool context 增加
窄 handle，不改变 AgentLoop 调度、Gateway live state 或 sidecar capability 协议。Local Gateway model-turn 回归、
runtime CAS/clear/replay/checkpoint 回归和 provider-missing failure mapping 共 **5/5** 通过。

**明确不做**：Goal 不自动启动下一轮 AgentLoop，不表示 cron/Always-On/background task 的统一 run owner；没有
remote provider、跨 session query、retention、workflow settlement 或 sidecar goal cache。上述任何一个需求都需要
新的 caller、owner 与恢复语义，不能由本切片推断。

### 2026-09-12 Sidecar host checkpoint context 复核

已完成：native `AgentLoop` 在每次工具执行时，把同一份
`readFileState`、`writeSnapshots` 及累积的 `allowedReadFiles` 注入 `PilotDeckToolRuntimeContext`；这三项分别是
`read_file` 去重、`write_file`/`edit_file` 的“先读后写”快照验证，以及本 turn attachment/steer 路径授权的
唯一 live owner。

现由 `HostToolCheckpoint` 在 host 侧持有每 turn 的 mutable map：它从 seed clone 初始化、合并
`input.allowedReadFiles`，并向每次 capability/permission context 与 one-shot fork 传入同一 map。工具的读写
mutation 不再留在一次性 context；known terminal 以 host checkpoint snapshot 写入 runner 和 Session operation ledger，
不会再被 sidecar 执行前的 stale seed 覆盖。

sidecar wire 仍只收到 execute 开始时的受控投影；host capability payload 不传私有 map，也没有新增 protocol method、
sidecar durable state 或第二 Session truth。`result_unknown` 继续使用既有 ledger reconciliation，不以当前内存
checkpoint 伪造成功终态。

loopback sidecar 回归覆盖 initial seed、current-turn attachment path、两次 host tool mutation、one-shot parent map、
`session.snapshotForRuntimeReload().fileState` 和 durable operation terminal seed。Node 22 build 与完整
`sidecar-client` focused suite **19/19 通过**。

### 2026-09-12 Sidecar permission-context canonicalization 复核

本次将 native `AgentLoop.createToolContext()` 与 sidecar host 的 `toolRuntimeContext()` 逐字段比对，发现一个
真实的 policy parity 缺口：native 会在展开 `config.permissionContext` 后强制写入
`cwd: config.cwd`，而 sidecar 的 `effectivePermissionContext()` 之前只保留展开后的旧 `cwd`。当配置对象的
permission cwd 与 agent cwd 不同，sidecar 的工具仍在 `config.cwd` 执行，但 permission rule matching 会在另一
个 cwd 判定，破坏了同一个 turn 的 policy domain。

这属于现有 host ToolRuntime context reconstruction，不属于 Module Protocol、Session 或 transport state：已在
sidecar host 侧将 permission context canonicalize 到 `config.cwd`，并以刻意构造 cwd 不一致的
native/host-capability 回归证明两条路径的 decision 相同。相邻的
`subagentTimeoutMs`、`maxResultBytes`、`modelMultimodal`、`maxOutputTokens` 当前使用真值条件装配，native 则直接
传递；zero-value audit 已确认 `maxOutputTokens` 和 subagent timeout 在 application config 中必须为正整数，
`modelMultimodal` 是对象型可选值，因而没有合法 `0` / `false` 语义可修复。不能机械地把所有条件改成
`!== undefined`。

### 2026-09-12 Active stream replay retention 复核

当前 PilotDeck full deterministic parity 在 `multi_tool_ordered` 与 `tool_non_retryable_error` 中暴露了一个真正的
transport lifecycle 缺口：`SidecarStreamReplayStore` 从 execute accepted 就开始 30 秒 TTL；慢模型、host tool 或
reconnect 后的 active stream 在尚未产生下一条 event 时会被 `pruneExpired()` 删除，随后 server 的 `append()` 抛出
`Sidecar stream ... has expired`，使 sidecar 在可恢复的 live operation 中退出。

已将 replay store 的 TTL 明确为 **terminal 后** 的有界 retention：active stream 不因空闲时间过期，rebind、resume
和 ack 只刷新已终态 stream 的 TTL；第二个 terminal event 继续被拒绝。它仍是 process-local wire cache，不能成为
Session/Gateway state 或替代 `result_unknown` durable reconciliation。focused replay suite 覆盖 quiet active stream、
rebind、terminal expiry、ack trim 与 cursor/binding failure，共 **4/4 通过**；此前冻结的 PilotDeck
native/sidecar matrix **38/38 通过**。当前 StaffDeck harness checkout 含未提交 adapters/scenarios；并发安全 callback
的 completion trace 已收敛为唯一 identity 的条件归并，`auto_compact` oracle 已固定为
`failed/prompt_too_long`。该历史回顾当时尚未冻结完整 dirty-harness matrix；随后 comparator、oracle 与
plan-mode transition 后的 host callback、下一 turn policy、exit 和 TCP replay 均已完成，当前完整 matrix 为 38/38。

### 2026-09-12 Sidecar dynamic execution-mode ownership 复核（已完成；P1 补 parity coverage）

本轮对照 DSH 的 scope identity 与 PilotDeck 的实际 callback 重建链路，发现 R5-Y 的 cwd canonicalization 并未覆盖
另一条更关键的动态 state：native `AgentLoop` 在 `enter_plan_mode` / `exit_plan_mode` 的成功 tool result 后，立即更新
同一 live agent 的 `config.permissionMode`、`permissionContext.mode` 与 `permissionModeBeforePlan`。后续同 turn 的
permission、capability、lifecycle 和下一 turn 的 prompt 都读取这个更新后的 state。

**已完成的 Z1（permission transition）**：`HostPermissionModeState` 已被
`AgentLoopSidecarRunner` 持有。它先应用 host submit override；仅当 host `capability.execute` /
`execute_batch` 返回成功 tool result 后，才依据 `requestedMode` 更新 `config.permissionMode`、
`permissionContext.mode` 和 `permissionModeBeforePlan`。ToolRuntime、permission、lifecycle 与下一 turn
都读取同一 host config；module response 已在送回 socket 前缓存，因此 TCP 重放不会二次执行 transition。native / loopback
覆盖 enter、plan 下 write deny、exit 与 next-turn；TCP 覆盖 enter response 丢失后的单次 host tool 调用和 host mode 保持。

**已完成的 Z2（host policy canonicalization）**：`AgentLoopSidecarRunner.run()` 在连接前以
`input.runMode ?? config.runMode ?? "agent"` 更新同一 host config，与 native `applyRunModeOverride()` 的时序一致。
`withContextIdentity()` 继续固定 `sessionId`、`turnId` 与 `cwd`，并强制将 `permissionMode` 和 `runMode` 覆盖为该 host
config。因此 `DefaultContextRuntime`、host `ToolRuntime`、permission 与 lifecycle callback 读取同一个 live policy；wire
payload 只能传递业务 context，不能升级或降级 host policy。无 `runMode` 的下一 turn 保留已生效的 host live mode。

`sidecar-client` 的真实 loopback sidecar + `ToolRuntime` 回归已证明：submit `ask` 后，即使模型发出
`write_file`，host 仍返回 `ask_mode_violation` 且不会调用 write handler；伪造 context 的
`bypassPermissions` / `agent` 不能覆盖 host 的 `default` / `ask`，第二 turn 也不能回退该 mode。该修复没有修改
`AgentLoop.ts`、没有新增 Module Protocol 字段，也没有把 mode 写入第二份 Session durable truth。

**R5-Z 的完成定义已达成**：host runner 是 permission mode 与 run mode 的唯一 live policy owner。它在连接前应用
经过 host admission 的 submit-time override；context、tool、permission 和 lifecycle callback 一律从该 state canonicalize，
remote payload 只能携带业务输入，不能升级或降级 policy。已确认成功的 `enter_plan_mode` / `exit_plan_mode` 仍只由 host
capability result 推进；run mode 没有 sidecar tool transition。该 state 是 runner live state，不写入第二份 Session durable truth。

**P1 验收已完成**：实现、focused plan-mode contract 与 harness comparator/oracle 均已闭环；当前 worktree 的完整
PilotDeck matrix 为 **38/38**，零 semantic/oracle failure、零 blocked，`cancel` 与 `cancel_during_tool` 仅保留格式告警。
该回归不增加 runtime owner 或 protocol：

1. 固定 StaffDeck adapter/scenario revision；不将含未提交 fixture 改动的 all-matrix 结果写作 PilotDeck runtime baseline。
2. 为每个 `concurrencySafe` tool completion 记录不可变 tool-call identity；仅当同一 batch 的工具均声明并发安全且 identity 唯一时，按 identity 比较 callback result，而不是按 wall-clock completion 顺序。非并发、含副作用或重复 identity 的调用继续严格保序，不能通过通配排序掩盖副作用问题。
3. `auto_compact` 以已观察到的 native/sidecar 一致 terminal `failed/prompt_too_long` 作为 oracle；它是 product failure，
   但不是 parity failure。
4. `sidecar-client` 的 native/sidecar contract 已按最小序列证明 `enter_plan_mode` -> host capability callback ->
   下一 turn plan policy -> `exit_plan_mode`，并对拍 permission/context、callback 数量和顺序、最终 exit state；TCP replay
   额外证明 transition 不重复。
5. 完整 PilotDeck matrix 已回归；format warning 继续与 semantic/oracle failure 分开报告。

失败、deny、unknown 或不匹配的 permission transition 一律保持 host 已知 mode，不从 sidecar event/final payload 猜测状态。

## 强制边界

以下 owner 不能因模块化或 sidecar 接入而迁移：

```text
SessionRuntime       durable event / persistence / projection 的唯一真源
Gateway / Router     session routing、operation aggregation、live pending state
AgentTurnInbox       continuable child 的唯一 FIFO admission owner
Host ToolRuntime     scheduler、permission preflight、side effect control
Sidecar / transport  仅执行 capability projection，绝不持有上述 durable 或 public state
```

每个工作包都先提交下面六项，缺一项不进入代码：Definition、Provider、Consumer、Composition、
state owner（durable/live/volatile）、failure mapping + teardown。禁止用“把宽 dependency bag 改名”、
“新建空 Port”或“把 Gateway 状态复制到 sidecar”充当模块化。

## 优先级路线图

| 状态 / 优先级 | 工作包 | 启动条件 | 交付结果 | 不在本包内 |
| --- | --- | --- | --- | --- |
| 已完成 | R3.1 one-shot deadline budget 继承 | `agent` tool 是真实 native/host callback consumer；Gateway 也会将有效 `timeoutMs` 单次派生为 `operationDeadline` | native scheduler 与 host callback 都将 child budget 收紧为父 operation deadline；timeout 与 parent abort 可区分 | 不修改 `AgentLoop.ts`、不新增 transport method、不建立 remote provider |
| 已完成 | R2-B sidecar process restart recovery（transport consumer） | 有实际长生命周期 TCP deployment、Session ledger 与显式 host reconciler contract | process 重启后只查询 host durable ledger 或显式 reconciler；未得到 known terminal 时保持 `result_unknown` | 不把 replay cache、Gateway pending state 或 tool result 搬进 sidecar；不把 contract 误当成产品 status-query provider |
| 已完成 | R2-C pending host module-call reconnect | TCP sidecar 已进入真实 permission/question consumer；Gateway interaction reconnect 已存在 | 同一存活 sidecar 在 host reply 尚未送达时恢复 `module_call`，不重复 permission/tool 等副作用 | 不把 interaction policy、pending UI 或 Gateway state 放入 transport |
| 已完成 | R5-B session history read-side | Always-On digest 与 chat-history 已是两个真实 durable transcript consumer；write-side 已支持 provider selection | Definition、native provider、两个 consumer 与 project/standalone composition 闭环；完整读取尊重 selected persistence provider，默认 JSONL 优化封装在 provider 内 | 不将 catalog/search 伪装成 generic retention/query；不将 file-aware fork/replace/sidechain 写入压进 read-only port |
| 已完成 | R5-C one-shot subagent sidechain storage selection | `agent` tool、parent `subagent_started.subagentSessionId` 与 Web subagent history 已是实际 consumer；continuable child 已证明 selected provider 可承载 child session | child storage 由 parent storage owner 派生；provider 获得 logical child session id；native sidechain 路径兼容；Web 优先 provider read、仅为 legacy/background 回退 JSONL | 不做 generic storage registry、fork/replace transaction、remote subagent 或 `AgentLoop.ts` 改动 |
| 已完成 | R5-D provider-selected session catalog | Session catalog 已是 Gateway/Web/Always-On 的真实 consumer，write/history 已有 selected-provider 语义 | provider 声明 `catalog` 后所有 composition 选择同一实例；未声明时 enumeration fail-closed，精确 history 仍走 selected persistence | 不将 catalog 扩张为 search、retention、fork/replace 或 generic query abstraction |
| 已完成 | R5-G standalone read-side composition | Always-On 的 native factory、manager 与 standalone control 是 `ProjectAutomationBundle` 外的真实 history/catalog consumer | shared `ProjectSessionReadSideBundle` 统一 explicit override 或 provider selection；无 catalog 仍 fail-closed | 不把 search、retention、write transaction 或 Session owner 收进 bundle |
| 已完成 | R5-H provider-selected session search | CLI/server/channel 是已有 search consumer；selected storage provider 需要避免回退 JSONL | `ProjectSessionStorageProvider.search?` 与 `createProjectSessionSearchPort()` 统一 search provider selection；无能力时 fail-closed | 不定义跨 backend query/retention，不将 search 写入 Session 或扩张 read-side bundle |
| 已完成 | R5-E provider-selected Web fork | Web fork 是已有产品 caller；native provider 已有辅助资产 copy/path retarget 语义，selected persistence 需要可替换 target-stream writer | `ProjectSessionForkPort` 由 provider 声明；Web 只准备 fork plan，Gateway 透传 selected provider；native JSONL 原子发布，non-native 未声明即 fail-closed | 不将 journaled replace-last-turn、search、retention 或 generic mutation registry 合入 fork port |
| 已完成 | R5-F provider-selected Web replace | Web edit 已有 Gateway prepared transaction、rollback timeout 和 native journal/recovery consumer；selected persistence 不能另行扫描 JSONL | `ProjectSessionReplacementPort` 由 backend 拥有 backup/rewrite/finalize/recover；Web 只构造 rewrite plan，Gateway 保持 live reservation；未声明即 fail-closed | 不将 fork、search、retention 或 Gateway pending state 移入 replacement provider |
| 已完成 | R5-I project context-storage composition | instruction discovery 与 large tool-result spill 已有实际 session-context consumer，project generation 需要稳定 provider selection | `ProjectContextStorageBundle` 选择 instruction/spill provider；`createLocalGateway({ contextStorage })` 将 runtime resource 冻结后原样传入 real `SessionContextRuntimeBundle`，native Node provider 保持默认 | 不改变 prompt layer/replacement policy，不创建 generic context registry、第二 storage backend 或 `AgentLoop.ts` 改动 |
| 已完成 | R5-J browser upload lifecycle provider | HTTP/SSE upload flow 与 Gateway uploaded-attachment lease 已是两个真实 consumer | `UploadLifecyclePort` 让 provider 统一拥有 manifest、integrity、artifact/retention/cleanup；Gateway 只消费 lease，HTTP routes 只驱动 lifecycle；`createLocalGateway` 已提供显式 upload provider 入口 | 不创建跨进程自定义 provider 自动发现、跨 provider query/retention、通用 attachment registry、remote provider 或把 upload metadata 写入 Session truth |
| 已完成 | R5-K Gateway attachment I/O provider selection | channel/UI attachment projection 已有 `AttachmentResolver` 与 `GatewayAttachmentTurnComposer` consumer，但 Local Gateway 原先固定构造 Node I/O | `CreateLocalGatewayOptions.attachmentPort` 将 application-selected provider 传给 dialog/resolver；真实 turn 证明 canonical model request 使用 injected content | 不把 MIME/size policy、path authorization、upload lifecycle、retention/query 或 durable session state 移入 provider |
| 已完成 | R5-L Gateway tool-result artifact provider selection | `GatewayAgentEventProjector` 和 `InProcessGateway` 已消费 artifact port，但 Local Gateway 固定构造 Node temporary store | `CreateLocalGatewayOptions.toolResultArtifactStore` 选择同一 advisory store；真实 tool turn 验证 provider input 与 Gateway live result path | 不把 preview artifact 当作 Session/replay/terminal truth，不定义 retention/query 或 remote artifact contract |
| 已完成 | R5-M Always-On project durable-record provider selection | runtime scheduler 与 standalone apply 是同一 state/plan/cycle/report/event family 的实际 consumer；`ProjectAutomationBundle` 已是 project composition owner | structural `AlwaysOnProjectStorageProvider` 统一 native or injected records；runtime、scheduler、fire、tool context 和 standalone apply 只依赖窄 port；plain-object provider 回归证明非 native replacement | 不提供 remote scheduler/workspace、distributed lock、generic workflow、Session ownership 或跨项目 query |
| 已完成 | R5-N Cron project durable-record provider selection | manager 启动/发现、runtime、scheduler、fire 和 `ProjectAutomationBundle` 都是 task/run record 的真实 consumer | structural `CronProjectStorageProvider` 统一 native or injected task-store、legacy migration、project discovery 和 marker；manager/runtime/scheduler/fire 只消费窄 port；plain-object provider 回归证明非 native replacement | 不提供 remote queue/worker、distributed scheduler、generic workflow、Session ownership、跨项目 query 或 retention policy |
| 已完成 | R5-O Memory provider composition selection | `DefaultContextRuntime` retrieval/capture 与 maintenance controller 是真实 consumer；project generation 需要稳定 provider selection | `ProjectMemoryProvider` contract、native EdgeClaw adapter、`createLocalGateway({ memoryProviderFactory })` composition、custom resolver/capture/dispose 回归；maintenance 继续使用窄 port | 不提供 generic memory registry、remote memory、跨项目 query、retention policy、scheduler ownership 或 Session durable truth |
| 已完成 | R5-P Router session provider composition | RouterRuntime 是真实 routing consumer；sticky state 需跨 generation 保持，custom-router index 需按 generation 隔离 | `routerSessionState` 选择 application-owned volatile state；`routerSessionCustomRouterFactory` 选择 per-generation registry；reload identity、real custom decision、external-state non-clear 与 exact teardown 回归 | 不提供跨项目 routing cache、remote router、generic policy registry 或 Session durable truth |
| 已完成 | R5-Q Compaction provider composition | ContextRuntime 已有 `CompactionPort` consumer，project generation 需要稳定 provider selection | `compactionProviderFactory` 从 Local Gateway 贯通至 project/session context bundle；真实 session turn 消费 selected provider，generation dispose 精确一次，native provider 保持默认 | 不迁移 Session durable replacement、AgentLoop、Gateway live state；不预建 remote compaction 或 generic context registry |
| 已完成 | R5-R Prompt-cache coordinator composition | ContextRuntime 已有 `PromptCacheCoordinatorPort` consumer，cache generation 是 session-scoped volatile state | `promptCacheCoordinatorFactory` 从 Local Gateway 贯通至 project/session context bundle；真实 session turn 消费 selected provider | 不把 cache plan 写入 Session durable truth，不跨 session 共享未声明 state，不预建 remote cache service |
| 已完成（native M2+） | R5-S Session title provider composition | `TurnRunner` 已是真实 title consumer，且 project generation 需要稳定 provider selection | `SessionTitlePort`、native provider、Local Gateway/project/session composition、真实 turn consumer 与 generation dispose；metadata 记录 provider/model provenance、user pin、source turn 和 accepted-input sequence；旧 `SessionTitleGenerator` 保持兼容 | 独立 `user/message` seq 投影仍按真实跨端需求再做；不修改 AgentLoop 主循环，不把标题生成失败升级为 turn failure |
| 已完成（native M2） | R5-T LSP runtime provider | LSP tool 是真实 model consumer，Local Gateway 提供显式 `lspServiceFactory` | `LspService` Definition/registry、Node stdio provider、`lsp` tool consumer、workspace containment、AbortSignal 取消、结果规范化、`LSP_TIMEOUT`、server request reply 和 protocol shutdown；不改变 AgentLoop core | remote provider、持久 server pool、插件 manifest 自动装配和 editor consumer 仍按需求立项；不把 LSP process 放进 Session 或 sidecar owner |
| 已完成（native M2） | R5-V session-scoped durable goal | DSH `goal` 有明确 session caller；模型需要读取、创建和推进目标，且 SessionRuntime 已是 durable event owner | `goal_changed` event、`goal.state` projection/checkpoint、CAS 串行 mutation owner、session-bound `GoalPort`、`get_goal`/`create_goal`/`update_goal` 三个工具、Local Gateway 真实 model turn 与 fail-closed provider 缺失错误 | 不实现自动 continuation、统一 workflow run owner、remote goal provider、跨 session query 或将 goal state 放入 sidecar/Gateway |
| 已完成（native/sidecar M2） | R5-W sidecar Goal host-context parity | 现有 sidecar 已广告并调用所有 session tool；Goal 是其中唯一依赖 session-bound tool context、但未在 host reconstruction 注入的真实 consumer | `capability.execute` 以 active session identity 从既有 `GoalPort` 取得 `GoalSessionPort` 并传入 host ToolRuntime；sidecar 只保留 descriptor 与普通 tool result，`goal_changed` 只追加至 host Session log | 不新增 Module Protocol method、Goal cache、sidecar mutation provider、workflow registry 或第二 durable writer |
| 已完成（native/sidecar M2） | R5-X sidecar host checkpoint context parity | sidecar 已通过 host capability 执行 `read_file`、`write_file`、`edit_file`、attachment path 和 one-shot child fork；这些 consumer 依赖 native loop 持有的 mutable file checkpoint | `HostToolCheckpoint` 让每次 host capability/permission dispatch 和 one-shot fork 共享 per-turn map；known terminal 以 host snapshot 推进 runner seed 与 Session operation ledger | 不新增 Module Protocol 方法、sidecar durable state、通用 checkpoint registry、第二 Session truth 或 `AgentLoop.ts` 改动 |
| 已完成（native/sidecar M2） | R5-Y sidecar permission-context canonicalization | native 与 sidecar 的 host ToolRuntime context 对拍已发现 permission cwd 可与 tool cwd 分离 | `effectivePermissionContext()` 固定 `cwd: config.cwd`；cwd 不一致的 native/sidecar capability/permission 场景证明同一 rule、同一 tool、同一 turn 得到相同 allow decision；zero-value audit 确认 public config 不接受 `0` timeout/token cap | 不新增 Module Protocol 字段、全局 config adapter、sidecar state、Session truth 或 generic permission registry |
| 已完成（native/sidecar M2）；P1 已验收 | R5-Z sidecar dynamic execution-mode owner | native `AgentLoop` 已有 submit-time `runMode` 与 enter/exit-plan live state machine；sidecar 的真实 host context/tool/permission/lifecycle callback 必须读取同一 host policy | host runner 以 host-confirmed capability result 驱动 permission transition，并在连接前接管 run-mode override；context payload mode 被 canonicalize；`ask` host write gate、next-turn state 与 TCP replay 均和 native 一致。完整 PilotDeck matrix **38/38**，零 semantic/oracle failure/blocked；仅 cancel 相关 format warning | 不修改 `AgentLoop.ts`、不采信 remote mode 为 authority、不新增 Module Protocol 字段、不持久化第二份 Session mode 或创建 generic registry |
| P1（已完成） | PARITY-H deterministic harness baseline | harness 仅以唯一 `toolCallId`、显式 `concurrencySafe`、zero side effect 为条件归并并发 completion；`auto_compact` 固定为 native/sidecar 同样的 `failed/prompt_too_long` | 当前 worktree 完整 PilotDeck matrix **38/38**：零 semantic failure、零 oracle failure、零 blocked；`cancel` 与 `cancel_during_tool` 各有两条不改变语义的 format warning。non-concurrent、重复 call 和 side-effect trace 保持严格顺序 | 不修改 PilotDeck runtime，不放宽 semantic comparator，不把 oracle failure 标为 format warning |
| 明确不做 | R5-U deployment profile/bundle 收敛 | 用户明确不做第二个完整 deployment（headless、remote 或 SDK） | 保持当前 Local Gateway 组合根、既有 runtime profile、provider selection、boot rollback 和 shutdown ownership；不扩展第二部署矩阵 | 不复制 Cordis patch API，不创建第二份 deployment state，不为 package 对称性增加 provider |
| P1 | R2-D 产品侧非幂等副作用 status query | 某个实际 tool/provider 有 idempotency key 与状态查询 owner | process restart 后以该产品 owner 的 known/unknown 结果收敛，不自动重试副作用 | 不为没有真实 owner 的 tool 虚构通用 status API |
| P2 | R3-B remote or queued subagent | 出现真实异进程 child provider 与 run owner | provider lease、restart、late terminal、sidechain 和 settlement 的端到端语义 | 不把 continuable inbox 或 child Session 复制到 sidecar |
| R4-A/B（当前 seam；provider 产品按需） | 模型 execution/routing 解耦与第三方 provider adapter contract | 需要独立 execution provider 或 routing policy 时可复用窄 port；本轮不做第二模型产品或第二 routing provider 产品 | 保持当前 native Router facade 作为默认 composition，同时允许显式 execution port、metadata/budget/auxiliary 独立注入；维护 prepared-request、retry、token、health contract | 不因目录对称、DSH 包数量或抽象完整性增加第二 provider matrix |
| WF-D（核心已完成） | 通用 Workflow 模块设计与 runtime vertical slice | R5-Z / PARITY-H 等 P1 验收完成后，已有多个 workflow-like caller 需要共享 run/step/recovery 语义 | `WorkflowDefinition`、caller/adapter contract、caller-owned run/event truth、DAG 状态机、pause/resume/cancel/deadline/dispose、late completion、failure/unknown settlement、JSONL/InMemory EventStore、control composition 和 focused contract matrix 已落地；领域 adapter 按真实 caller 另行立项 | 不实现 generic registry，不迁移 Plan/Todo、Cron、Always-On、Goal durable state，不接管 Session/Gateway/AgentTurnInbox owner；没有明确 caller 不进入领域 adapter implementation |
| 按需 | R5 产品能力 | 有明确 caller、run owner、durable/live state 和 recovery requirement | 针对 storage、attachment、sandbox 等形成独立 Definition/Provider/Consumer/Composition；Workflow 设计完成后再按 caller 选择 adapter | 不预建 generic registry 或第二 backend |

### 复核后的执行波次

路线图按“先闭合已有真实调用链，再在单一部署基线上设计通用语义”的顺序执行：

1. **Wave 0：基线与边界（持续）**。保持 `SessionRuntime`、Gateway/Router、`AgentTurnInbox`、Host
   `ToolRuntime` 和 sidecar 的 ownership；每个新切片必须有 Definition、Provider、Consumer、Composition、
   state owner、failure mapping、teardown 和真实 consumer 回归。
2. **Wave 1：已有实现的 parity 完整性（P1）**。先冻结并收敛 `PARITY-H`：并发安全 callback 必须按 tool-call
   identity 而不是 completion 时序对拍，`auto_compact` oracle 必须与确定的产品语义一致。随后补 `R5-Z` 的 deterministic
   scenario：`enter_plan_mode` -> host callback -> next turn -> `exit_plan_mode` 必须同时对拍 policy、callback 和终态，
   不只对拍文本。`ask` host write-gate、forged context、R5-Y cwd canonicalization、R5-X host checkpoint 与 R2-A
   active-stream lifecycle 继续作为回归门槛。之后仅在出现实际 side-effect owner 时落地 R2-D 的第一个非幂等
   `status-query` provider；`R5-S` 只有在 provenance 或明确 provider metadata 需求出现时才继续扩展。这一波不修改 `AgentLoop.ts`，
   不引入第二套 Session truth。
3. **Wave 2：通用 Workflow 核心（P1 后）**。`WF-D` 的独立 core vertical slice 已实现：与现有
   Plan/Todo、Cron、Always-On、Goal 解耦的 Definition、JSONL/InMemory event store、caller-owned run handle、control
   composition 和 adapter contract 已覆盖 run/step event truth、owner、状态机、暂停/恢复/取消/deadline/dispose、late
   completion、failure/unknown settlement。它不含 generic registry，不迁移既有 durable owner；在没有获批领域 caller 前不接入。
4. **Wave 3：按 caller 选择 Workflow adapter（按需）**。只有在 `WF-D` 有明确 caller、run owner 和 recovery
   requirement 后，才为一个真实 caller 实现 adapter/provider/consumer/composition；先验证一个最小 vertical slice，再决定
   是否扩展到其他 workflow-like runtime。Plan/Todo、Cron、Always-On、Goal 各自保留原 owner，adapter 只做投影或调用边界。
5. **明确不做的路线**。不做第二个完整 deployment（headless、remote 或 SDK），不做第二模型产品或第二 routing policy
   产品，不启动 R5-U；R4 的 execution/routing seam 与可选第三方 provider adapter 仅作为可复用架构 contract，当前 Local Gateway、
   native Router facade 和现有 profile/boot ownership 仍是唯一产品组合基线。
6. **其他按需产品线（不预排）**。LSP 的 remote provider、持久 server pool、插件 manifest 自动装配和 editor consumer
   只有出现实际部署/调用方时再立项；跨 provider query/retention、第二 persistence backend、distributed scheduler、
   跨平台 enforcing sandbox、durable terminal、remote subagent 仍各自独立立项；缺少 caller 或唯一 state owner 时保持
   M0，不用空 Port 占位。

### WF-D：通用 Workflow 模块设计门（P1 完成后）

`WF-D` 已实现为 `src/workflow/` core vertical slice，而不是领域 workflow 产品。它的目标是回答“哪些语义可以复用”，而不是把
Plan/Todo、Cron、Always-On、Goal 的现有实现包进一个大模块。

设计必须先冻结以下最小合同：

1. **Caller 与 owner**：每次 workflow run 必须由明确 caller 创建，并返回 caller 持有的 run handle；Workflow 不从
   Session、Gateway、AgentLoop 或 sidecar 的 ambient state 推断 owner。
2. **Run/step 状态机**：至少定义 `created`、`running`、`paused`、`cancelling`、`completed`、`failed`、`cancelled`、
   `unknown` 的合法迁移；step completion 和 run settlement 均只能发生一次。
3. **事实真源**：明确哪些 event 进入 SessionRuntime、哪些记录属于 project provider、哪些只保留 live/volatile；
   Workflow 不复制领域 durable projection，也不把 Gateway live snapshot 当成恢复真源。
4. **控制与故障**：定义 pause/resume/cancel、deadline、owner dispose、child completion、late completion、process
   restart 与 `unknown` 的映射；禁止用自动重试掩盖未确认的非幂等副作用。
5. **适配边界**：Plan/Todo 继续是 session projection，Cron 继续拥有 scheduler/task records，Always-On 继续拥有
   project run/workspace records，Goal 继续拥有 session durable goal events；adapter 只能调用窄 port 或投影通用状态。
6. **组合与验证**：Definition、Provider、Consumer、Composition、state owner、failure mapping、teardown 必须逐项列出，
   并为至少一个真实 caller 设计 focused contract matrix；没有批准 caller 时只维护设计文档，不创建 registry、空 Port 或运行时包。

`WF-D` 的评审稿已在下列逻辑模块形成实现；它们仍只是 core 边界，不代表迁移现有领域目录：

| 设计模块 | 责任 | 明确不拥有 |
| --- | --- | --- |
| `WorkflowDefinition` | 校验 workflow graph、step 类型、输入输出 schema、版本与静态能力声明 | live run、Session/Gateway 状态、具体 scheduler 或 tool side effect |
| `WorkflowRunHandle` / run state machine | caller-owned run identity、step admission、pause/resume/cancel、single settlement | caller 之外的隐式 owner、第二份 Session durable truth |
| `WorkflowEventStore` adapter | 记录或读取 run/step event，声明 event durable/volatile 级别与 replay cursor | 通用 persistence backend、跨 provider query/retention |
| `WorkflowExecutionAdapter` | 将一个已批准 caller 的 step 映射到其既有 port/provider，并回传 typed result | 复制 Plan/Todo、Cron、Always-On、Goal 的领域 owner |
| `WorkflowControlConsumer` | 暴露最小 start/status/pause/resume/cancel 查询与控制面 | 接管 Gateway routing、AgentTurnInbox 或 UI live state |
| `WorkflowComposition` | 按 application profile 装配 Definition、event adapter、execution adapter、teardown | generic registry、自动发现所有 workflow-like runtime |

设计稿还必须给出一张 caller ownership matrix：每个 caller 的 run owner、step owner、event truth、权限入口、
取消/超时来源、late completion 处理、restart/`unknown` 结算和 dispose 顺序均需可追溯。只有这张矩阵和至少一条
真实 caller 的 contract/state-machine tests 通过评审，才允许进入 Wave 3 的单 caller vertical slice。

`WF-D` 通过后，才可进入 Wave 3 的单 caller adapter vertical slice。该 slice 仍须证明 owner fence、single settlement、
late completion、cancel/timeout、dispose 和恢复语义；通过前不得把多个现有 runtime 的状态合并成通用 Workflow state。

## 执行顺序

### R0：保持已完成基线

状态：已完成，后续切片必须回归。

- `AgentLoop` 只接收 `AgentTurnCapabilities`；宽依赖只能经 `AgentLoop.fromDependencies()` 的 direct
  compatibility adapter 进入。
- 官方 external loop factory 只接收 capability-only input；`__agentLoopFactory` 仅是测试 bypass。
- durable model/tool/context/permission facts 仍由 `AgentSessionRuntimeBundle` 组合的 wrapper 写入 Session。
- Module Protocol 的 `runId` 由 Gateway 产生并透传，sidecar 不创建第二套 execution identity。

验收：Node 22 build、session factory/Gateway factory、native one-shot/continuable subagent、module protocol
以及 current sidecar focused contracts。

### R1：stdio Sidecar Connection Provider（已完成）

已将既有 sidecar binary 和 client 连接为可组合的 local deployment provider，完成 M2 protocol 到 M2
local deployment 的最小闭环。

**Definition**：新增 `StdioAgentLoopSidecarConnection` / factory，仍实现现有
`AgentLoopSidecarConnection`，不改变 `AgentLoop.ts` 或 Module Protocol。

**Provider**：每个 sidecar turn 通过 `child_process.spawn()` 启动
`dist/src/cli/pilotdeck-agent-loop-sidecar.js`；stdin/out 使用 NDJSON；stderr、写失败、非法 JSON、
exit-before-terminal 和超时均映射为 transport error。

**Consumer / Composition**：由 `createAgentLoopSidecarRuntimeFactory({ connect })` 消费。连接 provider
只拥有 child process 与 stream，不拥有 session、router、gateway、tool scheduler 或 persistence。

**已验证**：

1. stdin 在 turn 完成时关闭；child 在 grace timeout 内自行退出，否则才 kill；所有 listeners 和 timer 被释放。
2. stdout 逐行 JSON 解析并保序；空行忽略，malformed JSON 和 write/stdio error 使 active turn 失败。
3. 一个真实 child-process test 使用 `process.execPath + dist` binary，验证 model、tool、context/permission callback
   仍在 host 侧执行，且 Session durable event 只写一次。
4. 在 Node 22 下 `pnpm build` 通过；sidecar-client、sidecar server、module protocol、session factory
   focused suite 通过；默认 `result_unknown` 仍然 fail closed。

### R1.1：修正 parity fixture 的 terminal projection

状态：已完成（2026-09-11 已复核）。

server 对“请求到达前已经过期”的 deadline 返回 execute 的
`ok: false + final: true + outcome: failed` response。StaffDeck 的
`pilotdeck_sidecar_impl.py` 已将该合法 protocol terminal 投影为 trace record；PilotDeck 的
Gateway parity `StdioAgentLoopRunner` 也必须消费该 final response，而不是只等待 stream event。PilotDeck
client 与该 Gateway consumer 都将它投影为一个 failed turn，并保留 `DEADLINE_EXCEEDED` 及 native 一致的
`aborted_streaming` stop reason。
这不把 preflight rejection 伪装成 stream event，也不让 sidecar 持有 host operation state。

2026-09-11 的真实 Gateway/WebSocket 同版本 deterministic matrix 已完成 **38/38**：0 semantic failure、
0 oracle failure、0 `BLOCKED`。它覆盖 deadline、cancel、tool deadline、permission、batch tool、model failure、
media、seed-state、checkpoint resume、continuable/one-shot subagent、parent abort/close 与 late terminal。并发安全工具的
start/finish 是部分顺序，trace 仅在 adapter 显式标记 `concurrencySafe` 且同批 tool 名唯一时按 tool/result order
归并；非并发或重复调用继续严格比较。最终保留 18 条 envelope ordering warning（并发 lifecycle 与 cancel），不改变
模型可见 messages、tool result 顺序、permission、side effect count 或 terminal 的语义结论。

### R1.2：Plan/Todo host-owned parity（已完成）

**Definition**：在既有 `capability` host module 中增加可选 `plan_todo` method；不增加 workflow module，
不修改 `AgentLoop.ts`。method 仅覆盖 `read`、`mark_plan_approved`、`record_todo_write`、`write_todos`
和 `mark_tool_progress`。

**Provider / state owner**：`NativePlanTodoRuntime` 继续通过 `SessionRuntime` projection 持久化 approved plan、
todo history 与 progress。host 只接受与 active execute 相同的 `runId` / `operationId`，并再校验 payload
的 `sessionId` / `turnId`；不匹配的 sidecar call 失败关闭。

**Consumer / composition**：sidecar default factory 仅在 host 广告 `capability.methods` 包含 `plan_todo`
时创建 `HostPlanTodoPort`，先 `read` 初始化缓存；每次 host tool execution 后刷新缓存。该 cache 只提供
AgentLoop 需要的同步 `buildPromptAddendum()` / `blockingMessageFor()` 视图。host ToolRuntime 接收同一
session-bound handle，保持 tool progress、permission 与副作用的原有 owner。

**已验证**：非法 host snapshot 拒绝；approved plan 在 sidecar prompt/gate 中生效；跨 session/turn module
call 被 host 拒绝；正常 model admission 后的 capability tool call 使用 host Plan/Todo handle。没有广告该
method 时不创建远端 Plan/Todo port，也不伪造 generic workflow fallback。

### R1.3：Lifecycle / Hook host-owned parity（已完成）

**Definition**：新增可选 `lifecycle.dispatch` host module。wire payload 只包含 hook `event` 与业务
`payload`；不改变 `AgentLoop.ts`，不把 hook/plugin runtime 添加到 generic execute payload。

**Provider / state owner**：host `LifecycleRuntime` 以 active execute 重建 `sessionId`、`turnId`、cwd、permission
mode、abort signal 和 turn environment，再执行自己的 hook matcher。plugin registry、async-hook completion、resource
lease、process environment 和 teardown 均不跨边界。

**Consumer / composition**：default sidecar factory 仅在 host 广告 `lifecycle.methods: ["dispatch"]` 时创建
`HostLifecycleRuntime`。它校验 response 的 `LifecycleDispatchResult` 基本形状并返回 effects/messages/errors；没有
广告时仍保持原有 null lifecycle 行为。

**已验证**：consumer 仅传 event/payload，不泄漏 `baseInput` 或 env；host dispatch 恢复 active turn identity 和
environment；host response 格式不合法失败关闭。该完成项不声称 remote async-hook response delivery 已具备 consumer。

### R1.4：Capability tool host execution-context parity（已完成）

**问题**：原 sidecar capability dispatch 只重建 session/turn/permission 基础字段。host ToolRuntime 因而无法得到
native path 已有的 durable audit/interaction、file history/notifier、plan directory、turn environment 和辅助 model
routing，部分 builtin tool 会在 sidecar 路径降级。

**完成方式**：host 以 active capability view 重建上述 context services，并始终使用 host config 的 tool aliases、
output limits、env 与 plan storage。sidecar wire context 只保留当前 tool-call fact，不能指定 ambient service。Plan/Todo
继续通过 R1.2 的 host handle 注入并 refresh。

**明确边界**：不把 `readFileState` / `writeSnapshots` 拆成 per-tool cache，不把 full-fork subagent parent state
伪造成 tool payload；两者仍分别由 seed-state/checkpoint 与 R3 的 child owner 约束。

**已验证**：真实 module-call 在 host context 收到 durable audit、elicitation、file services、plan directory、turn
environment 和 secondary model routing；session/turn/cwd 与 remote context 不可覆盖。

### R1.5：Volatile Agent event host bridge（已完成）

**问题**：default sidecar factory 以前没有注入 `eventEmitter`。因此 AgentLoop 中只通过 emitter
发布、而不同时出现在 generator stream 的 live event（例如 `instructions_loaded`）会在 sidecar 路径丢失；
这会破坏 DSH scope/event routing 的 live consumer 语义，但不应把这些事件误写为 Session truth。

**完成方式**：在 `hostModules` 增加可选 `event.methods: ["emit"]`。sidecar 以当前
`runId` / `operationId` 生成单独 module-call identity，把 `{ operation: "emit", event }` 送回 host；
host 校验 event 的 active session/turn 后交给原有 `AgentEventEmitter`。bridge 串行化已受理 event，并在
execute terminal 前 `flush()`。event delivery failure 被隔离，后续 event 仍会尝试投递，且不改变业务 terminal。

**明确边界**：`event.emit` 是 volatile projection，不是 Session event、operation ledger、replay buffer 或
reconnect protocol。它不能补发进程重启前的 event，不能作为 Gateway pending state 或恢复依据；需要 durable
事实时仍由 `SessionRuntime` 先 append 并由 projection 消费。

**已验证**：bridge 在首次 host failure 后仍按顺序投递后续 event；default factory 只在 host 广告时注入 emitter；
loopback sidecar E2E 证明 `instructions_loaded` 在 `turn_completed` 前回到 host。

### R2：跨进程故障语义

开始条件：R1 的真实 stdio E2E 已通过，或 sidecar 进入真实产品流量。

已完成的 server/client contract、Local Gateway deployment selection 与尚未闭环的故障恢复工作必须分开推进，
不能合并成“大而全 transport 重写”：

1. 已完成：进程 supervisor：启动失败、stderr diagnostic、exit code、graceful close 和 crash cleanup。
2. 已完成并通过 R1.1 E2E：`cancel` / deadline。client 仅在 execute accepted response 给出 `streamId` 后发送 cancel；server 对 active
   `(runId, operationId, requestId)` 做 fencing，拒绝 stale cancel 和 duplicate execute，保证已接受 execute
   只有一个 terminal；preflight deadline 返回明确 failed，active deadline 返回 `result_unknown` 交给 host
   reconciliation，已提交的 completed 不被后续 cancel 覆盖。
3. 已完成 local host binding：`SessionAgentLoopOperationLedger` 将 immutable
   identity/binding/sequence、accepted stream、known terminal 和 `result_unknown` 写入现有 session event owner；
   JSONL restore 后只对相同 identity 的 known terminal 返回 reconciliation，未注入、未命中或仍 resolving 时失败关闭。
   `AgentLoopSidecarServer.status(requestId)` 同时返回同连接的 live `ModuleOperationSnapshot`，它不是 durable truth。
   2026-09-10 已补 `createAgentSession` 重建后的正式 factory integration contract：相同
   `runId`、`operationId`、`requestId`、binding 和 `streamId` 的 `result_unknown` 自动从恢复 ledger
   获得既有 terminal，且不会追加第二个 operation terminal event。
4. 已完成 transport seam：`SidecarStreamReplayStore` 在 sidecar 进程内以 event/byte/TTL 上界保留 wire event；
   server 按 `(streamId, previousBinding, lastAppliedSequence)` 执行重新绑定并拒绝 binding mismatch、过期 cursor
   和非法 ack。client 只对显式 `reconnect()` 且协商 `resumeSupport: streaming` 的连接重握手一次，重放与 live
   事件共用 identity/sequence 校验，绝不重送 `execute` 或 `module_call`。`lastAppliedSequence = -1` 仅用于
   sequence 0 尚未被应用的首 event 前恢复，ack 仍为非负 cursor。
5. 待 side effect transport consumer 出现后实施：稳定 idempotency key 和 host-owned status query；transport
   断线不能自动重试非幂等调用。

验收：已覆盖 session JSONL restore、known/unknown terminal、同连接 status、child crash、stdout truncate、
重复/乱序/gap、deadline、cancel race、late terminal；后续 restart/resume 必须保持 host Session/Gateway
没有第二写入者。

#### R2-A：可重连 stream transport（Local Gateway profile 与核心故障 E2E 已完成）

`TcpAgentLoopSidecarConnection` 与 `AgentLoopSidecarTcpServer` 已形成实际 local deployment provider：同一
sidecar instance 经 loopback TCP 接受第二连接，client 的 `reconnect()` 重连、重握手并发送 `resume`。独立运行
`pilotdeck-agent-loop-sidecar` 并设置 `PILOTDECK_AGENT_LOOP_TCP_HOST` / `PILOTDECK_AGENT_LOOP_TCP_PORT` 时会
启动该 listener；`createLocalGateway` 现以 `PILOTDECK_AGENT_LOOP_TRANSPORT=native|stdio|tcp` 选择 provider，
显式 `agentLoopFactory` 保持优先。默认是 native，stdio 运行 bundled per-turn child，tcp 连接既有长生命周期
sidecar。AgentSession E2E 已覆盖 sequence 0 后断线、binding replacement、sequence 1 terminal replay 和单一
durable operation terminal；真实 Local Gateway + TCP sidecar E2E 已确认模型与工具仍由 host 执行。

`StdioAgentLoopSidecarConnection` 仍是“一 turn 一 child process”的单连接 provider：turn 完成或连接中断时 child
被关闭，因此它继续广告 `resumeSupport: none`，默认行为仍是 crash -> `result_unknown`。`InProcessModuleAdapter`
的 history/replay 也仅是协议 reference，不能作为 stdio deployment 已支持恢复的证据。Local Gateway 已选择 TCP
provider；R2-A 已提供被动 `AgentLoopSidecarTransportObserver`：sidecar client 会报告 accepted stream、
reconnect、同实例 pending module-call replay、实例重启与 `result_unknown` 的 resolve/fail-closed 分类，且
observer failure 被隔离。`createAgentLoopDeploymentFactory()` 与 `createLocalGateway()` 都可显式注入该
observer；将这些事实映射到某个产品 analytics schema 仍须由该 schema owner 完成，不能将普通 per-turn
stdio 误标为可恢复。

已完成的 Definition / Provider / Consumer 包括 transport-local bounded replay、binding-aware resume、ack trim、
单次 reconnect、replay/live 串行投递、old connection fencing 和 `result_unknown` 回退。它们的 state owner 仅是仍存活
sidecar process 的 volatile buffer；ack 不能删除 host durable terminal，server stop、TTL、eviction、旧连接迟到 event
和新 run replacement 都保持隔离。指标只记录 replay/expiry/outcome，不把 stream buffer 暴露为 Gateway public state。

2026-09-11 已增加真实 Local Gateway + TCP fault E2E：测试以实际 TCP provider 的连接装饰器在非终态
sequence 0 已被 client 应用后关闭第一条连接。受控 sidecar 先完成 host-owned durable model admission，
只在 client 完成重握手和 `resume` 后才发起一次 host `capability.execute_batch`。测试验证 model admission、
host tool side effect、capability call、Gateway `turn_completed` 和 Session
`agent_loop_operation_terminal` 都严格为一次；该路径不重发 `execute` 或 `module_call`。既有 permission
host-module contract 保持独立覆盖，permission prompt/deny 的断线消费场景仍应随真实交互 consumer 单独增加。

同日也已增加 active deadline 的真实 TCP provider + Session ledger E2E：sidecar 已接受 execute 后 deadline
触发 abort，受控 runner 即使随后返回表面 `success`，server 仍只发送 `result_unknown`。没有匹配的 host
known-terminal resolution 时，client/TurnRunner 失败关闭；Session 只保留 started、accepted 和一个
`agent_loop_operation_terminal(result_unknown, DEADLINE_EXCEEDED)`，没有 synthetic success。这补的是 raw server
deadline test 与 preflight client rejection 之间的实际 transport/ledger 路径，不把 unknown 归一化为 failed 或 completed。

同一故障切片还验证了 late host capability result：active deadline 关闭 sidecar turn 后，迟到的 host tool success
不回灌 `tool_result`，Session 只保留一个 `agent_loop_operation_terminal`。另外，host capability binding 在
`AgentLoop` 未显式传递 `operationId` 时回退到 active execute identity，避免 host module call 因 operation identity
mismatch 被错误拒绝。

当前 TCP deployment 的剩余工作：

1. **产品 telemetry composition（需求触发）**：transport 已有 passive observer Definition/Provider/Composition，
   `createAgentLoopDeploymentFactory()` 与 Local Gateway 都可接收 observer，可报告 reconnect、replayed pending
   module、实例重启和 fallback outcome；实际产品只有在拥有明确 analytics schema 与 consumer 后才将其转换为埋点。
   不把 replay cache 提升为 Gateway public state 或状态查询真源，也不把 prompt、answer、tool arguments、Session data
   或原始 error 放入 observation。
2. **Future providers**：只有 Unix socket、WebSocket 或同等 provider 进入产品需求时，才实现其
   `AgentLoopSidecarConnection.reconnect()`；provider 进程必须跨两条连接存活，stdio factory 保持不可恢复。

已通过的最小验收包括同一进程的 connection replacement（partial replay 后接 live event）、duplicate execute、
stale cancel、wrong binding、ack trimming、TTL/cap eviction、old connection late event 与“不重复 append session event”。

2026-09-12 的全量对拍还发现并修正 active replay cache 的 quiet-period 生命周期：TTL 现在只从 final event 起算，
因此长模型/host tool 或重连后的 active stream 不会在下一条 event 前被驱逐；final 后仍按既有 TTL/cap 保持有界。
该修复有独立 replay-store contract 覆盖，并使 current PilotDeck 38 个 deterministic native/sidecar scenarios
全部通过。它不改变 `result_unknown`、Session ledger 或任何非幂等副作用的 reconciliation owner。
目标 long-lived transport 仍需产品侧非幂等 status-query provider。现有 per-turn stdio E2E 继续覆盖
crash -> `result_unknown`，但不冒充 resumable deployment。

#### R2-B：sidecar process restart -> host reconciliation（transport consumer 已完成）

**问题归因**：旧实现的 default `moduleInstanceId` 在每个 process 中相同；TCP reconnect 因而无法区分“同一
实例的第二条连接”和“sidecar 已重启”。即使 handshake 发现不同 instance，client 也只写一个
`result_unknown` 并抛错，不会调用 host reconciliation；外部 status query 得到 known terminal 后也不会回写
session ledger。

**Definition / Provider**：`AgentLoopSidecarServer` 为未显式配置的实例生成 process-unique
`moduleInstanceId`，每条连接继续使用独立 `connectionGeneration`。`SessionAgentLoopOperationLedger` 是
durable provider；`reconcileResultUnknown` 是可选的 host reconciliation contract，只接收已接受 operation 的
immutable identity、old binding、stream 和最后已应用 sequence。它允许产品侧 status-query / side-effect owner
以后接入，但自身不提供通用状态查询。

**Consumer / Composition**：`AgentLoopSidecarRunner` 只对同一 `moduleInstanceId` 发出 `resume`。replacement
handshake 发现新 instance 时不重发 `execute`、`module_call` 或 tool side effect，而是 append
`agent_loop_operation_terminal(result_unknown, SIDECAR_INSTANCE_RESTARTED)`，依次查询 session ledger 和 host
reconciler。查到 known terminal 后写入同一 Session ledger 并投影一次 `turn_completed`；查不到则保留
`result_unknown` 并 fail closed。

**验证结果**：server identity contract、mocked connection contract 和真实 TCP listener restart E2E 均已通过。
真实 E2E 关闭旧 listener、以新 instance id 在同一 port 重启，再证明 execute 只有一次、没有 resume、注入的
host test reconciler 只调用一次，ledger terminal 从 `result_unknown` 收敛到 `completed`。这证明 transport handoff
与 settlement，不代表已有产品侧非幂等副作用 status-query。同套 focused build/test 为 38/38。

**明确边界**：这完成了 transport 的 restart consumer 和 durable settlement，不为所有工具虚构 status API。
非幂等 tool 的实际状态查询、idempotency key 与 provider 是各产品 side-effect owner 的后续工作；没有该 provider
时仍保持 unknown，不自动 retry。

#### R2-C：pending host module-call reconnect（已完成）

**已核对的事实**：Gateway interaction 的 owner 已经在 host 侧闭合。
`InteractionReconnect` 以 `(connectionId, generation)` fence pending permission/question；
`GatewayPermissionBus` 与 `GatewayElicitationBus` 保存 pending promise，旧 binding 的 answer 被拒绝，新的
binding 才能 consume。这个 state 是 Gateway live state，不属于 sidecar，也不需要落入 Session durable log。

**问题归因（已修复）**：旧 TCP transport 只重放 `ModuleEvent`。当 sidecar 发出
`module_call(permission|context|capability)` 后，host 正在等待 interaction，socket 在此时断开，用户在 replacement
Gateway binding 上完成 answer，client 对旧 socket 发送 host `ModuleResponse` 会失败。旧实现转入外层 transport
error / `result_unknown`，server 也不会在 `resume` 后重发仍未 settlement 的 `module_call`。因此该 answer 无法回到
同一存活 sidecar，且不应靠重新执行 permission 或 tool 修复。

**Definition**：将“pending module request 的 volatile 重投递”和“已完成 host module response 的 per-turn
delivery cache”定义为 TCP resume 的一部分。key 是 sidecar `module_call.messageId` 加不可变
`runId` / `operationId` / `requestId` / module / payload identity；它不是 execute idempotency key，不进入
Session、Gateway 或 replay-store durable state。

**Provider / owner**：

1. `AgentLoopSidecarServer` 的 `PendingModuleCall` 保留 immutable `ModuleCallRequest`。同一 process 的
   `resume()` 在成功 rebind 后，按 stream delivery chain 发送 resume response、现有 event replay 和仍 pending 的
   module request。response 到达后只 resolve 一次并删除 pending entry。server restart 不保留这个表，继续走 R2-B。
2. `AgentLoopSidecarRunner` 在第一次 host dispatch 成功或失败后、发送前缓存完整 `ModuleResponse`；发送失败时
   发起现有的一次 reconnect -> handshake -> resume。server 重投递同一 request 时，client 先验证 immutable identity，
   再发送缓存结果，绝不再次调用 model、permission、context、lifecycle、event 或 capability provider。
3. `GatewayInteractionCoordinator`、permission/elicitation bus 和 UI/channel 仍只管理 interaction binding、pending
   prompt 与 answer。transport 不解释 allow/deny/question payload，也不保存 UI replay state。

**failure mapping**：同一 `moduleInstanceId` 的一次 reconnect 成功时，host response 只交付给原 pending call；
不重发 `execute`，不重新开始 interaction，不重复工具副作用。若 reconnect、handshake 或 resume 失败，才进入既有
R2-B fail-closed `result_unknown` reconciliation。若 handshake 发现新的 `moduleInstanceId`，不得 replay pending
request，直接使用 R2-B 的 restart mapping。turn terminal、Session operation terminal 与 Gateway terminal 都只能有一个。

**已完成实现**：

1. server 已补 pending-call replay，client 已补 delivery cache；cache 冲突、identity 不一致、second reconnect 和
   terminal/close 后访问仍 fail closed。
2. client 的 cached module response 写失败时复用既有 TCP reconnect / resume，而没有另起 interaction transport
   state machine。
3. 真实 TCP + Gateway 测试已覆盖 permission 和 elicitation/question；两者都证明 old binding 拒绝、new binding
   接受、host provider 只调用一次、module response 只交付一次、最终 terminal 只记录一次。
4. transport observer 已覆盖 reconnect/replayed-pending-module/instance-restart/fallback outcome，且不暴露
   prompt、answer、tool arguments、Session data、replay cache 内容或原始 error。实际 deployment analytics 仍由
   产品 telemetry schema owner 单独组合，不在 Module Protocol 或 Gateway 中新建状态查询接口。

**验证结果**：`tcp-sidecar-transport.spec.ts` 已覆盖真实 TCP provider：permission pending 或真实
model -> capability tool -> `GatewayElicitationBus` question pending 后强制关闭 socket。Gateway replacement binding
的旧 answer 被拒绝、新 binding 的 answer 被接受；server 只重发同一 immutable `module_call`，client 重发缓存
response，permission provider / capability tool 都只执行一次。`sidecar.spec.ts` 还验证 rebind 后旧连接的迟到
host response 被 fence，只有新 binding 的 response 能结算原 pending call。

focused build/test 共 53/53 通过，且同时保持：

1. permission/question provider invocation = 1；
2. stale binding answer 不可消费，current binding answer 可消费；
3. `execute` = 1、每个 module response = 1、Gateway/Session terminal = 1；
4. process restart、reconnect failure 与 identity conflict 仍为 `result_unknown` 或明确失败，绝不自动 replay side effect。

#### R2-D：产品侧非幂等副作用 status query（P1，需求触发）

R2-B 已提供 transport consumer，但没有产品 provider 就不能宣称任意 tool 可跨 sidecar restart 恢复。只有某个实际
side-effect owner 同时提供稳定 idempotency key、状态查询、known/unknown settlement 和 audit 时，才将它接到
`reconcileResultUnknown`。该工作包不阻塞 R2-C；R2-C 只处理同一进程、同一 pending host reply 的交付，不恢复
已丢失的 sidecar process。

### R3：远程/sidecar subagent parity（one-shot host callback 与 stdio/TCP parent-abort 已完成）

sidecar 的 `agent` tool 已有真实 consumer，因此只完成最小的 one-shot host callback，而不预建 remote registry。
sidecar 仍只通过既有 `capability.execute` 请求工具执行；它没有 child Session、child inbox、provider registry
或 sidechain writer。host 在 capability dispatch 时以 active `sessionId` / `turnId` 与该 turn checkpoint 重建
`OneShotSubagentPort` 的 fork API，host ToolRuntime 再执行 native provider、child composition、sidechain
transcript、lifecycle 与 live event。permission dispatch 不构造 fork API，避免把 delegation runtime 暴露给
policy mapping。

**已验证**：loopback 与 Local Gateway + TCP sidecar E2E 中，`agent` capability 返回 host full-fork result，
host fork 收到当前 session/turn 和 checkpoint read-file state；部署 E2E 经过外层 sidecar、host child、外层
tool-result 后三次模型调用，sidecar model/tool 循环继续由 host port 执行。该路径没有新增 Module Protocol method，
也没有修改 `AgentLoop.ts`。

2026-09-11 已增加 Local Gateway + TCP sidecar 的 parent-abort E2E：外层模型发出 `agent` tool call 后，
测试等待 host-owned child 的模型调用开始，再由 `Gateway.abortTurn()` 终止父 turn。child 收到相同取消信号，
sidecar 不重复 capability call；Gateway 只投影一个 `turn_completed`，Session 只追加一个
`agent_loop_operation_terminal(cancelled)`，且没有误发 child 成功后的 `tool_call_finished`。测试的 request-side
capture 故意在等待 module response 前记录 capability call，因为 server cancel 会撤销尚未完成的 host module reply；
这正是该故障路径不应被“response 成功返回”掩盖的行为。

同日也已增加实际 bundled stdio child-process provider 的相同 E2E。stdio 每 turn 启动的 sidecar 在 child
已开始后收到 Gateway parent abort，host child 收到一次 abort，Gateway 只投影一个 terminal，Session 只追加一个
`agent_loop_operation_terminal(cancelled)`，且没有错误地投影 child 成功的 tool completion。它不宣称 stdio
具有 reconnect/replay 能力，只证明已接受 execute 的 cancel 保持 native child ownership。

2026-09-11 已补 bundled stdio child-process 的 active deadline/late host result E2E：host tool 在 child sidecar
deadline 后才返回 success 时，Session 只保留一个 `result_unknown(DEADLINE_EXCEEDED)` terminal，迟到 tool result
不会重入已经关闭的 turn。该行为与 TCP transport contract 一致，但不赋予 stdio reconnect/replay 能力。

同日也已完成 one-shot sidechain reference：`OneShotSubagentPort` 将 host-created `subagentSessionId` 与可选
`transcriptRelativePath` 返回 `agent` tool；tool result 的 data/metadata 透传同一只读 reference，sidecar capability
host callback 不再丢失它。child transcript、child Session、FIFO inbox 与 persistence 仍只由 host owner 持有。

**余项**：continuable FIFO、cold resume、provider replacement 与 exact resource release 仍由 native owner 管理；
remote/queued provider 需要独立的 run owner 和 recovery contract，不能把 child inbox 复制进 sidecar。

#### R3.1：one-shot 父 deadline budget 继承（P0，已完成）

**问题归因**：`AgentLoop` 已在调用 `ToolPort.executeAll()` 时传入
`AgentExecutionContext.operationDeadline`，host capability wire 也会序列化该字段；但 native
`createToolSchedulerPort()` 丢弃 execution context，只把原始 `PilotDeckToolRuntimeContext` 交给
`ToolScheduler`。`agent` builtin 随后只读取 `context.subagentTimeoutMs` 或 60 分钟默认值，尽管
`OneShotSubagentPort` 已能把 parent abort signal 与 timeout 合成为 child abort signal。因此，父 turn 的
deadline 不能系统性收紧 one-shot child budget；这和 R2 已完成的 sidecar transport active-deadline 不是同一个
问题。

**交付**：已在 `src/agent/modules/capability/executionDeadline.ts` 增加纯 deadline-budget helper，并将
one-shot 的 60 分钟默认值收敛到 `src/tool/protocol/subagentTimeout.ts`。helper 输入为
`PilotDeckToolRuntimeContext`、`AgentExecutionContext` 与 context clock；输出仅是工具 runtime context 的
不可变派生值。有效 `operationDeadline` 的 child budget 为现有 `subagentTimeoutMs`（或默认 child budget）和
剩余 operation time 的较小者；过期 deadline 传递 `0`。没有 deadline 或无法解析的 deadline 保持现有语义，
与 transport 的 `earliestDeadline()` 对非法字符串的处理一致。

**Provider / Consumer / Composition**：`toolSchedulerAdapter.ts` 的 native `ToolPort` provider 已在调用 scheduler
前应用该 helper。这样 direct AgentLoop
和 sidecar host capability dispatch 都经同一 host ToolRuntime 获得相同 budget；`OneShotSubagentPort` 继续是
timeout/parent-abort 的唯一执行 consumer。不得向 Module Protocol 增加字段，不得修改 `AgentLoop.ts`、permission
owner、scheduler owner 或 session owner。

`InProcessGateway` 也已将有效的 public `GatewaySubmitTurnInput.timeoutMs` 在 session admission 后单次换算为
绝对 `operationDeadline`，并随既有 `(runId, operationId)` 放入 `AgentSubmitOptions.execution`。Gateway 仍拥有
wall-clock timer、visible timeout event 与 abort；它只把可序列化 budget 投影给 AgentLoop/sidecar，不接管 tool 或
child owner。

**failure mapping**：child 因收紧后的 budget 到期仍是 tool/subagent failure，不得伪装为 parent cancellation；
parent `AbortSignal` 已触发时仍保留 cancellation 语义。迟到 child success 不能覆盖已经记录的 failure 或 transport
terminal。该工作包不宣称 sidecar process restart 可恢复 child side effect。

**验证结果**：

1. adapter contract 覆盖 deadline 收紧、配置 timeout 更短、无 deadline、非法 deadline 和已过期 deadline，使用
   `context.now` 保持确定性；
2. one-shot regression 证明 parent deadline 触发的是 timeout failure 而不是 parent cancellation，并保留现有
   explicit parent-abort 行为；
3. host capability context-reconstruction regression 证明 execution deadline 到达 host scheduler，且无第二
   `tool_result` / operation terminal；
4. Gateway contract regression 证明有效 `timeoutMs` 产生稳定绝对 deadline，非法 timeout 保持既有无 deadline 语义；
5. Local Gateway + TCP sidecar E2E 已确认 Gateway deadline 到达实际 sidecar execute request；Node 22 build、
   capability-tool-port、OneShotSubagentPort、SubAgentSession、TCP sidecar transport、Local Gateway deployment
   与 Gateway timeout focused suites 共 59/59 通过。

### R4：模型栈可插拔解耦

R4 首段已完成 AgentLoop consumer seam：显式 `ModelExecutionPort`、可选 metadata/budget/auxiliary port 与 Router
facade 兼容适配。直接构造 capabilities 时，AgentLoop 可以在没有 Router 的情况下由独立 execution provider 完成
`prepare/stream`；`AgentRuntimeDependencies`、session scope 和 Local Gateway 的 native/session composition 目前仍把
Router 作为 legacy 必填/默认资源，这两个层次不能混为一谈。

| 阶段 | Definition / Provider | Consumer / Composition | 退出条件 |
| --- | --- | --- | --- |
| R4-A execution/routing seam（已完成） | `ModelExecutionPort`、`AgentTurnRoutingPort`、`ModelMetadataPort`、prepared invocation snapshot；legacy Router adapter | `createAgentTurnCapabilities()` 冻结 ports，AgentLoop 只消费 execution；Router 为可选 facade。sidecar 以可选 `model.get_metadata` 传递 turn-local limits/protocol/cache snapshot | 直接 capabilities composition 可无 Router；legacy provider selection、retry、compaction 与 parity 不变；metadata 缺失保持 conservative fallback |
| R4-B external provider adapter contract（按需） | 第三方 provider adapter；canonical request/event、usage/error/abort/deadline mapping | provider client 只依赖 adapter；core 不 import SDK | adapter 不暴露 registry/session/lifecycle，不把 provider state 放入 wire 或 durable event |

职责矩阵保持稳定：execution provider 做单次模型调用，routing provider 做 selection/materialization/sticky policy，metadata
provider 做 limits/protocol/cache capability，budget provider 做 token accounting，auxiliary provider 做二次模型调用；retry
仍在 AgentLoop step boundary，token meter 是独立 consumer，bundle/profile 负责 generation、lease、rollback 和 dispose。
Session 与 Gateway 不成为 model policy owner；第三方 provider adapter 仍是可选 integration，不改变核心 AgentLoop。

兼容字段退出条件：新生产代码不得新增 deprecated optional capability bag、旧 `model.invoker`/`model.routing`/
`model.tokenAccounting` 或 aggregate snapshot 的读取；这些字段只能留在 composition/adapter 兼容层。删除前必须通过
native、sidecar、session、subagent、Gateway 及模型 override/compact/retry 回归，并确认所有 consumer 已切换到窄 port。

### R4.1：sidecar transport consumer view（已完成）

sidecar protocol、connection factory 与 module handler factory 已从 `AgentTurnCapabilities` aggregate 切换到
`SidecarModuleComposition`。connection provider 仅接收 `SidecarTransportTurn + seedState + SidecarTransportContext`；
module handler factory 按 model/capability/permission/context/lifecycle/event 分别接收单一 port 和裁剪后的 turn view。
Plan/Todo 已是独立可选 module，继续通过既有 `capability.plan_todo` wire operation 路由。capability、permission、context
分别只取得自己的 turn-bound context service，不互相读取 execution/provider 对象。默认领域 dispatcher 在 runner 的 host
composition 创建并生成冻结 manifest/handler registry；protocol 仅接收这些冻结事实以及 checkpoint，负责 module lookup、identity、
replay 与 terminal settlement。`AgentTurnCapabilities.transport` 只保留 native compatibility fallback，新的
session -> sidecar runtime 路径优先传递显式 `sidecarModules` 与 transport context。

`sidecarTurnComposition` 继续是 PermissionMode、Plan/Todo handler、result observer 与可替换 handler registry 的唯一
turn composition owner。Module Protocol v2、replay/resume、host checkpoint、Plan/Todo durable owner 和 terminal semantics
均未改变。验收为 Node 22 build、sidecar client/turn-composition focused suites 通过，以及 Gateway parity 不产生新的
semantic difference 或 cleanup BLOCKED。
`PreparedModelInvocation.opaque` 最后再删，且需证明 legacy Router adapter 不再需要跨 generation 的 request snapshot。

### R4.2：sidecar budget、turn callback 与生产验证闭环（已完成）

#### 2026-09-19 严格 merge closure 复核

固定 current `9ec5a957`、`origin/main` `cd52c9af812a84c27a9dd1b7ccf246f48540045f` 与架构基线 `e55b0a82d07ee3951e5812c34103400dfa6043f7` 后，production stdio Gateway 矩阵 53/53 全部执行，`failed=[]`、`blocked=[]`、`oracleFailures=[]`、`knownGaps=[]`；34 个 baseline applicable，19 个 `notApplicable`。严格 comparator 新增 budget breakdown 完整性约束和负向对照，不扩大 normalization；结果见 `/tmp/pilotdeck-parity-closure-20260920-accepted/summary.json`。

验收命令证据：Node 22 `pnpm build` PASS，`pnpm test` `1721/1723`（2 skipped）PASS，SDK `123/123`，focused module/Gateway/SDK seed `135/135`，comparator `53/53`，production budget evidence `2/2`。受独立验收影响的两个 resume、两个 nested continuable 入口和 durable compaction raw traces 已按共有 `TokenBudgetManager`/o200k request contract 重采集；无法唯一关联的 nested/synthetic budget 不生成 evidence，main 不适用项保持明确列出。真实 provider、StaffDeck Harness/TaskFrame/SOP lease、remote/queued deployment 与 Desktop/Web 视觉检查仍不在本 PilotDeck-only 矩阵内，不计为 PASS。

| 边界 | Definition | Provider / durable owner | Consumer | Composition |
| --- | --- | --- | --- | --- |
| Budget | 可选 `budget.estimate_request_input`、`evaluate_request_budget`、`estimate_usage_cost` | session 已解析的 `ModelBudgetPort`；provider/model、abort 与 token policy 留在 host | sidecar AgentLoop 的异步 `ModelBudgetPort` | host dispatcher 按 active turn 重建 canonical request context；不传 Router/estimator 对象 |
| Live steer | 可选 `turn.drain_steer`、`drain_or_close_steer` | `AgentTurnInbox`/host mailbox；Session transcript 持有 accepted message 与 `steer_applied` truth | sidecar `AgentLoopInput` callback | 每 execute 绑定 run/operation；sidecar 无 mailbox、claim 或 ack state |
| Compaction commit | 可选 `turn.persist_compaction` | `TurnRunner.onCompactPersisted` 与 Session writer 持有 replacement/boundary | sidecar compaction continuation | callback 完成前不发后续 model request；failure 中止，reconnect 不重复 commit |
| Full-request compaction budget | `budgetRequest` + 显式 `budgetStage` | host `ModelBudgetPort` 与 active turn abort/context limit | sidecar context compaction | candidate messages 替换进 canonical template；malformed/identity mismatch/负数结果 fail closed；缺 budget capability 才 message-only fallback |
| Incremental model stream | 可选 `model.stream_next`、`close_stream`；deprecated `stream` fallback | host model provider iterator | sidecar `ModelExecutionPort` | 每个 preparation 单 iterator；reconnect cache 不重复推进；abort/close/turn dispose 释放 iterator |
| Seed read state | 共享 `seedAgentReadState` helper | host runner 的 read/write seed snapshot | Gateway `seed_read_state` 与下一 turn seed projection | native/sidecar 共用 path/type/mtime 校验；active turn 仍 `SESSION_BUSY`；sidecar 不新增 durable owner |
| Elicitation availability | `interactionCapabilities.elicitationAvailable` boolean | host interaction/channel composition；pending answer 与 durable result 留在 host | tool exposure filter | manifest 只投影 availability，不传 channel 对象 |
| Status persistence | awaited transcript callback before `agent_status` publication/ack | Session transcript writer | Gateway replay/status consumer | callback failure 不能产出成功 terminal 或假 ack |

本轮 merge closure 为 compaction durable boundary 增加了 Session/EventStore-owned 的 versioned `snapshot`（v1）：完整
snapshot 在 enclosing turn terminal 中断时仍可 replay，损坏 snapshot 则保留既有历史并给出诊断，legacy
`replacementMessages` 继续只读兼容。JSONL writer 只在该 durable boundary 后 flush，并在下一次 append 前修复部分尾行。
它不进入 sidecar protocol、不改变 Module Protocol v2、Router 策略或 permission owner；`TurnRunner` 在没有原子 replacement
writer 时失败关闭。对应 crash/replay/fork/deferred-failure 回归为 21/21，证据见
`docs/testing/sdk-core-merge-regression-20260918.zh.md`。

生产 parity adapter 已删除自实现 `StdioAgentLoopRunner` 与 `__testAgentLoopFactory` 注入。Gateway sidecar 只通过
`PILOTDECK_AGENT_LOOP_TRANSPORT=stdio` 选择正式 deployment profile；oracle 强制检查 transport selection、正式
handshake/binding 与场景要求的 module calls，缺失即 `BLOCKED`。旧 harness 即使 comparator PASS，也因没有证明
production factory 而被本基线取代。确定性 mock model/tool 仍经正式 host dispatcher 调用，因此不是完整外部服务 E2E。

历史证据（2026-09-16）：Node `22.23.1` 下 `pnpm build` 通过；protocol/ports/sidecar/Gateway focused suites
**109/109**，SDK package tests **123/123**，harness contract/negative-control **18/18**。当时正式 Gateway stdio factory
matrix 为 **45/45**。七个新增场景均有 transport
selection、handshake/binding 与预期 module + operation 原始 trace；full-request budget、host-owned seed state 和
first-delta-before-provider-completion 也有专项 oracle。

历史的分阶段 45/49 数字不再作为当前验收基线。当前证据（2026-09-18）是正式 Gateway stdio factory matrix
完整执行 53 个场景：52 个 strict shared，`deadline` 有 2 条精确 transport settlement difference；exact contract 后
`failed=0`、`blocked=0`、`oracleFailures=0`。每场都保留 production-path proof。与 `origin/main` 对拍时 34 个场景适用、
19 个 `notApplicable`；current 的 durable timeout status、durable steer 和 `auto_compact` 只按精确 baseline extension
验收。runtime context 与 skill 内容仍参与 canonical comparison，不以整体删除隐藏差异。`plan_mode_host_policy` 与 `plan_mode_bypass_host_policy` 均不传下一轮 legacy `mode`，分别验证
`default -> plan -> plan -> default` 与 `bypassPermissions -> plan -> plan -> bypassPermissions`、plan 中 `plan_mode_violation` 与退出后唯一副作用；projected request budget
继续通过 host context/budget 的生产 module path。上述结果证明当前 seam 的行为兼容，不代表第三方
或远程 provider 已成为产品默认，也不代表真实外部服务 deployment E2E 或 Local Gateway 已完全移除 Router。

metadata/configuration 收口后，default-factory、model-port、sidecar-client 与 harness contract 继续覆盖 `model.get_metadata` 的
初始 snapshot、显式空 SDK system prompt 与 additional working directories。它们不是额外的 Gateway scenario；路由后 snapshot
刷新和 malformed/identity fail-closed 由 host dispatcher/default-factory contract 覆盖。当前确定性 Gateway fixture 不宣称提供
第二 routing provider 的产品 E2E。

### R5：按产品需求独立立项

Terminal、job/workflow、跨平台 sandbox、attachment retention/query 和第二 persistence backend 不阻塞 R1-R4。
每项先确认 caller、可见性、durable truth、run owner、cancel/timeout、settlement、dispose、restart 与
unknown-result recovery；没有这些事实，不创建“DSH 对称模块”。

### R5-C：One-shot subagent sidechain storage selection（已完成）

**目标与边界**：使 one-shot child 的 durable write/read 使用 parent 已选择的
`ProjectSessionStorageProvider`，而不改变 parent `SessionRuntime` 的 owner、continuable child inbox、
Gateway live state 或 `AgentLoop`。该包是现有 child-storage capability 的 one-shot composition 补齐，
不是把 file-aware fork/replace、catalog/search 或 retention 收敛为一个 storage facade。

**Definition / Provider / Consumer / Composition**：

1. 在 `ProjectSessionStorage` 定义由 parent storage 派生 one-shot child storage 的精确 factory。它以
   `subagentSessionId` 作为 provider 的 durable identity，并传入 parent identity；filesystem path derivation
   可接受只供 native layout 使用的 `sidechainId`，从而保留
   `<parent-session>/subagents/<subagentId>.jsonl`。`sessionId` 不能为了路径兼容而改为 `subagentId`。
2. `SessionSubagentTranscriptBundle` 消费 parent `AgentProjectSessionStorage`，而非其
   `JsonlTranscriptWriter`。resolver 返回 child storage-backed writer、legacy relative path 和明确的
   child-storage disposer；它不自行拥有 parent lifecycle，也不直接选择 backend。disposer 本身幂等，完成后
   从 resolver cache 删除。
3. `OneShotSubagentPort` 是 child storage 的唯一 teardown owner：`SubAgentSession` 只完成 child turn
   runtime，随后 port 在 success、provider error、timeout 与 parent abort 路径各精确调用一次
   child disposer。parent
   `subagent_completed` 只有在 child durable write/cleanup 已完成后才可继续。不得让 `AgentLoop` 管理
   child persistence 或在 loop 内创建 storage。
4. `readSubagentWebMessages()` 先经 `readAgentProjectSessionPersistence()` 读取 parent reference，再在
   `subagentSessionId` 存在时调用 `readSubagentProjectSessionPersistence()` 读取 child。
   `GatewaySessionHistoryBundle` 必须透传 `storageProvider`。只有 legacy records 缺少 child identity、
   background task path 或 native JSONL compatibility 场景保留现有受限相对路径 fallback。

**状态和 failure mapping**：parent 与 child 仍是独立 durable event stream，各自有顺序、checkpoint 与
dispose；child storage 不可被 parent transcript writer 的 sequence 代替。provider create/read/flush/dispose
失败必须使 one-shot tool run 失败关闭，不能悄悄回退到 JSONL 并造成双写。Web provider read 失败应报告读取失败，
不得用不存在的 file path 伪装为空历史；仅已明确的 legacy JSONL record 才允许 path fallback。多个 cleanup
错误可聚合，但不能阻塞 scope、parent session 或其他 child 的释放。

**完成证据（2026-09-11）**：

1. in-memory `ProjectSessionStorageProvider` 下，parent 与 one-shot child 均不生成 JSONL，provider 收到
   `kind: "subagent"`、精确 parent id 与 logical child session id；child entries 可恢复，child storage 只释放一次。
2. Web subagent history 在同一 in-memory provider 下可由 parent reference 读取并渲染 child durable messages；
   `GatewaySessionHistoryBundle` contract 证明 provider 被透传。
3. Node JSONL provider 保持既有 sidechain 相对路径和文件位置，legacy `transcriptRelativePath`、background
   task 与缺少 `subagentSessionId` 的历史回归通过。
4. `OneShotSubagentPort` focused tests 覆盖 success、provider error、timeout、parent abort 的 child
   dispose 精确一次，以及 success parent completion 晚于 child dispose。`SubAgentSession` 覆盖 caller-owned
   sidechain 不被 native child runner 重复 dispose。
5. 本次执行 `pnpm exec tsc --noEmit --pretty false`、五个 focused suites（34/34）和 `git diff --check`
   均通过。之前已经完成的 storage provider、Web history 和 Gateway provider forwarding contract 仍在该
   focused run 中回归。

**明确不做**：不实现第二通用 persistence backend，不修改 `AgentLoop.ts`，不为 Web fork/replace 建 write
port，不为远程/queued child 预建 provider，也不改变 `subagent_started` 的兼容字段。

### R5-D：Provider-selected session catalog（已完成）

**Definition / Provider / Consumer / Composition**：既有 `SessionCatalogPort` 保持只读 Definition；
`ProjectSessionStorageProvider.catalog?` 是 provider-owned project enumeration capability，native JSONL provider
贡献 `listProjectSessions`。`createProjectSessionCatalog()` 是唯一默认选择点。Gateway session list、Web metadata
lookup、Always-On catalog consumer 分别通过 `createGateway`、`createLocalGateway`、`ProjectRuntimeRegistry` 与
`ProjectAutomationBundle` 获取该选择；显式 `sessionCatalog` injection 用于测试或上层 application override。

**state / failure**：catalog 不拥有 Session durable event、projection、live router state 或 retention policy。
catalog list error 由其 consumer 传播；selected non-native provider 没有 catalog 时抛出
`ProjectSessionCatalogUnavailableError`，禁止 JSONL fallback。单 session history 是另一条 exact-persistence
read path，允许在 catalog 不可用时读取 durable entries 并推导 metadata。

**完成证据（2026-09-11）**：in-memory provider contract 覆盖 provider catalog identity、list input 和无 catalog
时 fail-closed；Gateway/local Gateway contract 覆盖 application composition；Web consumer contract 覆盖 exact history
不降级为 JSONL；`ProjectAutomationBundle` contract 覆盖 Always-On 获得 provider-owned catalog 与 selected
transcript reader。TypeScript 及 focused suite 均已通过。

**明确不做**：不定义跨 backend search/retention API，不把 selected
catalog 当作 persistence write owner。

### R5-E：Provider-selected Web fork（已完成）

**Definition / Provider / Consumer / Composition**：`ProjectSessionForkPort` 是精确的 durable fork transaction
Definition。它接收 application 已按 fork point 过滤、已换为 target session identity 的 entry plan；selected provider
拥有 target stream 的写入、其自身 auxiliary artifacts 的转移、publication 和 cleanup。Node JSONL provider 将原有
tool-results、file-history、subagents copy 和 reference retarget 收入 provider，并先写 temporary transcript，最后
publish target transcript。Web `forkWebSession()` 只读取 selected persistence、计算 prefill/title/metadata 并调用 port；
`GatewaySessionHistoryBundle` 只透传 application-selected `storageProvider`。

**state / failure**：source `SessionRuntime` 仍是唯一 durable truth owner；fork 既不构造 live session、也不接管
Gateway state。target id 或 auxiliary copy 失败时 Node provider 删除未发布 temporary output 与刚创建的 target artifact
directory；未声明 fork 的 non-native provider 抛 `ProjectSessionForkUnavailableError`，绝不读取或写入 JSONL。该 port
不含 `replaceLastTurn`，因为后者还有 prepared journal、owner lease、commit/rollback 和 crash recovery owner。

**完成证据（2026-09-11）**：in-memory provider test 证明 source read 与 target write 均不创建 JSONL，target replay
得到保留 conversation 和 fork metadata；无 fork provider 的 test 证明 fail-closed。native projection regression 保持
forked conversation 重建，Gateway history bundle contract 证明 storage provider 到 fork consumer 的 composition。

**明确不做**：不将 replace transaction、跨 backend search/retention、通用 mutation registry 或 AgentLoop state
合入本 capability。

### R5-F：Provider-selected Web replace（已完成）

**Definition / Provider / Consumer / Composition**：`ProjectSessionReplacementPort` 明确定义 prepared rewrite：
application 提供 original/replacement durable entry streams、transaction id、replacement turn、owner 与 prepared time；
selected backend 负责 backup、rewrite、commit/rollback 和 recovery。native JSONL 通过
`NodeProjectSessionReplacementPort` 提供原有 file journal，避免改变已有 artifact format；non-native provider
只有同时广告 `prepare`、`finalize` 与同步 `recover` 时才被选择。Web
`replaceLastWebSessionTurn()` 只从 selected persistence 读取、验证 latest accepted input 并生成 metadata-aware rewrite
plan；`GatewaySessionHistoryBundle` 透传 provider，`createLocalGateway` 在发布 Gateway 前调用 selected provider 的
recovery。

**state / failure**：`GatewayTurnReplacementCoordinator` 继续是唯一 live reservation、submit claim 与 timeout owner，
不进入 provider；provider 不能创建 Session/Router/Gateway pending state。native journal 的 owner lease 和 startup
recovery 语义保持不变。custom provider recovery 需要同步完成，因为当前 local Gateway boot 是同步 publication boundary；
recovery 抛错会阻止 boot。non-native provider 未声明 replacement port 时 Web edit 抛
`ProjectSessionReplacementUnavailableError`，绝不读写 JSONL。

**完成证据（2026-09-11）**：in-memory provider contract 覆盖 prepare 后 target stream、rollback 原 stream、
replacement accepted-input 后 recovery commit、无 provider fail-closed，以及 Local Gateway 在 publication 前执行
provider recovery。native Web/Gateway replacement suite 保持 journal、live-owner skip、rollback、recovery 和 accepted-input
ordering 语义。

**明确不做**：不把 fork target publication、catalog/search/retention、或 Gateway live timeout state 合并进 replacement
port；异步 remote storage recovery 需要将 local boot publication 改为显式 async lifecycle 后另行设计。

### R5-A：Background task durable-state recovery（已完成 native M3）

**完成依据**：`task_create`、`task_list`、`task_output`、`task_wait`、`task_stop` 已是正式 builtin tool
consumer；`ProjectExecutionWorldBundle` 是唯一 project-lifetime composition owner。与尚无第二 consumer 的
remote subagent、model policy 或 generic workflow 不同，task restart 语义已有明确产品入口。

**现状与不变量**：`BackgroundTaskRuntime` 的 `entries`、`DetachedShellHandle`、`done` promise 与 completion
bus 是 live-only；`TaskOutputStore` 的可选 disk spill 只保存字节，不能恢复 task metadata/status。进程重启后
不得根据旧 `pid` 发送信号、不得重放 completion event、不得把未终态 task 显示为 `running`、`completed` 或
`failed`。`ProjectRuntimeRegistry` / `ProjectRuntimeResourcesBundle` 仍拥有 generation stage/publish/retire，
Gateway 只消费 live completion projection，不能成为 task durable truth。

**已交付的 Definition / Provider / Consumer / Composition**：

1. `src/task/storage/BackgroundTaskSnapshotStore.ts` 定义 project-scoped snapshot；Node JSON provider
   使用原子替换，只保存 JSON task metadata 与 output watermark，不保存 child handle、promise 或 Gateway state。
2. `ProjectRuntimeResourcesBundle` -> `ProjectExecutionWorldBundle` -> `ExecutionWorldBundle` 将 provider
   注入 `<projectRoot>/.pilotdeck/background-tasks/`；direct execution-world 仍保持无 project root 时的内存兼容。
3. `BackgroundTaskRuntime` 在 admission、spawn acceptance、output watermark 与 terminal settlement 按序持久化；
   terminal 只有在 output flush 与 snapshot 成功后才通知 live completion。`TaskOutputStore` 能从 spill file
   重建内存尾部，并从磁盘按 offset 增量读取完整历史；零输出 task 无需虚构空文件。
4. `completed` / `failed` / `cancelled` task 可由原 session 查询，且恢复不重发 completion；旧 `pending` /
   `running` 立即映射为 `unknown`，没有 child handle。`task_stop` 拒绝旧 PID，`task_wait` 立即返回
   `unknown`，Gateway 不接收 synthetic completion，session access fence 保持原 `sessionId`。
5. JSON corruption、schema/version 不兼容和非零 output metadata mismatch 在 provider/runtime composition
   时 fail closed；不会以空 state 启动。历史 terminal entry 不再占用 `maxTasks` 并发名额。

**明确不做**：不做 detached process adoption、PID reuse guessing、跨主机 worker、远程 queue、通用 workflow
registry 或第二 persistence backend。那些需要独立的 run owner、worker lease、side-effect status query 和
deployment E2E，仍归 R5 的需求触发工作包。

**验证结果**：

1. terminal task metadata/output 重建、无 completion replay、zero-output restore、running -> `unknown`、no PID
   stop/wait、session access fence、corrupt snapshot 与 output mismatch fail-closed 均有 runtime/tool tests。
2. Project execution-world test 覆盖真实 `.pilotdeck/background-tasks/state.json` composition；Gateway completion
   projection 回归仍通过。
3. Node 22 `pnpm build` 通过；task recovery focused suite 15/15、output-store suite 1/1、task
   tool/project/Gateway suite 8/8 通过。

## P1 架构收口：窄 capability、Session data plane 与 Plugin consumer view

本轮只调整 Definition / Provider / Consumer / Composition 边界，不改变 AgentLoop 状态机、持久化格式、
Module Protocol、tool 行为或运行结果。

| 边界 | Definition | Provider / owner | Consumer | Composition |
| --- | --- | --- | --- | --- |
| Agent turn context | `AgentTurnContextPort`、`LifecycleDispatchPort` | session scope 持有 `AgentContextRuntime`、`LifecycleRuntime` 并负责 dispose | `AgentLoop` 只见 context 五个方法和 lifecycle `dispatch` | `createAgentTurnCapabilities()` 创建冻结代理并保留原 runtime 的 `this`、返回值与异常语义 |
| Session data plane | `ProjectSessionPersistenceProvider`、catalog/fork/replacement/search ports | persistence backend 分别提供 durable write/read capability；native JSONL 是默认 provider | Registry、Gateway/Web、CLI search、Always-On 各自只接收所需 port | `ProjectSessionDataPlane` 按 explicit port -> legacy capability -> native capability -> fail-closed 解析一次；旧 helper 仅为 deprecated facade |
| Plugin session view | `PluginSessionContributionSnapshot` | `PluginRegistry` 继续唯一拥有 generation、lease、retirement 与 dispose | session composition、context resolver | `PluginRuntime.acquireSessionContributions()` 获取单 generation 冻结视图，包含 tools/prompts/commands/skills/MCP instructions/routers/hooks/MCP servers |
| Plugin command view | `PluginCommandCatalogSnapshot` | 同一 `PluginRegistry` lease owner | Gateway command catalog | `PluginRuntime.acquireCommandCatalog()` 只投影 commands，不向 Gateway 暴露完整 plugin aggregate |

兼容期内保留 `ProjectSessionStorageProvider` capability bag、`PluginContributionSnapshot`、
`snapshotContributions()`、`acquireContributionSnapshot()` 和四个 `createProjectSession*` helper；新生产组合链
不再读取这些 deprecated optional capability。Session/Gateway/Plan/Todo/Cron/Always-On/Goal 的状态 owner
没有迁移，LSP 也未由 plugin snapshot 自动装配。

Workflow、Agent Terminal、Goal round driver、SQLite query 和跨平台 sandbox 都属于功能扩展，不纳入本轮
纯架构重构；已有 Workflow core 也不因此接管任何领域 owner，且不新增 generic registry。

## 当前部署证据

2026-09-10 已在隔离的 StaffDeck SQLite 运行时执行：

```sh
backend/.venv/bin/python tools/real-deployment-e2e.py \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-core_agent_loop_0831
```

结果为 `PASS`。脚本以 `PILOTDECK_AGENT_LOOP_ENABLED=true` 启动当前构建的
`pilotdeck-agent-loop-sidecar.js`，并验证 HTTP、Gateway/WebSocket handshake、同 session 多轮、
并发 session 隔离、人工 handoff/resume、scheduled worker、team worker 及 SQLite 记录。它证明
sidecar 接入没有取得宿主的 Session/Gateway/业务状态 owner；但它不证明网络重连后的 operation
reconciliation，也不证明远程 subagent，因此不改变 R2/R3 的开始条件和验收要求。

## 验收矩阵

| 工作包 | 必须通过的行为 | 最小验证 |
| --- | --- | --- |
| R1 / R1.1 | 真实 child stdio、host callback、terminal/seed state、异常 cleanup；protocol final response 与 final event 都能投影 terminal | Node 22 build + sidecar/client/protocol tests + child-process test + `deadline`/`cancel` parity |
| R1.2 | host projection 是唯一 Plan/Todo truth；sidecar cache 经过校验且不跨 session/turn；host tool context 保持同一 handle | Node 22 build + `host-plan-todo-port`、default factory、sidecar client、native Plan/Todo focused tests |
| R1.3 | host 是 hook/plugin lifecycle 唯一 owner；sidecar 不泄露环境；dispatch result 保留 blocking 语义 | Node 22 build + host lifecycle runtime、default factory、sidecar client、module protocol focused tests |
| R1.4 | host ToolRuntime 获得 native 等价的 execution services，wire 不决定 env/storage/service owner | Node 22 build + sidecar capability context reconstruction focused test |
| R1.5 | host 收到有序 AgentLoop live event，且 event failure/restart 不改写业务 terminal 或 durable truth | Node 22 build + host event bridge、default factory、loopback sidecar final-before-flush focused tests |
| R4.2 sidecar production closure | budget、elicitation、live steer、compaction/status persistence、完整/projected request budget、seed read state、incremental model stream 与 metadata snapshot 经正式 factory；callback failure/reconnect/capability absence fail closed；production proof 不可缺失 | Node 22 build + protocol/default-factory/sidecar/TCP focused suites + 当前 Gateway 53 场景全部执行；52 个 strict shared，`deadline` 仅允许 2 条精确 transport settlement difference；exact contract 后 `FAIL=0`、`BLOCKED=0`、oracle failure `=0`；negative-control 缺 handshake/fake runner 必须 `BLOCKED` |
| R5-Z（实现已完成；P1 已验收） | host-confirmed enter/exit-plan transition 是唯一 live permission owner；submit-time run mode、context prompt、ToolRuntime 与 lifecycle 也只能读取 host config；forged/stale wire mode 无法绕过 ask gate；reconnect replay 不重复 transition | 已通过 Node 22 build + host permission-mode state、sidecar client 与 TCP replay focused suites；完整 PilotDeck matrix 纳入 R4.2 的 53 场景生产 gate，且两个 plan-mode scenario 覆盖省略 legacy mode 的四 turn 生命周期 |
| R2 | 单终态、cancel/deadline、reconnect/replay、unknown reconciliation | protocol fault-injection + host operation integration test；无 durable status-query consumer 时不得宣称可恢复 |
| R3 | child owner 未迁移；one-shot host callback、TCP/stdio parent-abort、TCP/stdio deadline/late terminal 和 host sidechain reference 已通过；剩余 remote/queued provider parity | native vs sidecar/remote canonical trace parity + TCP/stdio parent-abort/deadline E2E |
| R3.1（已完成） | Gateway timeout 投影同一 absolute operation deadline；effective one-shot child budget 不超过它；timeout 与 parent abort 可区分；host callback 不重复 terminal | Node 22 build + Gateway deadline contract + deterministic adapter/unit regression + one-shot timeout regression + host capability focused contract |
| R4 | prepared request 与 retry/token/health 一致 | provider replacement + retry/compaction focused contracts |
| R5-B session history read-side | 已完成：selected persistence provider 能驱动完整 history/digest；Always-On consumer 仅调用 injected port | Node 22 build + project-session-transcript-reader、session-catalog-consumers、project-automation-bundle focused tests |
| R5-C one-shot sidechain storage | selected provider 覆盖 parent/one-shot child write/read；native path 和 legacy fallback 保持兼容；child flush/dispose 精确一次 | Node 22 build + session/subagent/Web/Gateway focused contracts + native JSONL regression |
| R5-D provider-selected session catalog | selected provider 的 catalog identity 贯穿 Gateway/Web/Always-On；无 catalog 的 enumeration fail-closed，exact history 不回退 JSONL | Node 22 build + project-session-storage-provider、session-catalog-port、session-catalog-consumers、project-automation-bundle focused tests |
| R5-G standalone read-side composition | factory、manager、standalone control 和 application bundle 对同一 provider 选择 catalog/history；override 仍优先；无 catalog 时 exact history 不回退 JSONL | Node 22 build + project-session-read-side-bundle、session-catalog-consumers、always-on-control-port、project-automation-bundle focused tests |
| R5-H provider-selected session search | server/channel 使用 selected provider search；无 search provider 时明确 fail-closed；显式 `sessionSearch` 仍优先 | Node 22 build + project-session-search-port、pilotdeck-server-session-search、chat-search-port、channel-command-registry focused tests |
| R5-E provider-selected Web fork | selected provider owns fork target write; Web only plans fork; native JSONL artifacts remain compatible; missing fork port fails closed | Node 22 build + fork-session-storage-provider、fork-session-projection、gateway-session-history-bundle focused tests |
| R5-F provider-selected Web replace | selected provider owns backup/rewrite/finalize/recovery; Gateway retains live reservation; missing replacement port fails closed | Node 22 build + replace-last-turn-storage-provider、replace-last-turn、gateway-turn-replacement-coordinator、gateway-session-history-bundle focused tests |
| R5-M Always-On project durable records | runtime and standalone apply select the same structural provider; no concrete store private state leaks through the Definition | Node 22 TypeScript check + always-on-control-port、project-automation-bundle focused suites（19/19） |
| R5-N Cron project durable records | manager discovery/migration and runtime/scheduler/fire consume the same structural provider; `ProjectAutomationBundle` preserves selection through manager reload/start | Node 22 TypeScript/build + cron-control、project-automation、cron/automation focused suites（25/25） |
| R5-O Memory provider composition | selected `MemoryResolver` is consumed by a real Gateway session for retrieval/capture; custom disposer runs once after generation disposal; maintenance remains best-effort | Node 22 build/TypeScript + project-memory-bundle、project-memory-maintenance-controller、context-storage/model lifecycle focused suites（49/49 combined） |
| R5-P Router session provider composition | selected volatile state survives generation replacement; selected custom-router serves a real `RouterRuntime.decide`; external state is not cleared; generation registry disposes once | Node 22 build/TypeScript + model-provider-runtime-lifecycle、router-session-state/custom-router focused suites |
| R5-Q Compaction provider composition | selected project-generation `CompactionPort` is consumed by a real Gateway session turn; native orchestration remains default | Node 22 build/TypeScript + project-context-storage-bundle focused suite |
| R5-R Prompt-cache coordinator composition | selected project-generation `PromptCacheCoordinatorPort` is consumed by a real Gateway session turn; release remains session-scoped volatile cleanup | Node 22 build/TypeScript + project-context-storage-bundle focused suite |
| R5-A background task | 已完成：durable metadata/output、`unknown` recovery、access fence、无 synthetic completion | Node 22 build + task recovery 15/15 + output store 1/1 + task tool/project/Gateway 8/8 |
| R5-T LSP runtime provider | 已完成：selected `LspService` 由真实 Local Gateway session 的 `lsp` tool 消费；stdio provider 完成 initialize/open/query/close、workspace containment、结果规范化、`LSP_TIMEOUT`、`workspace/configuration` reply 和 protocol shutdown | Node 22 build + `tests/lsp/*` + `tests/cli/project-lsp-composition.spec.ts`（5/5） |
| R5-V session-scoped durable goal | 已完成：`goal_changed` event/projection/checkpoint、session-bound CAS runtime、`get_goal`/`create_goal`/`update_goal` consumer 和 Local Gateway composition | Node 22 build + `tests/goal/goal-runtime.spec.ts`、`tests/tool/builtin/goal.spec.ts`、`tests/cli/project-goal-composition.spec.ts`（5/5） |
| R5-W sidecar Goal host-context parity | 已完成：sidecar 收到 Goal descriptor 后，经现有 `capability.execute` 在 host 执行一次；host Session 仅追加一次 `goal_changed`，sidecar 没有 durable Goal state | Node 22 build + Goal runtime/tool suite + Local Gateway bundled-stdio model-turn E2E（6/6） |
| R5-X sidecar host checkpoint context parity | 已完成：host capability 与 one-shot fork 都复用 per-turn host checkpoint；initial seed/current attachment/host mutation 在 runtime reload snapshot 和 durable operation terminal seed 中连续，known terminal 不接受 stale sidecar seed 覆盖 | Node 22 build + `sidecar-client` focused suite（19/19） |
| R5（其余按需项） | 每项 durable/live owner 明确、可恢复且可释放 | 对应产品 E2E，不能用 mock-only 代替 |
| WF-D（核心已完成） | 可评审且可持久化的通用 Workflow core，领域 adapter 待真实 caller | `src/workflow/` Definition/Provider/Consumer/Composition；caller-owned run handle；step lifecycle 与 single-settlement；JSONL/InMemory event/store contract；只读 live event observer；pause/resume/cancel/deadline/dispose/late completion/unknown recovery；Plan/Todo、Cron、Always-On、Goal adapter boundary；权限、capability、Session/Gateway/AgentTurnInbox ownership matrix | Node 22 build + Workflow contract/state-machine/durable replay tests（17/17）；JSONL 与 InMemory 均按 run 独立维护连续 sequence；observer 故障隔离；不得用目录存在、空 Port 或 mock-only demo 宣称领域 adapter 已完成 |

## 明确不做

- 不引入 Cordis，不按 DSH package 数量改造 PilotDeck。
- 不将 `SessionRuntime`、Gateway、Router、ToolRuntime 或 child inbox 迁入 AgentLoop、sidecar 或 bundle。
- 不在没有明确 caller/owner 时构建 generic extension registry、profile patch matrix、remote subagent registry 或
  第二套 model-policy 产品；R4 已定义的 execution/routing/metadata/budget/auxiliary 窄 port 仅作为兼容架构 seam。
- 不做第二个完整 deployment，不做第二模型或第二 routing provider；当前 Local Gateway 与 native model/routing
  group 是唯一产品组合基线。
- P1 完成前不将 Workflow core 接入领域 caller；当前 core vertical slice 不迁移 Plan/Todo、Cron、Always-On、Goal
  的 durable owner，也不创建 generic workflow registry。
- 不将 transport 连接错误伪装成业务成功，也不把 `result_unknown` 当成 completed。

## 2026-09-20 验收锚点

SDK/core integration 当前验收锚点为 `codex/integrate-sdk-0901@b15d2080`，产品基线为
`origin/main@cd52c9af`，架构边界基线为 `Kaguya-19/refactor/core_agent_loop_0831@e55b0a82`。
独立回归报告 [`sdk-core-integration-final-20260920.zh.md`](../testing/sdk-core-integration-final-20260920.zh.md)
记录了模块 inventory、state/dispose owner、SDK public matrix、九类 blocker 及 production
trace。当前 gate 为 root `1721 pass / 2 skip`、SDK `123/123`、module focused `433/433`、
comparator `53/53`、production `failed=0 / blocked=0 / oracleFailures=0`；19 个 baseline
缺失能力仍明确标为 `notApplicable`。Frontend integration 不属于本轮覆盖范围。

## 代码锚点

PilotDeck：

- `src/session/events/SessionRuntime.ts`、`src/session/storage/ProjectSessionStorage.ts`
- `src/session/{catalog,history,search}/`、`src/session/catalog/ProjectSessionCatalog.ts`、`src/session/history/{ProjectSessionReadSideBundle,ProjectSessionTranscriptReader}.ts`、`src/session/search/ProjectSessionSearchPort.ts`
- `src/session/fork/{ProjectSessionForkPort,NodeProjectSessionForkPort}.ts`、`src/web/server/forkSession.ts`
- `src/session/replacement/{ProjectSessionReplacementPort,NodeProjectSessionReplacementPort}.ts`、`src/web/server/replaceLastTurn.ts`
- `src/cli/SessionSubagentTranscriptBundle.ts`、`src/agent/sub/{OneShotSubagentPort,SubAgentSession}.ts`、`src/web/server/readSessionMessages.ts`
- `src/agent/scope/AgentRuntimeScope.ts`、`src/agent/scope/ScopedServiceRegistry.ts`、`src/agent/scope/AgentFactoryProvider.ts`
- `src/agent/loop/AgentTurnCapabilities.ts`、`src/agent/loop/AgentLoopRuntimeFactory.ts`
- `src/context/memory/MemoryResolver.ts`、`src/context/memory/EdgeClawMemoryProvider.ts`
- `src/lsp/{protocol,runtime,provider}/`、`src/tool/builtin/lsp.ts`
- `src/cli/{ProjectMemoryBundle,ProjectMemoryMaintenanceController,ProjectRuntimeResourcesBundle,ProjectRuntimeRegistry}.ts`
- `src/router/session/{RouterSessionStatePort,RouterSessionCustomRouterPort}.ts`、`src/cli/ProjectRouterRuntimeBundle.ts`
- `src/agent/modules/transport/{agentLoopSidecarClient,agentLoopSidecarServer}.ts`
- `src/agent/modules/capability/hostPlanTodoPort.ts`、`src/plan-todo/{runtime,projection}/`
- `src/goal/{protocol,runtime,projection}/`、`src/tool/builtin/goal.ts`、`src/cli/SessionGoalBundle.ts`
- `src/agent/modules/lifecycle/hostLifecycleRuntime.ts`、`src/lifecycle/runtime/LifecycleRuntime.ts`
- `src/agent/modules/events/hostAgentEventBridge.ts`、`src/agent/protocol/events.ts`
- `src/agent/sub/{OneShotSubagentPort,SubagentContinuationManager,SubagentProviderRegistry}.ts`
- `src/cli/{ProjectAutomationBundle,ProjectRuntimeRegistry,LocalGatewayBootstrapBundle}.ts`
- `src/task/{runtime/BackgroundTaskRuntime,storage/TaskOutputStore,protocol/types}.ts`
- `src/tool/execution-world/ExecutionWorldBundle.ts`、`src/cli/{ProjectExecutionWorldBundle,ProjectRuntimeResourcesBundle}.ts`
- `src/gateway/{GatewaySessionLiveProjectionBundle,tasks/GatewayBackgroundTaskCompletionProjection}.ts`

DSH `0.1.2-alpha.2`：

- `packages/core/scope/src/{index,store}.ts`
- `packages/core/{agent,agent-loop,session}/src/`
- `packages/session/{session-persistence-*,session-projection}/src/`
- `packages/subagent/`、`packages/boot/app-boot/src/profile.ts`、`packages/bundle/base/`
