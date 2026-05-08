# Always-On 测试用例与双边 Parity 方案

本文定义 PolitDeck Always-On 模块的测试维护方案。配套设计见 `02-politdeck-always-on-rewrite-plan.md`。

核心原则：不能因为新实现“看起来像旧实现”就声明一致。只有同一套共享 scenario 同时在旧项目（`third-party/claude-code-main`）和 PolitDeck 中运行，并比较归一化输出后，才能声明对应 parity passed。新方案对旧实现做了若干 intentional difference（每次 fire 至多 1 plan、plan markdown 章节集合更换、自动在隔离环境执行、配置去掉 `discovery` 包装层等），这些差异在本文用 `intentional_difference` 状态明确登记，绝不通过把测试改宽来掩盖。

## 1. 测试目标

Always-On 测试覆盖六类行为：

- **配置与协议**：`alwaysOn` flat 配置解析、默认值、被移除字段的诊断、`AlwaysOnDiscoveryState` / `AlwaysOnChannelLease` / `DiscoveryPlanRecord` / `DiscoveryRunHistoryEvent` / `WorkspaceHandle` 等类型。
- **调度决策**：lease 新鲜度、gate 顺序与 reason、lock 抢占、cooldown、daily budget、`workspace_capacity`、`dormant_no_signal`。
- **静默与文件信号**：`SignalWatcher` 启停、去抖、ignore glob、降级轮询、watcher 在 server 重启时的恢复。
- **Plan 与 Report 契约**：`PlanContract` 章节集合与字段约束、`AlwaysOnDiscoveryPlanTool` 的 `plan_quota_exhausted`、`ReportContract` 兜底。
- **隔离环境**：`WorkspaceProvider` 接口、`GitWorktreeProvider`、`SnapshotCopyProvider`、`WorkspaceProviderRegistry` 的优先级与 `workspace_unavailable`。
- **Runtime 全链路**：`AlwaysOnRuntime` 的四种 outcome（`executed` / `no_plan` / `failed` / `workspace_unavailable`）、`bypassPermissions` 模式断言、`cwd` 在隔离基址下的断言、`state.json` 与 `run-history.jsonl` 落盘形态。

## 2. 测试分层

```text
unit tests
  -> config / paths / state store / plan store / report store
  -> discovery prompt
  -> PlanContract / ReportContract
  -> gates / lock / daily budget / dormancy 状态机
  -> SignalWatcher
  -> WorkspaceProviderRegistry / GitWorktreeProvider / SnapshotCopyProvider

runtime integration tests
  -> AlwaysOnRuntime + fake Gateway + fake WorkspaceProvider
  -> AlwaysOnRuntime + InProcessGateway + fake AgentSession + 真实 GitWorktreeProvider（临时仓库）
  -> AlwaysOnRuntime + GatewayServer (ephemeral) + RemoteGateway

dual parity tests
  -> shared scenarios
  -> legacy report runner（旧项目 bun run）
  -> PolitDeck report runner（新项目 node 脚本）
  -> normalized deepEqual
```

底层 contract / store / watcher / provider 单测禁止启动 server，禁止真实联网。Runtime 集成测试可以启动 ephemeral `GatewayServer`，但必须用本机临时目录与 fake model。Dual parity 测试必须执行旧项目的真实代码路径（通过 `bun run` 或 `bun test`），不能只复制旧期望值。

## 3. 建议测试目录

```text
tests/fixtures/always-on/
  dual-parity/
    configScenarios.ts
    gateScenarios.ts
    promptScenarios.ts
    legacyPlanContractScenarios.ts        仅用于 legacy 端契约登记（PolitDeck 不再 compare）
    legacyDiscoveryRequestScenarios.ts    同上，用于显式登记 intentional_difference
  runtime/
    runtimeOutcomeScenarios.ts
  workspace/
    gitWorktreeScenarios.ts
    snapshotCopyScenarios.ts
  signal/
    signalWatcherScenarios.ts

tests/helpers/
  alwaysOnConfigReport.ts
  alwaysOnGateReport.ts
  alwaysOnPromptReport.ts
  legacyPlanContractReport.ts             只产出 legacy 行为快照
  alwaysOnRuntimeHarness.ts               提供 fake Gateway + fake WorkspaceProvider
  alwaysOnWorkspaceHarness.ts             起一次性 git 仓库 / 临时项目目录
  normalizeAlwaysOnReport.ts

tests/always-on/
  config.test.ts
  paths.test.ts
  discovery-state-store.test.ts
  discovery-plan-store.test.ts
  discovery-report-store.test.ts
  discovery-prompt.test.ts
  discovery-gates.test.ts
  signal-watcher.test.ts
  plan-contract.test.ts
  plan-tool.test.ts
  report-contract.test.ts
  report-tool.test.ts
  workspace-git-worktree.test.ts
  workspace-snapshot-copy.test.ts
  workspace-registry.test.ts
  always-on-runtime.test.ts
  parity-dual-config.test.ts
  parity-dual-gates.test.ts
  parity-dual-prompt.test.ts
  parity-dual-legacy-plan-contract.test.ts

third-party/claude-code-main/src/
  politdeck-always-on-legacy-config-report.ts
  politdeck-always-on-legacy-gate-report.ts
  politdeck-always-on-legacy-prompt-report.ts
  politdeck-always-on-legacy-plan-contract-report.ts
```

仓库已有同模式可参考：

- `tests/tool/parity-dual-execution.test.ts` 用 `execFileSync("bun", ["run", ...])` 跑旧项目 report，再与 PolitDeck report 比较。
- `tests/agent/parity-dual-contract.test.ts` 要求 scenario id 唯一、所有非 `compare` 场景必须有 reason、固定 id 必须出现在 compare 集合。
- `tests/gateway/remote-gateway.test.ts` 用 ephemeral `GatewayServer` + `GatewayWsClient` + `RemoteGateway` 验证流式事件。

Always-On 测试沿用这些约定。

## 4. Scenario 格式与状态分类

```ts
export type AlwaysOnParityStatus =
  | "compare"
  | "intentional_difference"
  | "not_applicable";

export type AlwaysOnParityScenario<TInput> = {
  id: string;
  status: AlwaysOnParityStatus;
  reason?: string;
  input: TInput;
};
```

规则：

- `id` 必须唯一。
- `status !== "compare"` 时必须写 `reason`，并指向 `02-politdeck-always-on-rewrite-plan.md` 的 Feature Classification 行。
- `compare` 场景必须同时出现在 legacy report 与 PolitDeck report，归一化后 deepEqual。
- `intentional_difference` 场景至少在 legacy report 中产出快照，以便 review 差异；PolitDeck 端可以选择不产出，也可以产出但必须在测试中显式跳过 deepEqual。
- `not_applicable` 场景不产出 legacy report，仅用于在 manifest 中保留登记。
- 禁止用 `deferred` 状态遮盖未实现：本模块不引入分阶段实施，未实现等同未通过。

manifest 测试统一断言：

- id 集合无重复。
- 所有非 `compare` 场景含 reason。
- 至少包含本节列出的固定 id（用于防止删测）：
  - `config-defaults-trigger`
  - `gate-disabled`
  - `gate-project-disabled`
  - `gate-no-fresh-lease`
  - `gate-agent-busy`
  - `gate-cooldown`
  - `gate-daily-budget`
  - `gate-lock-busy`
  - `prompt-english-default`
  - `prompt-zh-cn`
  - `legacy-plan-three-plans-snapshot`（intentional_difference）
  - `legacy-discovery-request-flow-snapshot`（intentional_difference）

## 5. Contract Parity 与 Execution Parity

### Contract parity passed

仅当以下内容用共享 scenario 验证通过，才可声明 contract parity passed：

- `alwaysOn` flat 配置默认值与字段名（`trigger` / `dormancy` / `workspace` / `execution` / `projects`）。
- `GateBlockReason` 枚举（compare 子集：`disabled` / `project_disabled` / `project_missing` / `no_fresh_lease`<sub>=legacy `no_fresh_heartbeat`</sub> / `agent_busy` / `recent_user_msg` / `cooldown` / `daily_budget` / `lock_busy`）。
- discovery prompt 文本（中英文模板的关键片段）。
- legacy 端 plan 工具的 schema 与 markdown 必填章节（仅 legacy 报告，作为对照登记，不要求 PolitDeck 对齐）。

Contract parity 不要求实际执行 discovery turn。

### Execution parity passed

仅当旧项目和 PolitDeck 对同一输入都实际执行，并且归一化输出 deepEqual，才可声明 execution parity passed。

适合 execution parity 的场景：

- 给定 lease/heartbeat、state、config，gate 返回同一结果（reason 与是否选中 lease）。
- 给定 projectRoot、language hint，prompt 文本相同（去掉随机化字段后 deepEqual）。
- 给定相同 YAML 配置，配置解析结果 deepEqual（在 `preferClient` ↔ `preferChannel` 的 adapter 归一化下）。

不适合 execution parity 的场景（必须登记为 `intentional_difference`）：

- 旧 plan 工具一次最多 3 plan、含 `approvalMode` / `supersedesPlanIds` / `contextRefs` 等字段；新工具一次至多 1 plan、章节集合不同。
- 旧 discovery request 文件 + TUI 5s 轮询 ack `started`；新实现由 server 直接 `Gateway.submitTurn()`。
- 旧实现仅保存 plan，由用户手动触发执行；新实现自动在隔离环境内 `bypassPermissions` 模式执行并产出 work report。
- 旧 cron daemon / cron 调度 / cron run history。这些在 PolitDeck 不存在，直接登记为 `not_applicable`，不参与 parity。

## 6. 必测用例清单

### Config

PolitDeck 端用例：

- 无配置时，`trigger` 默认 `enabled: false` / `tickIntervalMinutes: 5` / `cooldownMinutes: 60` / `dailyBudget: 4` / `heartbeatStaleSeconds: 90` / `recentUserMsgMinutes: 5` / `preferChannel: web`；`dormancy.enabled: true`、`dormancy.debounceMs: 2000`；`workspace` / `execution` 段使用方案默认值；`projects` 为空对象。
- 项目路径归一化为 absolute resolved path。
- `projects.<root>` 仅 `enabled` 起作用；出现 `sessionKey` / `workspace` 等字段必须给出明确诊断或被忽略并记录 warning。
- 出现已被移除的字段必须诊断：
  - `alwaysOn.discovery` 包装层
  - `alwaysOn.workspace.strategy`
  - `alwaysOn.plan`
  - `alwaysOn.execution.permissionMode`
- 数值字段非正数回退默认值。
- 不允许 `bindAddress` 之类与 gateway 段重合的字段在 `alwaysOn` 段下出现。

Parity：

- `config-defaults-trigger` 为 `compare`：仅比对 `trigger` 子段中与 legacy 重叠的字段（不含 `preferChannel`）。
- `config-prefer-client-vs-channel` 为 `intentional_difference`：legacy `preferClient: webui|tui` 对应 PolitDeck `preferChannel: web|tui|cli|feishu|...`。
- `config-flat-no-discovery-wrapper` 为 `intentional_difference`：登记 PolitDeck 不再有 `discovery` 包装层这一事实。
- `config-removed-fields-diagnostic` 为 `not_applicable`：legacy 不报错，PolitDeck 必须报错或 ignore，登记差异理由。

### Gates

PolitDeck 端用例：

- 全局未启用：`disabled`。
- 项目未启用：`project_disabled`。
- 项目路径不存在：`project_missing`。
- 静默期内无变化：`dormant_no_signal`（PolitDeck-only）。
- 无 lease 或 lease 已过期：`no_fresh_lease`。
- agent busy：`agent_busy`（任一新鲜 lease `agentBusy === true` 或 `SessionRouter` 报告目标 sessionKey in-flight，二者任一即触发）。
- 最近用户消息：`recent_user_msg`。
- cooldown 未过：`cooldown`。
- 当日预算耗尽：`daily_budget`。
- 隔离环境上限：`workspace_capacity`（PolitDeck-only）。
- lock 占用：`lock_busy`。
- 通过：返回被选中的 lease；多 lease 同时新鲜时优先 `preferChannel`，同 channel 取最新 `writtenAt`。

Parity：

- `gate-disabled` / `gate-project-disabled` / `gate-project-missing` / `gate-agent-busy` / `gate-recent-user-msg` / `gate-cooldown` / `gate-daily-budget` / `gate-lock-busy` 为 `compare`。legacy `no_fresh_heartbeat` 与 PolitDeck `no_fresh_lease` 通过 adapter 归一化为同一 reason 名 `no_fresh_lease` 后做 `compare`，归一化只发生在 report 输出端。
- `gate-dormant-no-signal` / `gate-workspace-capacity` 为 `not_applicable`，理由：legacy 不存在该 gate。
- `gate-pass-prefer-channel` 为 `intentional_difference`：选中规则与 `preferClient` 对齐，但字段名变更。

### Prompt

PolitDeck 端用例：

- 默认英文 prompt 包含 `Always-On discovery planning`、`recent chats win`、`final reply`。
- `zh-CN` prompt 包含 `Always-On 主动发现规划`、`近期聊天语言为准`、`最终回复`。
- 未知语言回退英文。
- prompt 不再要求“最多 3 plan”或“`## Approval And Execution`”章节字眼，应明确指示“一次至多 1 份 plan”与新章节集合（PolitDeck-only）。

Parity：

- `prompt-english-default` / `prompt-zh-cn` 为 `compare`：仅比对与 legacy 共享的固定关键片段（`Always-On discovery planning`、`recent chats win` 等）。其余差异部分（章节集合、plan 数量限制）通过 normalization 抽离后比较，或单独标 `intentional_difference`。
- `prompt-section-instruction-set` 为 `intentional_difference`：登记“章节指令文本”差异。

### PlanContract / Discovery Plan Tool

PolitDeck 端用例：

- 合法 markdown 入库：6 个章节齐全 + 元信息 blockquote 完整 + Execution Steps 为有序列表 + Verification 为无序列表。
- 缺任一章节直接拒绝（`Summary` / `Rationale` / `Context Signals` / `Proposed Change` / `Execution Steps` / `Verification`）。
- 出现额外二级章节（如 `Rollback`、`Risks`、`Approval And Execution`）直接拒绝。
- 重复章节拒绝。
- `Execution Steps` 缺有序列表项拒绝；混用无序列表拒绝。
- `Summary` 超过 200 字符拒绝。
- 元信息 blockquote 缺 `id` / `sourceRunId` / `createdAt` / `projectRoot` / `dedupeKey` 任一拒绝。
- 同一 fire 第 2 次工具调用返回 `plan_quota_exhausted` 错误。
- 文件大小超过 `maxResultSizeChars` 拒绝。
- 工具权限固定 `allow`，不弹窗。
- 写入后 `plans/index.json` 中出现一条 `DiscoveryPlanRecord`，且 `planFilePath` 在 `${POLIT_HOME}/always-on/projects/<projectId>/plans/<planId>.md` 之下。

Legacy 端登记（不要求 PolitDeck compare）：

- legacy 工具 schema 含 `approvalMode` / `supersedesPlanIds` / `contextRefs`，每次最多 3 plan。
- legacy plan markdown 必填章节为 `## Context` / `## Signals Reviewed` / `## Proposed Work` / `## Execution Steps` / `## Verification` / `## Approval And Execution`。

Parity：

- `legacy-plan-three-plans-snapshot` / `legacy-plan-required-sections-snapshot` / `legacy-plan-approval-mode-snapshot` 全部为 `intentional_difference`。在 manifest 中存在以提醒差异，但不参与 deepEqual。
- 所有 PolitDeck plan 用例本身在 PolitDeck 测试中独立验证，不与 legacy 比对。

### ReportContract / Report Tool

PolitDeck 端用例（legacy 无对应能力，全部 `not_applicable`）：

- 合法 work report 入库，元信息 blockquote 含 `runId` / `planId` / `startedAt` / `finishedAt` / `outcome` / `workspaceStrategy` / `workspaceHandle`。
- 缺章节（`Plan Reference` / `Steps Performed` / `Files Changed` / `Command Output` / `Verification Results` / `Follow-ups` / `Notes`）由兜底逻辑补齐，并在 `Notes` 中写明兜底原因。
- 缺工具调用：runtime sweep 检测后写一份 `outcome: failed`、`Steps Performed: <empty>` 的占位 report，理由记录在 `Notes`。
- `workspaceStrategy` 仅允许 `git-worktree` / `snapshot-copy`。出现 `inplace` 等其他值视为非法。

### SignalWatcher

PolitDeck 端用例（legacy 无，全部 `not_applicable`）：

- 启动后立即建立基线，启动瞬间发生的事件被忽略。
- 同路径多次事件在 `dormancy.debounceMs` 窗口内仅触发一次唤醒。
- 命中 `dormancy.ignoreGlobs` 的路径不触发唤醒（`.git/`、`node_modules/`、`${POLIT_HOME}/always-on/**`、项目内 `.politdeck/**`、`dist/`、`.DS_Store` 等）。
- 项目根被删除：watcher 停下，下次 gate 评估返回 `project_missing`。
- `fs.watch` 不可用时降级为 mtime 轮询，扫描周期不超过 `tickIntervalMinutes`。
- server 重启后，从 `state.dormant` 恢复 watcher；恢复失败时降级为非 dormant。

### WorkspaceProvider

PolitDeck 端用例：

`GitWorktreeProvider`：

- `isApplicable` 在临时 git 仓库中返回 true；非 git 目录返回 false；存在未完成 rebase / merge 时返回 false。
- `prepare` 创建 detached worktree，`cwd` 落在 `${POLIT_HOME}/always-on/worktrees/<projectId>/<runId>`。
- `prepare` 在 `git status --porcelain` 非空时按策略 dirty 拒绝并返回受控错误。
- `dispose` 调用 `git worktree remove --force`；失败时降级 `rm -rf` + `git worktree prune`。
- 子模块在不可 `--recurse-submodules` 时返回 false 并触发 registry 降级。

`SnapshotCopyProvider`：

- macOS 上优先 `clonefile`（`cp -c`）；不支持时降级。
- Linux 上优先 `cp --reflink=auto`；不支持时降级 `fs.cp`。
- 全部失败时调用 `rsync -a --exclude-from=...`。
- 跨设备路径强制降级到非 reflink 实现。
- 大小预估超过 `workspace.snapshotMaxBytes`（默认 1 GiB）直接 `prepare` 失败。
- `dispose` 严格清理 target 目录；`retainSuccessfulEnvs` / `retainFailedEnvs` 控制保留。
- 应用 ignore 列表：`.git/`、`node_modules/`、`dist/`、`.politdeck/`、`${POLIT_HOME}/always-on/` 路径。

`WorkspaceProviderRegistry`：

- git 适用时优先返回 `GitWorktreeProvider`。
- git 不适用且 snapshot 适用时返回 `SnapshotCopyProvider`。
- 两者都不适用时 `prepare` 阶段抛 `workspace_unavailable`，runtime 必须把它转成 outcome `failed`。
- 优先级是 provider 自身的 `priority`，不读取任何 strategy 配置；不允许通过环境变量或配置强制覆盖。

Parity：全部 `not_applicable`，理由：legacy 无 `WorkspaceProvider` 概念。

### Runtime

PolitDeck 端用例（legacy 链路差异巨大，整体 `intentional_difference`）：

- `start` 加载启用项目，注册 tick；`stop` 释放 timers / watchers / worktrees / snapshots。
- gate 不通过：不调用 gateway、不写 lock、不消耗 `dailyBudget`，状态保持。
- gate 通过 + 0 plan：`outcome: no_plan`、写 `state.lastFireOutcome`、进入 dormancy（`state.dormant.since` 设为 now）、释放 lock；不调用 `WorkspaceProvider.prepare`。
- gate 通过 + 1 plan + workspace 可用：调用 `gateway.submitTurn`，提交参数中：
  - `mode === "bypassPermissions"`
  - `cwd === workspace.cwd` 且 `workspace.cwd` 在 `${POLIT_HOME}/always-on/{worktrees,snapshots}` 之下
  - `sessionKey === deriveExecutionSessionKey(projectKey, runId)`
- 执行 turn 完成：写 `outcome: executed`，`run-history.jsonl` 追加事件，work report 入库。
- 执行 turn 中 `Gateway` 抛错：`outcome: failed`，`consecutiveFailures + 1`，仍写 work report 兜底。
- workspace 不可用：直接 `outcome: failed`、`error.code: "workspace_unavailable"`，plan 状态 `failed`，work report 兜底。
- 同项目并发 tick：第二次 tick 立刻返回 `lock_busy`。
- runtime sweep：执行 turn 结束若 `cwd` 不在隔离基址下，强制 `outcome: failed`，并在 `Notes` 中记录原因。
- 所有 outcome 必须落到 `state.json` 与 `run-history.jsonl`。

Parity：

- `runtime-no-plan-enters-dormancy` / `runtime-executed-git-worktree` / `runtime-executed-snapshot` / `runtime-workspace-unavailable` / `runtime-cwd-isolation-asserted` 全部 `not_applicable`，理由：legacy 不自动执行。
- 在 PolitDeck 内部加做 transport-symmetric：同一 fake session 脚本下，runtime 通过 `InProcessGateway` 直连与通过 ephemeral `GatewayServer` + `RemoteGateway` 跑出的事件序列在归一化后 deepEqual。这里复用 `02` 中提到的 synthetic `turn_completed` final frame 处理：必须在归一化阶段把 over-WS 末尾的 synthetic frame 与真实 `turn_completed` 区分，再做 deepEqual。

## 7. 双边 Report 设计

### Config report

```ts
type AlwaysOnConfigReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    trigger: {
      enabled: boolean;
      tickIntervalMinutes: number;
      cooldownMinutes: number;
      dailyBudget: number;
      heartbeatStaleSeconds: number;
      recentUserMsgMinutes: number;
      preferChannel: string;     // legacy preferClient 在 adapter 中映射成 preferChannel
    };
    projects: Record<string, { enabled: boolean }>;
  };
  reason?: string;
};
```

PolitDeck 端 report 直接由 `parseAlwaysOnConfig` 输出归一化结果。Legacy 端 report 用 `loadEdgeClawConfig().alwaysOn.discovery` 与 `loadEdgeClawConfig().alwaysOn.discovery.projects` 拉平后再生成同结构。`compare` 项 deepEqual `result`。

### Gate report

```ts
type AlwaysOnGateReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    ok: boolean;
    reason?: string;        // legacy 'no_fresh_heartbeat' 在 adapter 中归一化为 'no_fresh_lease'
    selectedChannelKey?: string;
    selectedWriterId?: string;
  };
  reason?: string;
};
```

### Prompt report

```ts
type AlwaysOnPromptReport = {
  id: string;
  status: AlwaysOnParityStatus;
  result?: {
    language: "en" | "zh-CN";
    sharedKeyPhrases: string[];   // 仅比对共享关键片段
    promptHash?: string;          // 整体 prompt 的稳定 hash，用于 intentional_difference 登记
  };
  reason?: string;
};
```

`compare` 场景仅 deepEqual `sharedKeyPhrases` 集合；整 prompt 文本差异通过 `promptHash` 单独记录，便于发现回归而不强制对齐。

### Legacy plan contract report

```ts
type LegacyPlanContractReport = {
  id: string;
  status: "intentional_difference";
  result: {
    schemaShape: {
      maxPlansPerCall: number;             // legacy = 3
      hasApprovalMode: boolean;            // legacy = true
      hasSupersedesPlanIds: boolean;       // legacy = true
      hasContextRefs: boolean;             // legacy = true
    };
    requiredSections: string[];            // legacy = ["## Context", ..., "## Approval And Execution"]
  };
  reason: string;
};
```

只在 legacy 端产出。本 report 用于在每次跑 parity 时显式打印“你正在偏离的旧契约”，避免 PolitDeck 后续误以为旧实现也变了。

PolitDeck 不输出对应 plan report；plan 行为由 PolitDeck 内单测覆盖，详见 §6。

## 8. 归一化规则

允许归一化：

- 临时项目路径 -> `<PROJECT_ROOT>`。
- 用户 home -> `<HOME>`。
- `${POLIT_HOME}` -> `<POLIT_HOME>`。
- 时间戳 -> `<TIMESTAMP>`。
- 随机 UUID / `runId` / 生成的 word slug -> `<ID:n>`。
- 端口 -> `<PORT>`。
- legacy `writerKind: "webui"` ↔ PolitDeck `channelKey: "web"`：仅在 report adapter 中映射为同一 token `<WEB_CLIENT>`，不允许在 gate 输出 reason 上下文中使用映射。
- legacy `no_fresh_heartbeat` ↔ PolitDeck `no_fresh_lease`：仅在 report adapter 中映射为同一 token `no_fresh_lease`。
- WS 末尾 synthetic `turn_completed` final frame：在 PolitDeck 内部 transport-symmetric 报告中识别并标注 `synthetic: true`，区分真实 `turn_completed`。

禁止归一化：

- `ok` vs error。
- gate reason（除上面允许的两个跨实现别名）。
- status 分类。
- permission allow / deny。
- prompt 中模型可见的行为要求文本（关键短语、章节名称）。
- plan markdown 章节集合与顺序。
- work report markdown 章节集合与顺序。
- 工具错误码（`plan_quota_exhausted` / `gateway_submit_failed` / `session_busy` / `workspace_unavailable`）。
- GatewayEvent 类型与顺序。
- `cwd` 是否在隔离基址下的判定结果。

## 9. 测试命令

全量验证：

```bash
npm run build
npm test
```

Always-On 专项：

```bash
npm test -- tests/always-on/
```

Legacy focused probe：

```bash
cd third-party/claude-code-main
bun test src/daemon/discoveryScheduler/gates.test.ts
bun test src/utils/alwaysOnDiscoveryPrompt.test.ts
bun run src/politdeck-always-on-legacy-config-report.ts
bun run src/politdeck-always-on-legacy-gate-report.ts
bun run src/politdeck-always-on-legacy-prompt-report.ts
bun run src/politdeck-always-on-legacy-plan-contract-report.ts
```

不要依赖整个 vendored 项目全量 build。旧项目 probe 应只 import 与 Always-On 相关的模块，避免 daemon socket / cron 之类无关代码被牵入。

## 10. CI Gate

Always-On 进入实现后，CI 至少应包含：

- `npm run build`
- `npm test`
- Always-On parity tests（config / gates / prompt / legacy plan contract snapshot）
- focused legacy reports

如果 legacy report 因环境不可用（例如缺 `bun`、子树不可 build）跳过，测试必须显式输出 skip reason，不能静默通过并声称 parity passed。CI 必须以非零退出码体现 skip。

## 11. 失败处理

- 如果 `compare` 场景失败：
  - 优先判断是 PolitDeck bug、legacy 行为误读、还是确实需要新增 intentional difference。
  - 是 bug 直接修代码或 fixture，不修测试。
  - 是 intentional difference：把 scenario 改为 `intentional_difference`，写明 reason，并同步更新 `02-politdeck-always-on-rewrite-plan.md` §12 Feature Classification 与本文 §4 manifest fixed-id 列表。
- 如果是 `intentional_difference` 场景在 legacy 端跑失败：通常是 legacy probe 引入了无关依赖；优先收窄 import 范围，而不是把场景剔除。
- 如果是路径、时间、随机 id 差异：补归一化规则（§8 允许归一化），但不得归一化掉用户或模型可见行为。
- 如果是 `not_applicable` 场景误进入 legacy report：检查 manifest 状态填写，必要时增加 manifest 测试断言。

## 12. 首批建议 Scenario

首批应覆盖风险最高、又能稳定双边执行的场景。下面列表中的固定 id 同时是 §4 manifest 必检 id：

Compare 场景（必须双边 deepEqual）：

- `config-defaults-trigger`
- `gate-disabled`
- `gate-project-disabled`
- `gate-project-missing`
- `gate-no-fresh-lease`
- `gate-agent-busy`
- `gate-recent-user-msg`
- `gate-cooldown`
- `gate-daily-budget`
- `gate-lock-busy`
- `gate-pass-prefer-channel`（仅 deepEqual 选中 lease 的 `selectedChannelKey`，归一化后；prefer 字段名差异在 `intentional_difference` 中登记）
- `prompt-english-default`（共享关键片段）
- `prompt-zh-cn`（共享关键片段）

Intentional difference 场景（必须存在 legacy 快照供对照）：

- `config-prefer-client-vs-channel`
- `config-flat-no-discovery-wrapper`
- `prompt-section-instruction-set`
- `legacy-plan-three-plans-snapshot`
- `legacy-plan-required-sections-snapshot`
- `legacy-plan-approval-mode-snapshot`
- `legacy-discovery-request-flow-snapshot`

Not applicable 场景（仅 PolitDeck 单测覆盖，manifest 中显式登记）：

- `gate-dormant-no-signal`
- `gate-workspace-capacity`
- `signal-watcher-debounce`
- `signal-watcher-ignore-globs`
- `signal-watcher-fallback-polling`
- `signal-watcher-restart-recovery`
- `plan-contract-valid-single-plan`
- `plan-contract-missing-section`
- `plan-contract-extra-section`
- `plan-contract-quota-exhausted`
- `report-contract-valid`
- `report-contract-fallback`
- `workspace-git-worktree-prepare`
- `workspace-git-worktree-dirty-rejected`
- `workspace-git-worktree-dispose`
- `workspace-snapshot-clonefile-mac`
- `workspace-snapshot-reflink-linux`
- `workspace-snapshot-fscp-fallback`
- `workspace-snapshot-rsync-fallback`
- `workspace-snapshot-size-cap`
- `workspace-registry-priority`
- `workspace-registry-unavailable`
- `runtime-no-plan-enters-dormancy`
- `runtime-executed-git-worktree`
- `runtime-executed-snapshot`
- `runtime-workspace-unavailable`
- `runtime-bypass-mode-asserted`
- `runtime-cwd-isolation-asserted`
- `runtime-transport-symmetric`

这些场景全部覆盖后，可声明：

- Always-On `compare` 集合的 contract / execution parity passed。
- Always-On 与旧实现之间的 intentional difference 已显式登记，且具备回归报警能力。
- PolitDeck 端的 plan / report / workspace / runtime 行为有独立单测保障，不依赖 legacy 比对。
