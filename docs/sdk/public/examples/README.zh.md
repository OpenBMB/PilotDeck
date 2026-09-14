# Examples

仓库中的可执行示例位于 [`packages/sdk/examples`](../../../../packages/sdk/examples)。它们只使用 public exports，并覆盖以下场景：

| 示例 | 主题 |
| --- | --- |
| `basic-run.mjs` | 最小 query 和 result |
| `streaming.mjs` | 流式事件 |
| `abort.mjs` | 取消和 AbortSignal |
| `mcp-tool.mjs` | SDK-hosted MCP 工具 |
| `permission.mjs` | permission callback |
| `resume-fork.mjs` | session resume/fork |
| `structured-output.mjs` | JSON Schema 输出 |
| `task-budget.mjs` | session/project budget |
| `plugins.mjs` | session plugin |
| `terminal-dialog.mjs`、`browser-dialog.mjs` | dialog renderer |
| `mcp-resource.mjs` | MCP 控制面 |
| `last-turn-replacement.mjs` | transcript 尾部替换 |

运行示例前设置 `PILOTDECK_SDK_GATEWAY_URL` 和 `PILOTDECK_SDK_AUTH_TOKEN`。示例中的 Gateway、MCP endpoint、plugin path 和 project storage 均由宿主负责；示例不会自动重放未知终态的副作用请求。
