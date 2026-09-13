# `@pilotdeck/sdk` examples

这些示例使用已安装的 `@pilotdeck/sdk` 公共入口，不依赖 PilotDeck 仓库内部模块。运行前设置：

```bash
export PILOTDECK_SDK_GATEWAY_URL=ws://127.0.0.1:8787
export PILOTDECK_SDK_AUTH_TOKEN=your-token
node basic-run.mjs
```

示例按 SOP 覆盖：基础调用、流式事件、权限回调、session resume/fork、last-turn replacement、abort、自定义 MCP 工具、无 Query 的 MCP resource 控制面、session plugin、structured output、Gateway-owned task budget 和 user dialog renderer。`mcp-resource.mjs` 通过 `client.mcp` 为一个已创建 session 配置、查询、重连和收紧 MCP 权限；SDK-hosted endpoint 必须由调用方保持存活，Gateway 始终拥有 MCP connection、session 与 tool lifecycle。`last-turn-replacement.mjs` 读取 Gateway transcript 的尾部 entry id，使用 `prepareLastTurnReplacement()` 预留一条 replacement run；只有 Gateway 可以在 `accepted_input` 后提交或在未启动时回滚事务。`plugins.mjs` 需要额外设置 `PILOTDECK_SDK_PLUGIN_PATH`，其绝对路径必须对 Gateway host 可见。`task-budget.mjs` 可通过 `PILOTDECK_SDK_TASK_BUDGET_SCOPE=project` 演示跨 session 的 project ceiling；同一 Gateway project 中所有调用必须使用相同的 `PILOTDECK_SDK_TASK_BUDGET_USD`。`terminal-dialog.mjs` 使用 `createTerminalUserDialogHandler()` 回答 input/select/confirm/form，并把复杂 form field 回退为 JSON 输入。`browser-dialog.mjs` 是浏览器模块示例：应用设置 `window.PILOTDECK_GATEWAY_URL`/`window.PILOTDECK_GATEWAY_TOKEN`，`createDomBrowserDialogDriver()` 会在 `#pilotdeck-dialog-root` 或 `document.body` 下渲染 input/select/confirm/form DOM modal；应用也可以替换为自己的 React/Web Component driver。示例不会自动重放有副作用的请求；Gateway 仍是 session/run/permission 的权威。
