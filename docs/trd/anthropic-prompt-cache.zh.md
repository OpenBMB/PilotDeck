# Anthropic Prompt Cache TRD

## 文档状态

已确认。适用范围：Gateway/AgentLoop 到 Anthropic Messages provider 的请求边界。

## 代码边界

- `src/context/cache/CachePlan.ts`：计算 provider-boundary 缓存计划和稳定 fingerprint。
- `src/context/DefaultContextRuntime.ts`：根据实际协议和模型能力生成计划，并在压缩后递增 generation。
- `src/model/providers/anthropic/request.ts`：将计划转换为 Anthropic `cache_control` marker。
- `src/router/RouterRuntime.ts`：provider/model 路由变化时丢弃不匹配的旧计划。
- `src/model/protocol/canonical.ts`：定义不写入 transcript 的 `CachePlan`。
- `src/model/streaming/continuationRequest.ts`：续传改变消息序列时清除旧的 provider-boundary 断点。

## 核心契约

1. 只有实际 `protocol === "anthropic"` 且模型声明 `supportsPromptCache === true` 时启用缓存。
2. 默认布局必须是 `system + recent3`：system prompt 一个断点，投影后最后三个非 system message 各一个断点。
3. recent3 按消息位置选择，不过滤未完成 tool call、tool result、permission 或 elicitation 消息。
4. thinking block 不得添加 `cache_control`；若消息末尾是 thinking，marker 回退到最近的可缓存 block；thinking-only 消息跳过 marker。
5. 默认不为 tool schema 添加断点；显式 `cachePlan.tools === true` 仍兼容，并将消息断点限制为两个。
6. 所有 marker 使用 `ttl: "5m"`，单请求最多四个断点。
7. `cache_control` 只允许出现在 provider request，禁止写入 canonical transcript。
8. system、tool schema、provider、model 或 recent3 内容变化时 fingerprint 必须变化；fingerprint 使用固定长度 SHA-256 摘要，不得保存媒体 base64 或其他完整输入；压缩或路由切换不得复用旧计划。
9. plan mode 的 synthetic reminder 不得参与消息投影配额或 memory retrieval；它在 projection 完成后追加，并与最终请求消息一起重新计算 recent3。
10. 流式续传追加 partial assistant 和 continuation instruction 后，必须重算缓存计划或显式清除旧计划，禁止沿用失效的消息下标。

## 正常与恢复流程

- 新会话先缓存 system；有消息时再按 recent3 标记消息。
- 每次投影后重新计算计划；消息被裁剪、微压缩或完整压缩后递增 generation。
- plan mode 先对真实对话完成投影和 memory retrieval，再追加 reminder；最终请求的缓存计划以追加后的消息序列为准。
- continuation request 改变消息数量后清除旧缓存计划，由下一次完整请求重新建立 provider-boundary 断点。
- Router 将请求切换到不同 provider/model 时清除旧计划，当前请求无缓存降级。
- 非 Anthropic provider 或不支持缓存的模型继续发送普通请求，不产生缓存 marker。

## 测试映射与证据

- `tests/context/cache-plan.spec.ts`：recent3 选择、fingerprint 和关闭条件。
- `tests/context/cache-runtime.spec.ts`：DefaultContextRuntime 的协议门控、投影截断和 generation。
- `tests/model/request/anthropic-cache-plan.spec.ts`：system/recent3、5m TTL、tools 兼容和四断点上限。
- `tests/agent/loop/model-override-defaults.spec.ts`：plan reminder 不占 projection 配额，memory 使用真实用户请求，最终断点与消息序列一致。
- `tests/model/streaming/continuation-cache.spec.ts`：续传不复用旧缓存断点。
- `tests/context/cache-plan.spec.ts`：媒体消息 fingerprint 固定长度，避免 base64 在缓存计划中重复驻留。
- `pnpm run build`：编译后的 provider/request 入口可用。
- ModelBest 或 Anthropic 真实命中率属于 external smoke/nightly，不作为离线单测证据。

## 限制与变更记录

- TTL 当前固定为 5 分钟，未新增配置字段。
- 2026-08-24：移除按完整 tool transaction 生成断点的旧 `CachedMicroCompactionEngine`，改为严格 `system + recent3`。
