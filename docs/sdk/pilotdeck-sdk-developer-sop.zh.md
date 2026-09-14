# PilotDeck SDK 开发者 SOP

本文规定 `@pilotdeck/sdk` 产品如何设计、实现、验证和发布，目标是提供 Claude Code SDK-like 的 TypeScript SDK。它不是业务应用接入教程；接入实践见[开发经验与接入指南](pilotdeck-sdk-development-experience.zh.md)。

## 1. 先划清边界

```text
SDK public API -> transport/adapter -> Gateway protocol -> Native AgentLoop
```

SDK 负责 public types、`query()`/client façade、transport、codec、事件/错误映射和本地 callback。Gateway/Native 负责 AgentLoop、模型调用、工具调度、权限最终裁决、session/run、transcript、checkpoint、usage 和 budget 的权威状态。

硬约束：

- 不创建第二套 AgentLoop、session/run 状态机、权限系统、预算账本或 transcript；
- 不把 `src/` 内部类或 WebSocket frame 当作 public API；
- 不改变 Native 默认工具顺序、权限 precedence、重试、compaction、终态或副作用；
- 不把 Claude 专属能力静默降级，明确返回 `unsupported_capability`；
- 允许修改协议层，但协议字段必须向后兼容，未携带新字段时原生路径不变；
- host/OS sandbox、Bubblewrap 不属于 SDK 实现范围。

## 2. 需求分流

每个需求先写一页 capability brief：Claude 接口、PilotDeck 语义入口、public symbol、wire 字段、状态 owner、版本/capability、错误、测试和回滚方案。

按类型分流：

| 需求 | 交付范围 |
| --- | --- |
| façade、类型、事件投影、callback | SDK-only |
| request/response/event、codec、capability negotiation | SDK + Gateway protocol adapter |
| 模型路由、工具调度、权限、持久化、checkpoint、预算语义 | 独立 Gateway/Native 任务，SDK 只接入 |
| Claude 专属或当前未实现能力 | typed `unsupported_capability` |

## 3. 公共接口设计

优先围绕四个抽象设计：

- `query({ prompt, options })`：返回可异步迭代事件且有唯一 `result()`；
- `startup()`：预热连接，不改变 run 语义；
- `createPilotDeckClient()`：session/run/resource 控制面；
- `tool()`、`createSdkMcpServer()`、`@pilotdeck/sdk/embedded`：业务工具接入。

每个 public API 必须定义参数、默认值、返回值/事件、生命周期、scope、错误、最小 Gateway capability 和关闭方式。`close()` 只释放客户端资源；终止服务端任务使用 `abort()`/`stopTask()`。断线不等于 completed；未知终态保持 `result_unknown`。

## 4. 实现顺序

1. 在逐函数映射中登记 Claude symbol、PilotDeck 入口、源码证据和差异；
2. 先补 `types`、schema validator、错误码和协议 codec；
3. 再实现 `client`/`transport`/`embedded` adapter，复用 Gateway 返回的权威状态；
4. 为 MCP、hooks、dialog 等 SDK-owned 资源实现 start/close/abort/timeout/cleanup，且关闭幂等；
5. 更新示例、API Reference、兼容矩阵、Migration/Changelog 和实现 Roadmap；
6. 对不支持字段做负向测试，禁止“存在参数但无效果”。

## 5. 原生协议适配

允许修改 `src/gateway/protocol/**`、协议 codec、capability registry 和契约测试。适配必须满足：

1. 新字段可选，旧客户端和默认 native 输入行为不变；
2. 只在 session/runtime 构造边界翻译配置，不重排 runtime 执行流程；
3. 明确旧 Gateway 行为和错误码；
4. PR 标记“协议适配”，附 native parity 证据；
5. 需要新运行时语义时拆出 Gateway/Native PR。

禁止在 SDK PR 中修改 AgentLoop、ToolRuntime、PermissionRuntime、ContextRuntime、Session storage 的默认语义，或顺手修复无关 native bug。

## 6. 验收测试

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm --filter @pilotdeck/sdk typecheck
pnpm --filter @pilotdeck/sdk test
pnpm --filter @pilotdeck/sdk pack
```

必须使用仓库外 fixture 验证两个 public exports、ESM 类型、Node engines 和 tarball 安装。新增能力至少覆盖：

- fake Gateway request、event 顺序、codec、重复 final、超时、断线和错误映射；
- Remote/Embedded query、tool/MCP、permission、hooks、session resume/fork、settings、usage/budget、checkpoint/dialog；
- `completed`、`failed`、`aborted`、`result_unknown` 和 `unsupported_capability`；
- Gateway 重启后的 transcript/session/budget 边界，以及 active turn/tool promise 不恢复；
- Native baseline/current parity：工具副作用、权限决定、transcript、终态和错误码不可出现新增语义差异。

缺 adapter、无 trace、超时或环境不足只能记为 `BLOCKED`，不得改写为 PASS。

## 7. 发布门槛

- public exports、类型、示例、协议 capability、错误码和 Roadmap 一致；
- SDK-only 修改可独立发布；协议变更先部署兼容 Gateway；Native 语义变更单独评审和回归；
- alpha/experimental 能力有 capability gate、限制和迁移说明；
- 发布后重启 SDK-owned MCP/hook server，创建新 query/runtime 验证版本和 final result；
- 保留旧 SDK/Gateway 回滚路径。

## PR Definition of Done

- [ ] capability brief、Claude/PilotDeck 映射和 ownership 完整；
- [ ] public façade、types、codec、错误和 capability 完整；
- [ ] 正向、负向、取消、超时、断线和重启测试通过；
- [ ] 外部 tarball fixture 可导入和调用；
- [ ] Native parity 无新增语义回归；
- [ ] 文档、示例、兼容矩阵、Migration/Changelog 已同步；
- [ ] 变更未越过 Native 语义冻结边界。

## 相关文档

- [SDK 维护者版 SOP](pilotdeck-sdk-development-sop.zh.md)
- [SDK 能力状态 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)
- [Claude Agent SDK 与 PilotDeck 逐函数对应](claude-agent-sdk-pilotdeck-function-map.zh.md)
