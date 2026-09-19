# SDK/Core Integration 验收清单（2026-09-19）

本文是本轮 SDK/core integration 的增量验收清单。原始要求来自用户 goal；产品行为以固定 `origin/main` 为基准，架构边界以 `Kaguya-19/refactor/core_agent_loop_0831` 为基准。历史报告只在当前实现、测试入口和 comparator 仍匹配时复用。

## 固定证据

| 项目 | 固定值 / 来源 |
| --- | --- |
| 当前分支起点 | `2a767d95b21bd66215a3c65ebdd92159ad6fa156` |
| 本轮实现提交 | `c308a3109a179809a54d8af69fc40c9382cc946a`；本清单与 comparator 证据随最终验收提交 |
| 产品行为基线 | `origin/main=cd52c9af812a84c27a9dd1b7ccf246f48540045f` |
| 架构基线 | `Kaguya-19/refactor/core_agent_loop_0831=e55b0a82d07ee3951e5812c34103400dfa6043f7` |
| 运行环境 | Node `v22.23.1`，Python `3.12.2` |
| 主要报告 | `docs/testing/sdk-core-merge-regression-20260918.zh.md`、`docs/pilotdeck-agent-loop-parity-results.zh.md` |
| production raw trace | `/tmp/pilotdeck-parity-closure-20260919-strict2/` |

## 行为验收

| 原始要求 | 实现 / owner | 验证入口与当前证据 | 状态 / 未完成工作 |
| --- | --- | --- | --- |
| Session admission、submit、abort、timeout、close、shutdown、dirty recreate、reload | Gateway session admission/fence 与 Session owner；AgentLoop 只消费 turn ports | `tests/gateway/*`、`tests/session/*`、production scenarios `deadline`/`cancel`/`checkpoint_resume`；parity summary 无 failure | 已关闭；未发现未解释差异 |
| SDK config、MCP、seedReadState、flag settings 与 turn/maintenance 并发 | SDK client 将控制操作交给 Gateway；控制 admission 与 turn reservation 由 Gateway 维护 | `packages/sdk/test/transport.test.ts`、`tests/sdk/*`、`tests/agent/loop/seed-read-state.spec.ts`；SDK `123/123` | 已关闭 |
| current/base permission mode 在入口、失败、重建、退出一致 | Permission registry/Gateway session 持有 mode；plan override 不覆盖 base mode | permission/plan focused tests、`plan_mode_host_policy`、`plan_mode_bypass_host_policy`、root `1721 passed` | 已关闭 |
| model prepare、materialize、stream、retry、fallback、pre-route/routed/recovery compaction | Model ports 与 host preparation owner；sidecar 只传 preparation reference/canonical request | `tests/agent/modules/llm-model-port.spec.ts`、AgentLoop compaction tests、`sidecar_full_request_compaction_budget`、`sidecar_projected_request_compaction_budget` | 已关闭 |
| request controls、完整 prompt/tools/cache/output cap、budget、usage、错误分类 | Canonical request 与 ModelBudgetPort；错误分类留在 provider/module terminal | root AgentLoop/model tests、预算 scenarios、strict comparator budget tests | 已关闭；budget comparator 另有精确负向证据，见下节 |
| persistence callback failure、durable-before-visible、operation terminal、replay/reconnect | Session/EventStore 与 operation ledger owner；callback failure fail-closed | compaction/replay/fork/deferred failure `21/21`、sidecar raw traces、reconnect/terminal tests | 已关闭 |
| tools、subagent、live steer、interaction、resource lease、teardown | Tool/interaction/subagent/lease owner 留在 host；sidecar 只消费 capability ports | production sidecar scenarios `sidecar_live_steer`、elicitation、subagent、progress；root tool/subagent/teardown tests | 已关闭 |
| Gateway、SDK、Web replay/bridge、session history、plugin 组合入口 | Gateway 是 session/durable truth；SDK/Web 只消费公开 projection/bridge；plugin snapshot 在 host composition 冻结 | root Web/session/plugin tests、`tests/web/compact-replay.spec.ts`、`tests/web/fork-session-projection.spec.ts`、SDK MCP/package tests | 已关闭 |

## 架构验收

| 约束 | 当前检查 | 证据 / 状态 |
| --- | --- | --- |
| AgentLoop 只消费窄 ports | 调用路径：`AgentLoop` -> `AgentTurnCapabilities` -> `AgentTurnContextPort`/`ModelInvokerPort`/`ToolPort`；native adapter 在 loop 外组合 Router，sidecar factory 在 transport 外组合 host ports | `src/agent/loop/AgentLoop.ts`、`src/agent/loop/AgentTurnCapabilities.ts`、`src/agent/loop/nativeAgentTurnCapabilitiesAdapter.ts`；无 Router/Gateway/SessionRuntime/Plugin aggregate/AgentRuntimeDependencies import，已关闭 |
| sidecar 只通过 canonical protocol、capability manifest、可序列化状态交互 | `createSidecarAgentTurnCapabilities` 只接收显式 ports；stdio client/server 负责 handshake、manifest、dispatch、operation identity | `src/agent/modules/protocol.ts`、`src/agent/modules/transport/*`、raw trace 的 `transport_selected`/`handshake_completed`/`module_call_received`，已关闭 |
| state/dispose owner 不迁移、不重复 | Session/transcript/permission/preparation/lease/dispose 仍由 host/module owner；sidecar 无 mailbox、Router、Session truth | `src/agent/modules/transport/agentLoopSidecarClient.ts` 注释与 composition、root owner tests、production proof，已关闭 |
| Module Protocol 版本不变 | `MODULE_PROTOCOL_VERSION = "2.0"` | `src/agent/modules/protocol.ts`、module protocol focused tests，已关闭 |

## Comparator 可信度门槛

| 门槛 | 精确证据 | 状态 |
| --- | --- | --- |
| 合法扩展通过 | `test_baseline_contract_allows_declared_request_drift_with_valid_breakdown`；existing production baseline extensions 全部逐路径匹配 | 已关闭 |
| 只改变目标语义的错误失败 | request control、tool schema、runtime-context 顺序、late model request 测试断言具体 path | 已关闭 |
| 新增 breakdown 校验确实必要 | 禁用 `_baseline_budget_validation_differences` 后，`test_baseline_contract_rejects_inconsistent_budget_breakdown` 预期失败，唯一目标为 `trace.contextBudget.current[0].breakdown.total_consistency` | 已关闭 |
| 负向测试不只断言任意差异 | changed/missing/duplicate budget 与 synchronized budget bias 测试断言 `contextBudget.used`、`displayUsed`、`breakdown.total` 等具体 path | 已关闭 |
| 原始 request 不变、预算及明细同步篡改可检出 | `test_baseline_contract_rejects_synchronized_budget_bias_for_unchanged_request`：raw request 相同，`used` 与 breakdown 同步伪造，仍逐值失败 | 已关闭 |
| 合法 request composition drift 不隐藏预算语义 | 只有 canonical request 相同、raw request 存在声明差异且 current breakdown 非负、组件和与 `used` 一致时才比较共同 decision fields；缺失/错误 breakdown 保持失败 | 已关闭 |

## 完整验证证据

- `pnpm build`（Node 22）：PASS。
- `pnpm test`：`1721 passed`、`0 failed`、`2 skipped`；此前一次并发偶发失败已由同一 dist 单文件 5/5 和完整套件重跑 `1721/1723` 复核通过，未改断言掩盖。
- `pnpm --filter @pilotdeck/sdk test`：`123/123`。
- focused production module/Gateway/SDK seed suites：`135/135`。
- comparator unit suite：`51/51`。
- 既有 production raw traces 重评（无重采集）：53 scenarios、53 native/sidecar pairs、68 baseline pairs、9 declared extensions；`oracle=0`、`proof=0`、`failure=0`。
- `git diff --check`：PASS；最终 commit 已推送，远端 ref 与本地一致。

## 明确不适用 / 未覆盖

以下不是当前 PilotDeck-only production matrix 的 PASS，不得被报告为已覆盖：真实外部 provider 行为、StaffDeck Harness/TaskFrame/SOP lease/fencing、remote/queued deployment、Desktop 原生视觉检查，以及需要独立外部服务的 deployment E2E。main 缺少对应能力的 19 个 baseline 场景已逐项记录为 `notApplicable`，不计入 PASS：

`plan_mode_host_policy`、`plan_mode_bypass_host_policy`、`sidecar_budget_limit`、`sidecar_elicitation`、`sidecar_elicitation_execution`、`sidecar_sdk_tool_progress`、`sidecar_durable_compaction`、`sidecar_full_request_compaction_budget`、`sidecar_projected_request_compaction_budget`、`sidecar_seed_read_state`、`sidecar_empty_system_prompt`、`sidecar_additional_working_directories`、`sidecar_continuable_followup_live`、`sidecar_continuable_followup_cold`、`sidecar_parent_close_after_admission`、`sidecar_one_shot_subagent_success`、`sidecar_one_shot_subagent_failure`、`sidecar_one_shot_parent_abort_after_admission`、`sidecar_one_shot_parent_close_after_admission`。

## 阻断清单

以下账本覆盖原始 goal 优先指出的九类问题；每项都保留触发条件、影响、证据、根因状态、owner、下一步和关闭条件。`已关闭` 不等于删除历史问题，后续 merge 仍需复用对应回归。

| 状态 | 触发条件 / 影响 | 根因状态与 owner | 证据 | 下一步 / 关闭条件 |
| --- | --- | --- | --- | --- |
| 已关闭 | production sidecar recovery compaction 在 model prepare 后 replacement；可能丢失 preparation identity 或使用错误生命周期 | 已证实：preparation reference 属于 host model adapter，不能写入 frozen canonical request；owner 为 model adapter / host dispatcher | `materialize_prepared_request` focused tests、full/projected compaction budget、raw sidecar module proof | 无新增动作；关闭条件是 preparation reference 生命周期与 native/sidecar raw trace 持续一致 |
| 已关闭 | `closeSession` 返回后 pending creation/admission 继续 submit；可能产生旧 session turn/副作用 | 已证实：admission reservation/fence 需要由 Gateway/Session owner 统一 settlement；owner 为 Gateway admission | sdk-controls、creation/close、production parent-close traces | 无新增动作；关闭条件是 close 后旧 admission 不能提交或产生副作用 |
| 已关闭 | SDK control busy 检查后新 turn 进入，再被 close 清除；可能丢控制操作或 turn | 已证实：control 与 turn admission 必须共享 session reservation；owner 为 Gateway control admission | SDK config/MCP/seed/flag concurrency tests、root suite | 无新增动作；关闭条件是 barrier 交错下 control/turn/close 因果稳定 |
| 已关闭 | seed/MCP/config rebuild 或 plan entry/exit 丢 current/base permission mode；permission RPC 进入 plan 时丢 base mode | 已证实：live mode 属于 Gateway session permission registry，wire override 不是第二 owner；owner 为 permission registry | permission roundtrip、dirty recreate、plan-mode parity、sidecar permission tests | 无新增动作；关闭条件是所有入口/失败/重建/退出保留 mode |
| 已关闭 | admission 异常退出泄漏 reservation/fence；后续 turn 可能永久 busy 或绕过 fence | 已证实：异常路径缺少统一 unwind；owner 为 admission actor/Gateway finally cleanup | pending creation/config/attachment/model-selection tests、root suite | 无新增动作；关闭条件是异常、取消、close、dispose 均释放 reservation/fence |
| 已关闭 | sidecar error-only terminal 丢原始 provider/module error 分类；用户只能看到泛化失败 | 已证实：terminal projection 必须保留 source code/retryability；owner 为 operation terminal host owner | llm failure tests、tool/permission error parity、sidecar terminal tests | 无新增动作；关闭条件是 error-only、result_unknown、failed/cancelled 分类可重放 |
| 已关闭 | comparator 只看事件位置或无条件剥离 usage，可能隐藏 self-consistent budget bias | 已证实：budget 必须先绑定所属 request；usage 归一化受声明 raw request drift 与完整 breakdown 限制；owner 为 parity comparator | `51/51` unit、validation-disabled expected failure、unchanged-request synchronized tamper、53-trace re-evaluation | 无新增动作；关闭条件是新 budget 字段或 normalization 变更先通过同一负向门槛 |
| 已关闭 | runtime-context 在 block/message 间重排或残余内容漏检；可能改变 provider-visible prompt 顺序 | 已证实：request-only projection 需要跨容器顺序和未知残余校验；owner 为 Context runtime/comparator contract | runtime-context positive/negative tests、default-factory tests、raw request re-evaluation | 无新增动作；关闭条件是重复标签、未知残余、非文本 block、顺序错误持续失败 |
| 已关闭 | lifecycle actor 分离后 close/abort 与后续 model request 或副作用缺少因果约束 | 已证实：settlement boundary 必须阻止 late model request；owner 为 operation ledger/Gateway fence | close/abort late-request test、partial-order checks、sidecar reconnect/replay traces | 无新增动作；关闭条件是 admission、durable commit、close/abort、terminal、副作用的必要 happens-before 保持 |

当前没有未解释的 P1/P2、semantic FAIL、oracle failure 或 architecture violation。外部 provider/deployment/StaffDeck/Desktop 范围属于明确未覆盖项，不是被测试绿灯隐式关闭的阻断；若将其纳入验收，需要新增产品入口、环境和对应 oracle。
