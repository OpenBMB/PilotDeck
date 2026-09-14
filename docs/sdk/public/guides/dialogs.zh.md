# Dialog 与 Elicitation

`onUserDialog`/`onElicitation` 用于收集用户输入，permission 用于审批工具，二者不是同一通道。

```ts
const run = query({
  prompt: "询问发布环境",
  options: {
    supportedDialogKinds: ["select"],
    onUserDialog: async (request) => ({ behavior: "answered", value: "staging" }),
  },
});
```

`input`、`select`、`confirm` 和 schema-backed `form` 的最终校验由 Gateway 完成；manual renderer 通过 `client.dialogs.claim()`、`respond()` 和 `release()` 管理 lease。`watch()` 只是提示，重连或漏通知后必须重新 `list()`。

Gateway 重启后可以恢复已记录的 dialog recovery record，但不会恢复旧 AgentLoop、turn 或 tool promise。迟到、重复或无效回答必须被拒绝。
