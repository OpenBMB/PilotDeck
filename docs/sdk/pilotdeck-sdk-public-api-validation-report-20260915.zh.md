# PilotDeck SDK Public API 验收报告（2026-09-15）

## 结论

本次对 `@pilotdeck/sdk` 与 `@pilotdeck/sdk/embedded` 的公开运行时接口完成了打包安装、真实 Gateway 调用和本地 deterministic model 的验收。

- SDK package 单元测试：`123/123 PASS`。
- 打包后外部消费者测试：`6/6 PASS`。
- SDK + Native Gateway E2E：`86/86 PASS`，无 failed、cancelled、skipped 或 BLOCKED。
- 公开运行时 namespace：root `45` 项、`/embedded` `9` 项，均从 `pnpm pack` 后安装的 package 实际导入并断言。
- Native baseline parity：`32/32 BLOCKED`，原因是外部 StaffDeck parity adapter 依赖本 standalone 分支明确排除的 `src/agent/modules/**` sidecar 文件；没有执行到语义比较，不能解读为 PASS 或 FAIL。

本次修复了一个 public contract 偏差：此前 root `@pilotdeck/sdk` 会重导出 Embedded-only runtime。现在 Embedded API 和 `toEmbeddedTool()` 只能从 `@pilotdeck/sdk/embedded` 导入，符合双入口设计；Native AgentLoop、Gateway、ToolRuntime、PermissionRuntime 和 storage 语义均未修改。

## 基线与环境

| 项目 | 值 |
| --- | --- |
| 被测提交 | `27282fab563b0c8bfad650e523c1543412b08ce8` 加本次未提交验收修复 |
| Native 对拍基线 | `origin/main@cfc4d1779228f91fececc5d6705c14dab5b7ef2f` |
| Node.js | `v22.23.1` |
| pnpm | `10.32.1` |
| SDK package | `@pilotdeck/sdk@0.1.0-alpha.0` |
| 模型 | 本地 deterministic mock `ModelRuntime`，未使用真实 API key |

## 覆盖与结果

### Public exports 与安装消费者

`tests/sdk/package-install.spec.ts` 先执行 `pnpm pack`，再将 tarball 安装到仓库外临时 fixture；消费者只能使用 package `exports`：

| 场景 | 结果 | 关键断言 |
| --- | --- | --- |
| package 内容 | PASS | 可运行示例包含在 tarball |
| Root query | PASS | WebSocket Gateway、stream、最终 `completed` result |
| Root namespace | PASS | 45 个运行时导出完全匹配；不存在 `createEmbeddedQuery`、`createEmbeddedPilotDeckClient`、`createEmbeddedToolRegistry`、`toEmbeddedTool` |
| Embedded query | PASS | authoritative in-process Gateway、正常 stream/result |
| Embedded namespace | PASS | 9 个 Embedded-only runtime 均从 `/embedded` 导入，包括 `toEmbeddedTool` |
| SDK-hosted MCP | PASS | 模型 tool call、MCP handler、副作用和 `tool.started`/`tool.completed` 完整发生 |
| Hooks | PASS | callback Hook 的 native lifecycle context 生效 |
| 空 tool allow-list | PASS | `tools: []` 不回退到 Native 默认工具 |

Root 的 45 项和 `/embedded` 的 9 项名单由测试中的显式 manifest 固定。该 manifest 防止未来误将 Embedded runtime 重新泄漏到 root，或静默改变已发布 namespace。

### SDK 单元与 Native Gateway E2E

| 测试组 | 结果 | 覆盖重点 |
| --- | --- | --- |
| `packages/sdk/test/*.test.ts` | 123/123 PASS | query/warm query、transport、stream 事件、`result_unknown`、abort、SessionStore、settings、permissions、dialogs、MCP、hooks、usage/budget、checkpoint/seed、subagent、plugins、skills、embedded transport/host/registry |
| `tests/sdk/*.spec.ts` | 86/86 PASS | 真实 local Gateway 下的 model fallback、session scope、MCP deferred、tool progress、permission/elicitation、dialog recovery、resume/fork/transcript、usage/model usage、budget、settings、structured output、checkpoint、subagent lifecycle 与 Embedded host |

E2E 的 terminal outcome 由 Gateway 保持权威；测试明确区分 `completed`、`failed`、`aborted` 和 `result_unknown`，没有将 transport disconnect 规范化为成功。工具副作用、permission decisions、session/transcript/checkpoint 与恢复边界均由现有 Native runtime 处理，SDK 仅通过公开协议调用。

## 执行命令

```bash
export PATH=/Users/a1/.nvm/versions/node/v22.23.1/bin:$PATH

pnpm exec tsc -p tsconfig.json --noEmit
pnpm --filter @pilotdeck/sdk typecheck
pnpm --filter @pilotdeck/sdk test
pnpm exec tsx --test tests/sdk/package-install.spec.ts
pnpm exec tsx --test \
  tests/sdk/agents-e2e.spec.ts \
  tests/sdk/max-budget-e2e.spec.ts \
  tests/sdk/model-usage-e2e.spec.ts \
  tests/sdk/seed-read-state-e2e.spec.ts \
  tests/sdk/session-transcript-restore-e2e.spec.ts
pnpm build
node docs/sdk/tools/check-public-docs.mjs
git diff --check
```

E2E 的临时日志为 `/tmp/pilotdeck-sdk-e2e-validated-*`。package fixture、Gateway storage、MCP endpoint 和 SQLite 产物均在 `/tmp`，未加入提交。

## Native parity 阻断记录

执行命令：

```bash
backend/.venv/bin/python tools/agent-loop-parity/run.py \
  --pilotdeck-root /Users/a1/Desktop/claw/openbmb/PilotDeck-sdk-standalone \
  --staffdeck-root /Users/a1/Desktop/claw/openbmb/StaffDeck-pilotdeck-agent-loop \
  --pilotdeck-baseline origin/main \
  --staffdeck-baseline origin/main \
  --pair pilotdeck --scenario all --comparison baseline \
  --output /tmp/pilotdeck-sdk-native-parity-ZAn9Wg
```

结果为 `scenarios: 32`、`failed: []`、`baselineDifferences: []`，但每个 current/baseline adapter 均在 import 阶段 `BLOCKED`。首个证据是缺少：

```text
dist/src/agent/modules/checkpoint/seedStateProjection.js
```

最后一个场景还依赖：

```text
dist/src/agent/modules/adapters.js
```

这些 module/sidecar 文件按 standalone SDK 方案被明确排除，且 current 与临时 baseline checkout 同样缺失。该 harness 不能用于此分支的 Native 语义证明；要恢复 32 场景对拍，需要让外部 harness 改用当前 Gateway/AgentLoop surface 或在独立兼容 checkout 运行，不能为通过对拍把 module/sidecar 重新带入 SDK 提交。

## 修复边界

- 删除 root 对 `embedded.ts` 的重导出。
- 将 `toEmbeddedTool()` 移到 `/embedded` public entry。
- 更新 SDK 自身测试、SDK E2E import、public reference 与安装 fixture 断言。
- 没有修改 `src/agent`、`src/tool`、`src/gateway`、`src/session` 或 `src/permission` 的产品行为。
