# 架构与所有权

```text
业务应用 -> @pilotdeck/sdk -> Gateway protocol -> Native AgentLoop
                                      -> ToolRuntime / Permission / Session / Storage
```

SDK 负责 public types、transport、codec、事件映射和 callback 托管。Gateway 负责路由、能力协商、宿主策略和持久化。Native Core 负责模型调用、工具执行、上下文、权限裁决和 transcript。

不要在 SDK 中维护第二套 session/run 状态机，也不要用客户端缓存替代 Gateway transcript。SDK-hosted MCP handler 通过标准 endpoint 被 Gateway 调用；JavaScript function 不进入 WebSocket frame。

## 修改边界

增加业务工具和调用体验通常是 SDK-only。新增 wire 字段可修改协议 schema/codec，但不应改变 AgentLoop、ToolRuntime、PermissionRuntime、ContextRuntime 或 storage 的默认行为。运行时语义变化必须拆为 Gateway/Native 任务。
