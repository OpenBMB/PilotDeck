# Plugins、Skills 与 Subagents

plugins、skills 和 dynamic `AgentDefinition` 都按 session/child scope 加载。plugin path 必须对 Gateway host 可见，SDK 不会把本地路径或 JavaScript callback 上传给远程 Gateway。

```ts
const run = query({
  prompt: "让分析 agent 汇总结果",
  options: {
    agents: [{ name: "analyst", description: "只读分析", tools: ["Read"], skills: ["repo-guide"], memory: "disabled" }],
    plugins: [{ type: "local", path: "/srv/pilotdeck/plugins/analysis" }],
  },
});
```

动态 subagent 的 MCP、skills、memory 和 background 不能泄漏到 parent 或其他 session；child 结束时其 fork-local runtime 关闭。`skills` 只能缩小父技能域，`memory: "disabled"` 只影响 child。plugin reload 只影响后续 runtime。

Claude 专属 callback、observer/observerMessage、账号登录和 UI 语义没有 PilotDeck 对应能力时，必须返回 `unsupported_capability`。
