# Output Styles 与 Prompt Suggestions

通过 `outputStyles()` 查询 Gateway 可见 style，`setOutputStyle()` 选择下一次 runtime 使用的 style，`reloadOutputStyles()` 请求 Gateway 重载 registry。运行中的 session 不应被隐式改写；不支持的 style 或旧 Gateway 返回 `unsupported_capability`。

`promptSuggestions: true` 只产生成功 turn 后的 transient `prompt_suggestion` 事件，不写入 transcript，也不改变原 turn 结果。建议生成失败或超时应省略该事件，不能让主任务失败。
