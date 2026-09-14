# Permissions

`permissionMode`、`allowedTools`、`disallowedTools` 和 `canUseTool` 控制 SDK 请求，但最终裁决由 Gateway/PermissionRuntime 完成：

```ts
const run = query({ prompt: "查看状态", options: {
  permissionMode: "default",
  allowedTools: ["Read"],
  canUseTool: async (toolName) => toolName === "Read"
    ? { behavior: "allow" } : { behavior: "deny", message: "只允许读取" },
} });
```

callback 缺失、抛错或超时必须 fail closed。`managedSettings` 只能收紧权限，不能通过 settings overlay 放宽 host policy；拒绝时不得产生工具副作用，也不能包装成普通 `completed`。

permission request 与 dialog/elicitation 是不同通道：permission 决定工具是否执行，dialog 收集用户输入。拒绝不会执行工具副作用，也不应被包装成普通 completed 结果。
