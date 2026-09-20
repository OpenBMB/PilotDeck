# SDK/Core Merge 回归与 Sidecar 语义收口报告（2026-09-18）

## 固定基线

- 工作区：`PilotDeck-sdk-core-integration`
- 当前分支：`codex/integrate-sdk-0901`
- 开始时当前 commit：`148a7bd6c823235ea0d63fe0b2b939fd223d5e06`
- 开始时 `origin/main`：`cd52c9af812a84c27a9dd1b7ccf246f48540045f`
- 架构基线：`Kaguya-19/refactor/core_agent_loop_0831`，commit `e55b0a82d07ee3951e5812c34103400dfa6043f7`

### 2026-09-19 严格 comparator 复核固定点

- 本轮开始时当前分支 commit：`2a767d95b21bd66215a3c65ebdd92159ad6fa156`
- 本轮固定 `origin/main`：`cd52c9af812a84c27a9dd1b7ccf246f48540045f`（fetch 后未变化）
- 架构基线保持：`e55b0a82d07ee3951e5812c34103400dfa6043f7`
- 保留并复核工作区既有 comparator 改动；本轮只增加 budget breakdown 关联修复及其负向测试。

开始时工作区无未提交改动。已将 origin/main 的 crash-safe compaction 合并到当前分支；合并冲突只涉及 transcript persistence/replay/fork 与 TurnRunner，并按当前 Session/EventStore owner 解决。

## 行为与架构契约

main 是共有可观察行为基准；core_agent_loop_0831 是依赖方向与状态 owner 基准。AgentLoop 只消费 `AgentTurnCapabilities` 的窄 ports；Router、SessionRuntime、Gateway、Plugin aggregate 和 host dependency bag 只存在于 native/host adapter 或 application composition。sidecar wire 只携带 canonical request、capability manifest、可序列化 projection 和 operation identity；Session transcript、turn inbox、permission mode、provider preparation、资源 lease 与 dispose 仍由原 host/module owner 持有。

## 发现与处理清单

| 触发条件 / 入口 | main / native / sidecar 行为 | 根因与 owner | 回归与处理 |
| --- | --- | --- | --- |
| production sidecar recovery compaction；model prepare 后发生 replacement | main/current native 使用准备引用重建 request；sidecar 必须经 `materialize_prepared_request`，不传 opaque routing state | preparation reference 只在 host model adapter 的 `WeakMap`；修复前 materialization 会向 frozen request 写 identity | `llm-model-port`、full-request compaction budget、stdio parity；改为 request identity `WeakMap`，不修改 canonical request |
| closeSession 返回后 creation/admission 继续 submit | 三路径均 fail-closed，不产生新 turn/副作用 | Session/Gateway admission fence owner；保留已有 completion fence 与 creation reservation | `sdk-controls`、`abort_turn prevents submit while session_creation is pending`；通过 |
| SDK control busy check 与新 turn 交错 | control 与 turn admission 共享 session reservation；close/abort 等待既有 admission | Gateway control admission owner；未把 busy check 移到 SDK client | `sdk-controls` config/MCP/seed/flag 并发场景；通过 |
| seed/MCP/config 重建、plan entry/exit | current/base permission mode 在重建、失败、退出中保持 host-owned 值 | mode state 属于 Gateway session permission registry；wire override 只表示 user-owned rules | permission roundtrip、dirty recreate、plan-mode parity；通过 |
| admission 异常退出 | reservation/fence 在失败和 abort finally 清理 | admission actor 曾缺少统一 unwind；修复保留在 Gateway/session owner | pending creation/config/attachment/model selection tests；通过 |
| sidecar error-only terminal | 原始 provider/module error code、retry metadata 与 terminal outcome 保留 | terminal projection 丢失 source error 分类 | llm port failure tests、tool error/permission denial parity；通过 |
| budget comparator 偏差 | budget 绑定所属 model request，缺失/重复/篡改失败 | comparator 以前只比较事件位置，隐藏了 request-level 偏差 | negative-control harness 与 full-request compaction budget；通过 |
| runtime-context 跨 block/message 顺序 | runtime context 作为 request-only projection，下一次 prepare 替换旧快照 | canonicalization 没有检查重复标签/未知残余/非文本 block | default-factory runtime-context tests 与 comparator negative controls；通过 |
| lifecycle actor 分离后的 close/abort 因果 | admission、durable commit、close/abort、副作用保留必要 happens-before | actor 之间只比较事件数，缺少 fence/terminal 约束 | completion-fence、operation-deadline、sidecar reconnect/replay；通过 |
| replace-last-turn 发生在 Router admission 与 Gateway completion fence 安装之间 | native replacement 必须 abort 同一 admitted run 并等待 close；过期 replacement 不得触及新 run | `abortTurn` 仅以本地 fence 决定是否 abort，漏掉 Router 已持有但尚未建 fence 的短窗口；Router 仍是 active-run owner | `replace-last-turn` 与 `gateway-turn-completion-fence` 20/20；仅在 Router active runId 精确相等时补 abort |
| SDK Hooked turn 在历史压力下自动 compaction | 生产 Gateway/stdio/native 均经默认 Context/CompactionEngine 发出成对 PreCompact/PostCompact，并完成 turn | 旧 E2E fixture 的有效请求预算不足，断言没有真正经过 compaction 路径 | SDK compaction E2E 通过 config reload 将下一 turn 设为 16k；验证 WebSocket Gateway、hook start/response、`auto_compact` 状态及 completed terminal |
| origin/main crash-safe compaction 合并 | snapshot 记录在 durable boundary 中原子可见；截断/重启保留旧 context | 当前分支原有 `replacementMessages` + EventStore；直接采用 main writer 会绕过现有 owner | `compact-snapshot-crash`、replay、fork、replacement failure `21/21`；新增 `snapshot v1`，JSONL persistence 对 boundary fsync 并修复断尾 |

### 严格 comparator 收口（2026-09-19）

| 触发条件 / 入口 | main / native / sidecar 行为 | 根因与 owner | 回归与处理 |
| --- | --- | --- | --- |
| raw model request 因 SDK 工具/runtime projection 不同而产生 context budget usage 漂移 | 三侧的 limit、state、输出一致；合法 composition drift 只比较 decision fields | runner gate 不再按 path 后缀无条件放行；adapter 使用共有 `TokenBudgetManager`/o200k request breakdown 独立生成 request-linked evidence | 保留 breakdown 并校验组件非负、组件和、`used == total`；只有 evidence 与 provider-visible request、breakdown、usage 一致绑定时才剥离 usage；`50→80`、`displayUsed/budgetUsed=9999`、缺失 evidence、预算生成前篡改均有负向测试；两个受影响 raw traces 已重跑通过 |
| runtime-context 跨 block/message 顺序、close/abort settlement 后 late model request | 两侧保持内容/顺序与 settlement happens-before；非法重排或 settlement 后请求失败 | comparator 以前按 block 内 offset 丢失跨容器顺序，且没有 settlement fence 检查 | 顺序、重复/残余、close/abort late request 负向测试；production raw trace 覆盖 native 与正式 stdio sidecar |

## 验证命令

- `pnpm build`（Node 22）
- `pnpm test`（Node 22）：`1721` passed、`0` failed、`2` skipped（既有跳过）
- focused production module/Gateway/SDK seed matrix：`192/192`
- compaction/replay/fork/deferred failure：`21/21`
- `pnpm --filter @pilotdeck/sdk test`：`123/123`
- `python3 -m unittest discover -s tools/agent-loop-parity -p 'test_trace.py'`：`53/53`
- `node --test tools/agent-loop-parity/test_budget_evidence.mjs`：`2/2`
- production stdio parity：53/53 场景执行；`failed=[]`、`blocked=[]`、`oracleFailures=[]`、`knownGaps=[]`；34 个 baseline applicable，19 个明确 `notApplicable`。`deadline`、`deadline_during_tool`、`auto_compact`、`sidecar_live_steer` 的 baseline drift 均仅命中已声明 extension contract。原始结果：`/tmp/pilotdeck-parity-merge-closure-20260918/summary.json`。
- 2026-09-19 严格 comparator production stdio parity：53/53；`failed=[]`、`blocked=[]`、`oracleFailures=[]`、`knownGaps=[]`；34 个 baseline applicable、19 个明确 `notApplicable`，9 条 extension 均逐路径命中声明契约。原始结果：`/tmp/pilotdeck-parity-closure-20260919-strict2/summary.json`。
- Node 22 focused production module/Gateway/SDK seed matrix：`135/135`；根测试最终重跑：`1721/1723`，`0` failed、`2` skipped，退出码 0。日志：`/tmp/pilotdeck-root-test-20260920-final-retry.log`。

## 架构检查

`AgentLoop.ts` 无 Router、SessionRuntime、Gateway、Plugin registry 或 AgentRuntimeDependencies import；sidecar composition 仅接收显式 consumer ports。preparation identity、compact snapshot、fork path rewrite 分别归 model adapter、Session persistence/projection、Node fork owner；没有新增重复 Session/permission/turn state owner。

## 未覆盖范围

真实外部 provider、StaffDeck Harness/TaskFrame/SOP lease、remote/queued deployment 与 Desktop/Web UI 视觉检查不属于本 PilotDeck-only production matrix；这些不计为 PASS，沿用 roadmap 的未覆盖声明。
