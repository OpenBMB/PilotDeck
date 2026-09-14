# Settings

`settings` 是当前 SDK session 的 overlay；`settingSources` 选择 Gateway 可见来源；`managedSettings` 只能收紧权限、工具和模型：

```ts
const run = query({ prompt: "分析构建", options: {
  settings: { agent: { model: "openai/gpt-5" } },
  managedSettings: { tools: { deny: ["Bash"] }, permissions: { defaultMode: "plan" } },
} });
```

`resolveSettings()` 读取 Gateway 脱敏快照；`updateSettings("localSettings", ...)` 是受限的 host-owned 持久化入口。配置的生效时机必须按当前 session、下一 turn 或新 runtime 验证。

provider credentials、组织策略和 enforced settings 不属于 SDK 可写范围。配置何时生效必须按当前 session、下一 turn 或新 runtime 验证。
