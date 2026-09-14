# Hooks

hooks callback 由 SDK 托管、由 Gateway 触发。Remote Gateway 场景下 endpoint 必须可达；Embedded 场景由宿主提供生命周期。

```ts
const run = query({
  prompt: "检查变更",
  options: {
    hooks: { PreToolUse: [{ hooks: [async (input, toolUseId, ctx) => {
      if (input.tool_name === "Bash") return { hookSpecificOutput: { permissionDecision: "ask" } };
      return;
    }] }] },
    includeHookEvents: true,
  },
});
```

callback 必须支持 `AbortSignal`、超时和幂等。返回 `{ async: true }` 后只能通过 `submitAsyncHookResult()` 提交 context-only 结果；过期、重复或未知 invocation 会被 Gateway 拒绝，不得修改已经完成的 native lifecycle effect。

Hook 不拥有 session、permission 或 transcript。未支持的 Claude 专属事件/输出形状必须得到 `unsupported_capability`，不能静默忽略。
