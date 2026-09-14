# PilotDeck SDK 文档建设 SOP

本文规定 `docs/sdk/public/` 及其配套审计文档的编写、评审、验证和发布流程。它只约束文档资产，不改变 SDK、Gateway 或 Native Core 行为；SDK 功能状态以 [实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md) 为准。

## 1. 文档分层

- `public/`：应用开发者使用的安装、指南、Reference、示例、运维和排障文档。
- 开发者 SOP/Roadmap：SDK 产品的设计、实现、测试和发布流程。
- 维护者 SOP：贡献边界、协议适配、parity 和 PR 验收。
- 审计/映射：Claude Agent SDK 与 PilotDeck 的语义证据，不直接承诺 public API。

公开页面只引用 `@pilotdeck/sdk`、`@pilotdeck/sdk/embedded` 和已声明的 Gateway contract；内部 `src/` 路径只能作为证据链接，不能作为调用示例。

## 2. 新页面流程

1. 写明读者、任务、适用 SDK/Gateway 版本和 capability 前置条件。
2. 从 `packages/sdk/package.json`、`dist/*.d.ts`、实现 Roadmap 和测试证据确认事实。
3. 按“最小示例 -> 所有权/scope -> 错误/取消/重启 -> 清理 -> 相关 Reference”结构编写。
4. 对未实现或实验能力使用 `unsupported_capability`、`future` 或明确的 alpha 限制，不写成稳定等价。
5. 同步更新 Reference、Compatibility、Examples、Migration 或 Troubleshooting 中受影响的页面。
6. 运行文档检查并由 SDK 维护者复核 public export、错误语义和链接。

## 3. 示例规范

- 示例只从两个 public entry import；Gateway URL、token、project 和宿主对象必须显式声明。
- 业务函数、MCP endpoint、plugin path 等外部依赖要标明“调用方提供”及生命周期。
- 必须展示成功、拒绝/失败、取消或关闭路径；`close()` 不得被描述为服务端 abort。
- 不得把 transport 断线写成 completed；未知终态使用 `result_unknown` 并指导查询 Gateway 状态。
- 有副作用的工具不得在示例中自动重放；权限、预算、transcript 和 checkpoint 由 Gateway/Native 持有。

## 4. 变更检查

```bash
git diff --check
node docs/sdk/tools/check-public-docs.mjs
```

涉及 public export 时必须同步更新 [Public Exports](public/reference/exports.zh.md)；涉及错误、协议或生命周期时必须同步更新 [Errors](public/reference/errors.zh.md)、[Compatibility](public/reference/compatibility.zh.md) 和 Migration 页面。涉及功能状态时只更新实现 Roadmap，不在本文复制 P0/P1/P2。

## 5. 发布门槛

- 本地链接、锚点和 Markdown 检查通过；
- 示例中的 public import 和类型可由当前 tarball 编译；
- 新增声明有对应 Gateway capability、最低版本和错误行为；
- 维护者确认没有把内部实现或未提交改动写成 SDK 能力；
- 发布记录包含 SDK、Gateway/protocol、capabilities、变更、弃用和回滚信息。

## 相关文档

- [文档建设 Roadmap](pilotdeck-sdk-documentation-roadmap.zh.md)
- [公开 SDK 文档](public/overview.zh.md)
- [SDK 开发者 SOP](pilotdeck-sdk-developer-sop.zh.md)
- [SDK 维护者版 SOP](pilotdeck-sdk-development-sop.zh.md)
