# AgentLoop Modular Framework 文档总览

状态：执行稿　维护者：Agent Runtime 团队

本文是 PilotDeck AgentLoop 模块化框架的文档入口。协议和 AgentLoop 核心规范归
PilotDeck；宿主产品的 session、turn、permission、tool、checkpoint、SOP/Harness
和最终状态仍由宿主维护。

## 阅读顺序

1. [人类开发流程文档目录](agent-loop-human-development-directory.zh.md)

   按需求、协议、实现、回归、真实部署、对拍和发布阶段组织现有文档，适合人类开发者快速定位入口。

2. [人类模块化开发交互 SOP](agent-loop-human-operation-sop.zh.md)

   面向人类与 coding agent 的协作，给出需求提法、范围约束、对拍差异修复、结果审查和提交授权方式。

3. [AgentLoop 接入开发 SOP](agent-loop-development-sop.zh.md)

   面向开发者的阶段流程、DSH 能力族模块划分、代码修改范围、mapping/TRD 产物、分层测试、真实部署、对拍和发布检查。

4. [Module Communication SOP](pilotdeck-module-communication-sop.zh.md)

   规范身份字段、operation/attempt 状态、终态、取消、deadline、重试、恢复、profile
   和 transport-independent adapter 约定。当前文档版本为 v0.9，协议版本为 v2.0。

5. [Module Protocol v2 Schema](pilotdeck-module-protocol-v2.schema.json)

   机器可读的 request、response、event、error、module_call 和 host module 字段定义。

6. [AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)

   说明五类 model consumer ports、`ToolPort`、`AgentContextRuntime`、session projection、scope lifecycle、
   sidecar factory、context module 和 capability module 的实现边界。

7. [PilotDeck DSH 风格模块化 Roadmap](trd/04-dsh-modularization-roadmap.zh.md)

   对照 DSH 的 capability seam、scope、session event/projection、owned lifecycle 和
   profile/bundle 组合模型，列出 PilotDeck 当前成熟度、未模块化主体及分阶段迁移门槛。

8. [DSH 与 PilotDeck 当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md)

   基于 DSH `0.1.2-alpha.2` 发布实现与当前 PilotDeck 组合链的复核结论，明确当前模块成熟度、
   不可迁移的 state owner，以及从 stdio sidecar provider 开始的实际交付顺序。

9. [StaffDeck AgentLoop Integration](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/docs/pilotdeck-agent-loop-integration.md)

   StaffDeck 的具体 glue、TaskFrame/Harness mapping、checkpoint 投影、权限聚合和
   result_unknown 处理只在 StaffDeck 仓库维护，不成为 PilotDeck core contract。

10. [PilotDeck Native / Sidecar 对拍 SOP](pilotdeck-agent-loop-parity-sop.zh.md)

   PilotDeck 原生与 sidecar 的比较范围、adapter 契约、scenario 矩阵、canonical trace、
   normalization、退出码和 gateway 验收门槛。

   实际运行记录见 [PilotDeck AgentLoop 对拍结果](pilotdeck-agent-loop-parity-results.zh.md)。

11. [AgentLoop parity README](https://github.com/Kaguya-19/StaffDeck/tree/codex/pilotdeck-agent-loop/tools/agent-loop-parity/README.md)

   跨宿主对拍 harness、mock provider/tool、canonical trace 和 StaffDeck 真实部署验证方法；
   PilotDeck-only 工具则位于本仓库的 `tools/agent-loop-parity/`。

## 架构边界

```text
宿主 Session/Turn/Run
        |
        +-- context module  -> 宿主 ContextRuntime
        +-- budget module   -> 宿主 ModelBudgetPort/token policy
        +-- turn module     -> 宿主 steer mailbox/compaction persistence
        +-- capability      -> 宿主 ToolRuntime/PermissionRuntime
        +-- model           -> 宿主 Model provider
        +-- checkpoint      -> 宿主持久化和恢复逻辑
        +-- event           -> 宿主 AgentEventEmitter（仅 live projection）
        |
        +-- PilotDeck AgentLoop
              +-- canonical messages
              +-- model/tool loop
              +-- unique terminal outcome
              +-- sidecar protocol adapter
```

AgentLoop 不识别 StaffDeck 的 TaskRequirement、HarnessAction、TaskFrame 或租约字段。
宿主将自己的业务状态投影为通用 payload；sidecar 只消费 canonical messages、tool
descriptors、permission context、seed state 和 execution identity。

### 当前 application composition 边界

- AgentLoop 通过冻结的 `AgentTurnContextPort` 和 `LifecycleDispatchPort` 消费 context/lifecycle；完整 runtime
  仍由 session scope 持有和释放。
- AgentLoop 的模型面向 consumer ports 分层：`ModelExecutionPort` 是必需核心，`AgentTurnRoutingPort`、
  `ModelMetadataPort`、`ModelBudgetPort` 与 `AuxiliaryModelPort` 均可独立注入；Router 只是兼容 facade，
  不拥有 AgentLoop 或 provider registry。第三方 provider 只能通过 adapter 接入 canonical request/event contract。
- Session durable backend 由 `ProjectSessionPersistenceProvider` 定义；application 在启动时组合
  `ProjectSessionDataPlane`，再把 catalog、fork、replacement、search 分别交给对应 consumer。旧
  `ProjectSessionStorageProvider` optional capability bag 仅作兼容入口。
- Plugin generation 仍由 `PluginRegistry` 唯一管理。session composition 获取
  `PluginSessionContributionSnapshot`，Gateway command catalog 获取 `PluginCommandCatalogSnapshot`；两个 lease
  都绑定获取时 generation，retired plugin 等全部旧 lease 释放后才 dispose。
- `PluginContributionSnapshot` 与原 acquisition API 暂时保留为 deprecated adapter；生产 session/context/command
  路径不再依赖完整 aggregate。

模型依赖方向固定为：

```text
provider client / SDK
        -> provider adapter（native 或 host）
        -> ModelExecutionPort
        -> SidecarAgentTurnCapabilityComposition
        -> AgentLoop

AgentTurnRoutingPort / ModelMetadataPort / ModelBudgetPort / AuxiliaryModelPort
        -> application composition（可与 execution provider 分开选择）
Router facade --------------------------^（legacy/default adapter，可选）
```

### Sidecar 专属组合边界

sidecar 使用 `SidecarAgentTurnCapabilityComposition` 与 `SidecarAgentLoopPorts`，只接受显式 consumer
ports，不接受 `AgentRuntimeDependencies`、Router、registry 或 scheduler。其最小组合是
`ModelExecutionPort + ToolExecutionPort`；routing、metadata、budget、auxiliary、context、permission、
plan、subagent 和 lifecycle 都是独立可选 port。默认 factory 不再构造假的 native tool bag；未提供
`AuxiliaryModelPort` 时 sidecar 不会回退到 Router `stream`。

budget、turn 与 interaction 的 sidecar 边界同样只传能力和可序列化状态：`budget` module 由 session
composition 投影 `ModelBudgetPort`，`turn` module 把 live steer drain 和 compaction commit 回调到 host；
`interactionCapabilities.elicitationAvailable` 只传布尔 availability。Router、steer mailbox、elicitation
channel、Session writer 和 callback 对象都不进入 wire。durable owner 分别仍是 host model/token policy、
`AgentTurnInbox`/Session transcript 与 `TurnRunner.onCompactPersisted`。

turn 提交的 permission rules 仅是 user-owned override：host 会替换既有 user rules，但保留 project、session、
policy 与 cli 规则，且不会接受 wire 输入伪造这些来源。动态工具目录则通过可选 `capability.list_tools` 在每次
新 model request 前刷新；它只返回冻结 descriptor view，不暴露 registry、scheduler 或 permission object。未广告
时继续使用 execute admission 的快照，广告后返回 malformed catalog 必须失败关闭。

model module 优先通过 `stream_next` 逐批拉取 canonical events，并在 generator 提前结束或 abort 时用
`close_stream` 释放 host-owned provider iterator；未广告新方法时才回退到 deprecated batched `stream`。每个
`preparationId` 只绑定一个 iterator，module-call cache 保证 reconnect 重放同一 pull 时不重复推进；turn dispose
负责关闭仍存活的 iterator，不把 provider stream state 放进 sidecar 或 Session durable state。

当 post-routing compaction 要替换消息窗口时，sidecar 可选调用 model 的
`materialize_prepared_request`。它只携带 `preparationId` 和 canonical candidate request；host 使用同一条已准备
的 invocation 调用窄 `AgentTurnRoutingPort.materializeRequest`，再返回 materialized request。Router/opaque
routing state 不进入 wire，且没有此 capability 的 direct provider path 只替换 messages，保留 `prepare()` 已决定的
system prompt、tool schema、cache plan 与 output cap。

runner 还会在同一存活 session 内回传一个可选、易失的 model-state projection，其中仅有 route-aware token
calibration、跨 turn 的 hard context/output cap，以及 large-file recovery 的 session output target。它随 execute/final 在 host 与 child 间往返，绝不进入 Session
event、projection 或 checkpoint；新的 session/recovery 仍从保守基线开始。

`model.get_metadata` 是可选的 host module operation。host 从 `ModelMetadataPort` 投影 provider/model、context/output
limits、protocol 和 prompt-cache capability；sidecar 只保留当前 turn 的只读 snapshot，启动时读取 effective route，`prepare`
返回实际路由后刷新。Router、provider registry 与 metadata cache 都不进入 wire；缺失 capability 继续使用既有保守 fallback，
而广告后返回 malformed 或 route identity 不匹配的 snapshot 必须失败关闭。

compaction wire 只携带 canonical request template 与 `budgetStage`。host 将 candidate messages 替换进该 template，
重新运行 preview context preparation，但不会第二次调用 `ModelExecutionPort.prepare()` 或重跑 Router selection；再用 active
turn 的 `ModelBudgetPort`、abort signal、有效 context limit 和 reserved output tokens 重建 request-level
snapshot；未广告 budget capability 时才保留 message-only fallback。`seedReadState` 则由 native/sidecar runner 共同
调用共享 helper，更新 host-owned read/write seed snapshot，下一 turn 仍经既有 seed projection 进入 sidecar。

sidecar runner 是 host 与 child event 的唯一外部 timeline allocator：child-local wire position 不直接作为对外坐标；
host buffer 经过同一 projector 后才输出，并从 child session tool events 派生 `subagent_status`/heartbeat。该投影仍是
volatile live event，不成为 Session durable truth。compaction persistence callback 属于 durable boundary：拒绝会停止直接
runner 的后续模型调用；Gateway `TurnRunner` 继续拥有 durable bracket cleanup 与 abort。

compact durable boundary 的 replacement 采用 versioned `snapshot`（当前 v1）保存完整 canonical messages。它由
Session/EventStore writer 持有，不进入 sidecar wire；完整 snapshot 可在 enclosing turn terminal 缺失时恢复，损坏或不完整
snapshot 绝不替换旧历史，legacy `replacementMessages` 仍只读兼容。JSONL owner 在 compact boundary 后 flush，并在下一次
append 前修复中断尾行；这些是持久化/replay 语义，不改变 Module Protocol v2 或 Router policy。

`AgentTurnCapabilities.ts` 是纯 consumer view；native 的宽 dependency bag、Router 与 scheduler adapter
只在 `nativeAgentTurnCapabilitiesAdapter.ts` 中保留为 deprecated compatibility facade。AgentLoop 不读取
`PreparedModelInvocation.opaque`，也不引用 Router 类型；legacy Router decision/materialization 仅由该
native adapter 适配为通用 routing port。

Context 同样拆为 `ContextPreparationPort`、`ContextToolResultPort`、`ContextRecoveryPort`、
`ContextCapturePort` 和 `ContextCompactionPort`；host 只广告实际支持的 operation，预算 projection 仍由
host 重建，不经 wire 传递 evaluator。旧 `AgentTurnContextPort` 仅保留兼容聚合 view。

工具路径分为 `ToolAuthorizationPort -> ToolExecutionPort`：前者由 host policy 决定 allow/deny/
input rewrite，后者只调用 capability。host 广告 `execute_batch` 时，authorization 不重排或拆分批准后的
调用，保持单一 batch 边界；非 batch provider 保留既有 execution 并发调度。`PilotDeckToolRuntimeContext` 由独立的 sidecar
tool-context adapter 从窄 ports、checkpoint 和 turn identity 组装；transport 不直接拥有 Plan/Todo、
goal、subagent、permission 或 auxiliary-model 聚合逻辑。

启用 `includeToolProgress` 时，host tool 可以将 `tool_progress` 写进 host event buffer；runner 在 capability
module call 未结束时仍轮询并转发该 volatile event，因此进度可早于最终 `tool_result` 到达。进度不写入 transcript，
也不参与 replay 或 terminal settlement。

sidecar transport 只拥有连接、replay、identity 与 terminal settlement。`SidecarConnectionFactoryInput` 只包含
`SidecarTransportTurn`、seed projection 与 `SidecarTransportContext`，不能取得任何 model/tool/permission/context port。
`SidecarModuleComposition` 按 model、budget、turn、capability、permission、planTodo、context、lifecycle、event 分开注入；每个 custom handler
factory 仅收到自身 module port 和裁剪后的 turn view。`SidecarTransportContext` 单独传递 session-owned operation ledger 与被动 telemetry，
不再把这些 transport state 藏进 capability aggregate。`sidecarTurnComposition` 负责每 turn
的 PermissionMode、Plan/Todo handler、capability-result observer 和可替换 module handler registry；默认
observer 使用 `HostPermissionModeState` 保持现有 plan-mode 生命周期，但 transport runner/protocol 均不持有
该状态。工具完成后通过独立 `ToolResultObserver` 通知 Plan/Todo projection refresh，不再由 Plan/Todo wrapper
包裹 `ToolExecutionPort`。

`sidecarToolContext` 的 raw services 只在 host composition 内保存；它按 turn 绑定为 capability 的
`ToolRuntimeContextFactoryPort`、permission 的 `PermissionRequestContextPort` 与 context 的 identity port。
因此 capability、permission、context 都不读取彼此的 execution/provider 对象；Plan/Todo 也作为独立可选 module
保留原有 `capability.plan_todo` wire operation。

新的 sidecar module handler factory 是按 module 的 `model/capability/permission/context/lifecycle/event` 字段；module
registry 与 manifest 冻结后交给 protocol；protocol 仅处理 transport、identity、replay、checkpoint 与 terminal settlement，
不接收 `SidecarModuleComposition`。默认 dispatcher 由 host composition 创建。旧 `AgentLoopSidecarConnectionFactoryInput` 仅为命名兼容 alias，生产 transport 应使用
`SidecarConnectionFactoryInput`，不应读取 native capability facade。

`HostToolCheckpoint` 是每个 turn 的 host-owned mutable file state。后续 transcript/status callback 失败必须让 turn
按失败语义结算，但不得抹掉已完成 host tool 的 checkpoint snapshot；runner 的 finally 将它作为下一次 execute 的 seed，
而不是把 callback failure 解释为工具未执行。

`ModelExecutionPort` 是 AgentLoop 的核心 consumer contract。直接构造 capabilities 时 Router 不是必需 owner，但完整
`AgentRuntimeDependencies`/session/Gateway composition 仍保留 Router 依赖。显式 execution provider 可以绕过 Router，空
Router 不能提供模型执行。`ModelInvokerPort`、旧 aggregate 字段和 `PreparedModelInvocation.opaque` 仅在兼容
adapter 中保留，直到 native/sidecar/session/subagent/Gateway 回归证明可以删除。详见
[AgentLoop Modular Framework TRD](trd/03-agent-loop-modular.zh.md)、[接入开发 SOP](agent-loop-development-sop.zh.md)
和[当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md)。

Workflow、Agent Terminal、Goal round driver、SQLite query 与跨平台 sandbox 是独立功能扩展，不属于本轮
边界收窄；本轮不迁移任何 Plan/Todo、Cron、Always-On、Goal、Session 或 Gateway 状态 owner。

## 跨语言和 transport 约定

- Module Protocol 使用 JSON/NDJSON wire format，字段和终态由 v2 Schema 定义，语言实现
  不受 TypeScript 限制。
- AgentLoop 核心只依赖 ports；sidecar server、host stdio provider 和 loopback TCP reconnect provider 已作为
  capability-only external loop factory 纳入应用组合，不是协议唯一 transport。stdio 仍是一 turn 一 child process，
  TCP 才广告 `resume`/`ack` 并在同一 sidecar instance 上恢复 stream。`status` 是同连接 live snapshot；
  `result_unknown` 的 durable reconciliation 仍由 session-owned ledger 决定，见[当前执行 Roadmap](trd/05-dsh-pilotdeck-current-roadmap.zh.md) 的 R1/R2。
- 其他语言或通道可以实现自己的 adapter，但必须保持 `hello`、`capabilities`、`execute`
  以及适用的 `cancel`、`status`、`resume`、`ack` profile 语义。
- 宿主必须拥有 session/turn/run/operation 最终状态；模块不得创建第二套公共状态。
- permission、tool 并发、checkpoint 持久化和最终结果聚合由宿主负责，不能在 sidecar 内复制
  宿主业务规则。

## 接入开发 SOP

每次新增或修改模块能力时同步更新：

1. JSON Schema 中的字段/profile 定义；
2. 本 SOP 的身份、终态、错误和 Mapping 章节；
3. TRD 中的 port、adapter 和 ownership 说明；
4. 协议单元测试，包括 malformed message、duplicate、乱序、sequence gap、cancel、
   deadline、断线和恢复边界；
5. 至少一个真实宿主 adapter 的端到端验证记录。

接入前必须明确 module profile、能力版本、request/event identity、错误码、retryability、
副作用和恢复策略。不得把宿主专属字段放进 PilotDeck 默认 factory，也不得用宽泛的
normalization 规则隐藏 semantic diff。

## 当前验收状态

### 2026-09-19 merge regression closure

固定 `origin/main=cd52c9af812a84c27a9dd1b7ccf246f48540045f`、current=`2a767d95b21bd66215a3c65ebdd92159ad6fa156`，严格 production stdio 对拍 53/53：`failed=[]`、`blocked=[]`、`oracleFailures=[]`、`knownGaps=[]`；34 个 baseline applicable、19 个明确 `notApplicable`。current native 与正式 sidecar 均通过 handshake、capability manifest、host dispatcher 和 durable callback oracle。

本轮没有重新引入 AgentLoop 宽依赖或状态 owner：`AgentLoop.ts` 未 import Router、SessionRuntime、Gateway、Plugin aggregate 或 `AgentRuntimeDependencies`；sidecar 继续只消费 `AgentTurnCapabilities` 窄 ports，Module Protocol 保持 `2.0`。comparator 对 budget usage 的归一化受限于可验证 breakdown 和声明的 request composition drift，缺失/重复/错误 breakdown、相同 request 的 budget 偏差均失败。

- PilotDeck native vs sidecar 的正式 Gateway gate 当前为 53 个 PilotDeck 场景；2026-09-18 在 Node `22.23.1` 上最新重跑时，
  52 个场景为 strict shared，`deadline` 保留 native confirmed abort 与 sidecar `result_unknown` 的 2 条精确 transport
  settlement difference。exact contract 生效后 `FAIL=0`、`BLOCKED=0`、oracle failure `=0`，不能写成 53 个场景无条件
  strict equality。与 `origin/main` 对拍时 34 个场景适用、19 个 `notApplicable`；durable timeout/steer 与
  `auto_compact` 是逐路径声明的 current extension，额外差异仍为 FAIL。runtime context 与 skill 内容继续 canonicalize
  后实际比较，只规范化 skill 文件路径。`run.py` 维护独立必跑清单，缺少、重复或空场景会直接失败。sidecar adapter 必须通过
  `PILOTDECK_AGENT_LOOP_TRANSPORT=stdio` 进入 deployment profile 和
  `createAgentLoopSidecarRuntimeFactory`，并在原始 trace 中留下 transport selection、handshake/binding 和预期
  host module call 证据；任一证据缺失均为 `BLOCKED`。旧 adapter 自建 runner 或注入测试 factory 的结果已废止，
  不能作为生产 sidecar 验收。
- main/current 的 context-budget 发射顺序不同，baseline comparator 将 budget 绑定到对应 model request 后比较；缺失、重复、
  未配对和相同请求上的数值变化仍为 FAIL。`runtime_context` 是 request-only projection，prepare 会替换旧快照，comparator
  继续拒绝重复标签、未知残余内容和非文本 block。
- budget、elicitation、live steer、durable compaction、full-request budget、seed read state、live model stream、model metadata、显式空 system prompt 与 additional working directories 已加入正式 Gateway matrix。mock model/tool 只是正式 host dispatcher 的确定性依赖，不是外部 provider 或完整 deployment E2E。
- `plan_mode_host_policy` 与 `plan_mode_bypass_host_policy` 通过同一 Gateway session 的四轮提交验证 host-owned mode 生命周期：客户端省略 legacy `mode` 后，下一轮分别为
  `default -> plan -> plan -> default` 与 `bypassPermissions -> plan -> plan -> bypassPermissions`；plan 中的写操作以 `plan_mode_violation` 拒绝，退出后仅允许一次真实副作用。
- compaction 的 request-level 预算不再把 durable candidate messages 猜测式拼回已投影 request；host 以可序列化的
  preparation intent 重新运行 preview context preparation，但不重跑 model preparation 或 routing。route calibration
  仅以匹配 provider/model 的标量投影传递；不存在或不匹配时明确失败或按 capability 缺失走既有 message-only fallback。
- `auto_compact` 已纳入 context host-module method；sidecar 只有在 capabilities 广告 `try_auto_compact` 时才启用该 consumer，未广告时保留原有 fallback。
- `plan_todo` 已作为可选 capability host-module method 闭合；Session projection 是唯一 durable truth，sidecar 只持有按 active session/turn 校验后的 cache，不能演变为 generic workflow registry。
- `lifecycle.dispatch` 已作为可选 host-module method 闭合；host 继续拥有 plugin registry、turn environment 和 teardown，sidecar 仅消费 hook dispatch result。
- capability host dispatch 会从 active host capability view 重建 audit、interaction、file/plan services、turn environment 和 model routing；read/write seed state 与 full-fork subagent state 继续按 checkpoint/R3 owner 隔离。
- `event.emit` 已作为可选 host-module method 闭合；sidecar 串行回传 AgentLoop volatile event，并在 final 前 flush 已受理 delivery。它不是 Session truth、operation ledger 或 reconnect state；event failure 不得改写业务 terminal。
- production loopback contract 已覆盖动态 tool catalog、host `prepare()` request materialization、steer attachment 的
  durable-before-authorize 顺序、跨 child 的 hard token cap、慢工具 progress 与 durable callback failure 后的 host
  checkpoint 保留；这些是 sidecar factory 路径测试，不替代 Gateway stdio parity gate。
- session read-side 已按 selected storage provider 组合 catalog 与 transcript reader；Web fork 通过 `ProjectSessionForkPort` 把 target durable write、auxiliary artifact transfer 和 publication 留给 provider，Web replace 通过 `ProjectSessionReplacementPort` 把 backup/rewrite/finalize/recovery 留给 provider。未声明 catalog/fork/replacement 的 non-native backend 分别 fail-closed；Gateway 继续拥有 replacement 的 live reservation 和 timeout。
- StaffDeck workflow 对拍已能真实进入 Harness，但 SOP step/slot/handoff、deadline、
  unknown result 等宿主状态仍有差异，不能作为 PilotDeck core 已完全验收的依据。
- `src/workflow/` 已具备 caller-owned Definition/Run/Control、InMemory 与 JSONL EventStore、DAG 执行、只读 live event observer、pause/resume/cancel/deadline/dispose、owner fence 和 unknown recovery；它仍不接管 Plan/Todo、Cron、Always-On、Goal 的 durable owner，也没有 generic registry。
- `session-title` 已具备 provider/model provenance、user-pinned source、source turn 与 accepted-input sequence 的兼容 metadata 投影；独立 DSH `user/message` seq 事件仍未引入，避免把聚合 `accepted_input` 错当作逐消息 durable event。
- 完整生产级跨语言 SDK、Schema runtime validator 和具体 Gateway/remote deployment 的断线 E2E 仍是后续工作；
  loopback TCP provider 已覆盖 AgentSession 的 resume/ack 本地契约，但不等同于上述部署验收。

## 验证命令

在 Node 22 环境运行：

```text
pnpm build
node --test dist/tests/agent/modules/*.js \
  dist/tests/agent/session/agent-loop-factory.spec.js \
  dist/tests/protocol/module-protocol-contract.spec.js
git diff --check
```

对拍和真实部署命令、版本、退出码及临时产物位置见 StaffDeck 的实验记录，不将 trace、
SQLite、日志或 token 提交到 PilotDeck。

## 2026-09-20 SDK/Core 独立回归

当前 `codex/integrate-sdk-0901@836d81eb` 已在固定 `origin/main@cd52c9af` 与架构基线
`Kaguya-19/refactor/core_agent_loop_0831@e55b0a82` 上完成系统回归：Core build、根测试
`1721/1721`、SDK `127/127`、模块/transport/session focused `433/433` 和 production
parity `53` 场景均无 FAIL/BLOCKED/oracle failure。53 个 sidecar 场景均有正式 stdio
handshake 与 host `module_call_received` raw proof。模块族到 port/provider/owner/test 的
逐项 inventory、SDK public matrix 和九类 blocker ledger 见
[`sdk-core-integration-final-20260920.zh.md`](testing/sdk-core-integration-final-20260920.zh.md)。

该报告的结论不是“所有仓库模块已完成同一 sidecar 解耦”：Session/Gateway/Workflow/Plugin/
Cron/Always-On/Goal/Web 仍是 host-owned，逐项归属和测试映射已列出；Workflow domain integration
及 Frontend integration 未验证。SDK 的 `Query.accountInfo()` 仍是有文档依据的
`unsupported_capability` gap，不能把 SDK 说成无缺口。

19 个 main 缺少能力的场景在 baseline summary 中保留为 `notApplicable`，不计为 PASS；
Frontend integration、真实外部 provider、remote/queued deployment、StaffDeck workflow
和 Desktop 原生视觉检查明确未覆盖。
