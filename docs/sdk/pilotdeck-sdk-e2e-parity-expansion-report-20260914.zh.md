# PilotDeck SDK 与 Native 扩展对拍报告

## 结论

本轮在 `dev-sdk-0901-standalone`（`38129812cb09c938bd237293209ceee6eef52ecc`）上完成了两条独立验证线：

- Native 回归：沿用 StaffDeck 的 32 个既有 AgentLoop 场景，对比 `origin/main@cfc4d1779228f91fececc5d6705c14dab5b7ef2f`，无普通语义 FAIL、无 oracle failure、无 BLOCKED。
- SDK contract E2E：`agents-e2e` 单独以 300 秒文件级超时运行，78/78 通过；预算、usage、seed、transcript restore 和 package install 测试也全部通过。

因此，SDK 当前公开 façade 的行为验证通过，且没有发现会改变既有 Native AgentLoop 终态、工具副作用或权限判定的回归。

本轮没有把 SDK-only 场景伪装成 origin/main 可比较的 Native 场景：12 个扩展场景的外部 scenario overlay 和三层自动 oracle 尚未提交或运行。下表将“SDK contract 已覆盖”和“Gateway/SDK 对 Native 的三层对拍”明确区分。

## 基线与环境

- Worktree：`/Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-standalone`
- 分支：`dev-sdk-0901-standalone`
- 当前提交：`38129812cb09c938bd237293209ceee6eef52ecc`
- Native 基线：`origin/main@cfc4d1779228f91fececc5d6705c14dab5b7ef2f`
- Node.js（实际执行）：`v22.22.0`
- pnpm：`10.32.1`
- Python：`3.12.2`（StaffDeck backend virtualenv）

## Native 32 场景回归

命令：

```bash
PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
/Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/backend/.venv/bin/python \
/Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop/tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-standalone \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pilotdeck-baseline origin/main --pair pilotdeck --comparison baseline \
  --scenario all --pilotdeck-native-cmd "node /tmp/pilotdeck_standalone_dispatch.mjs" \
  --adapter-timeout-seconds 60 --output /tmp/pilotdeck-sdk-parity-expanded-dcpNkJ \
  --allow-blocked
```

结果来自 `/tmp/pilotdeck-sdk-parity-expanded-dcpNkJ/summary.json`：

| 指标 | 结果 |
| --- | ---: |
| 场景 | 32 |
| blocked | 0 |
| failed | 0 |
| oracleFailures | 0 |
| 普通语义 FAIL | 0 |

唯一记录为 `plan_mode_host_policy` 的 baseline drift（18 项 semantic difference、36 项 format warning）。它是两次提交的模型可见工具描述/schema 文本差异，未改变计划模式、权限拒绝、批准后写入或工具副作用，故不计为执行语义 FAIL。

adapter、trace、JSONL、日志和 SQLite 均位于 `/tmp`，没有加入提交；StaffDeck harness 未修改。

## SDK E2E 结果

通过的聚焦命令包括：

```bash
PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH pnpm build
PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH pnpm --filter @pilotdeck/sdk test
PATH=/Users/a1/.nvm/versions/node/v22.22.0/bin:$PATH \
node --test --test-force-exit --test-timeout 300000 \
dist/tests/sdk/agents-e2e.spec.js
```

结果：构建通过；SDK package tests 为 123/123；`agents-e2e` 为 78/78。预算、usage、seed-read-state、session-transcript-restore 和 package-install 测试分别通过。此前将多个文件合并运行并设置 120 秒总时限时出现 1 个文件级 cancelled；单独提高该文件时限后 78 个子测试全部通过，不是测试失败。

## 12 个扩展场景覆盖矩阵

状态含义：`PASS(contract)` 表示 SDK contract 已由真实 Gateway/embedded E2E 验证；`未完成三层对拍` 表示尚未用独立 overlay 同时运行 origin/main native、当前 native 和 SDK oracle，不能等同于计划要求的 P0 对拍 PASS。

| 优先级 | 场景 | Contract 状态 | SDK contract 证据 | 重启/边界证据 | 三层 overlay |
| --- | --- | --- | --- | --- | --- |
| P0 | `sdk_gateway_query_stream` | PASS(contract) | `agents-e2e` 的 embedded/query、tool progress、package remote Gateway 测试 | 流式终态、tool call/result 已覆盖 | 未完成三层对拍 |
| P0 | `sdk_session_lifecycle_restart` | PASS(contract) | checkpoint restart、native session storage、last-turn replacement、transcript restore | 证明 transcript/checkpoint 可恢复；active turn/tool promise 不恢复 | 未完成三层对拍 |
| P0 | `sdk_permission_policy_precedence` | PASS(contract) | permission hook/canUseTool、managed tool policy、host organization policy、tool_policy isolation | 拒绝无写入副作用；host policy 不可由 SDK 放宽 | 未完成三层对拍 |
| P0 | `sdk_custom_tool_mcp_deferred` | PASS(contract) | custom/MCP、deferred native/MCP、search 后 schema 暴露、allow/disallow | 工具按 session 隔离 | 未完成三层对拍 |
| P0 | `sdk_hooks_async_configchange` | PASS(contract) | Pre/PostToolUse、FileChanged async、ConfigChange、SessionEnd/StopFailure/compaction hooks | async context 只消费一次，过期/重复结果拒绝 | 未完成三层对拍 |
| P0 | `sdk_budget_usage_restart` | PASS(contract) | `max-budget-e2e` 5 项、`model-usage-e2e` | durable task/project budget ledger 和累计 usage 重启后保留 | 未完成三层对拍 |
| P0 | `sdk_checkpoint_rewind_seed_conflict` | PASS(contract) | checkpoint restart、`seed-read-state-e2e` | mtime/write freshness 冲突拒绝 seed/覆盖，后续 edit 需重新 read | 未完成三层对拍 |
| P0 | `sdk_cancel_reconnect_unknown` | PASS(contract) | abort/transport tests、Gateway reconnect/error contract | 已验证 abort/error 分类；真实断线重复提交的三层场景尚未 overlay 化 | 未完成三层对拍 |
| P1 | `sdk_dialog_form_recovery_restart` | PASS(contract) | input/select/confirm/form、JSON Schema、manual/file/HTTP renderer | expired owner 生成 restart-terminal recovery；回答进入下一 turn | 未完成三层对拍 |
| P1 | `sdk_settings_model_fallback_structured` | PASS(contract) | settings source/enforced settings、fallback、output style、structured output tests | session overlay 不影响 native session；不支持项返回 `unsupported_capability` | 未完成三层对拍 |
| P1 | `sdk_plugin_subagent_scope` | PASS(contract) | plugin/MCP、dynamic AgentDefinition、background/observer、depth cap | plugin/subagent/tool scope 不泄漏，observer 为 detached read-only | 未完成三层对拍 |
| P1 | `sdk_transport_equivalence` | PASS(contract) | Remote WebSocket、InProcess/embedded、package install | canonical messages、tool effects 和 session state 均有 contract 测试 | 未完成三层对拍 |

## 负向能力

`packages/sdk/test/transport.test.ts` 已验证以下输入明确抛出 `unsupported_capability`，不会静默降级：

- host sandbox / Bubblewrap profile；
- `tools: { type: "preset", preset: "claude_code" }`；
- 不支持的 output-style / 独立控制请求；
- 不支持的 MCP transport。

## 持久化边界证据

- checkpoint：真实创建新的 Gateway 实例后恢复文件 checkpoint；外部修改导致 freshness 冲突时不覆盖。
- session：portable transcript 可导入新的 durable session；active turn、正在等待的 tool promise 不作为可恢复状态。
- budget：Gateway-owned JSONL ledger 在重启后恢复 session/project ceiling，Router 内存统计不是唯一来源。
- dialog：owner 过期后记录 recovery；恢复答案作为下一 turn 的 synthetic user context，不重启旧 tool promise。

## 差距与后续

要满足“44 场景、P0 全部 PASS”的完整验收，还需要在 StaffDeck harness 之外维护一次性 scenario overlay 和 adapter，并逐场输出三层 canonical trace。该资产应继续放在 `/tmp/pilotdeck-sdk-parity-*` 或独立外部 harness，不应修改 `dev-sdk-0901-standalone` 的 SDK 产品代码，也不应提交到 StaffDeck 原有 harness。

本报告只记录本轮已执行证据；未完成的 overlay 不标记为 PASS，也没有将任何 BLOCKED 隐藏为成功。
