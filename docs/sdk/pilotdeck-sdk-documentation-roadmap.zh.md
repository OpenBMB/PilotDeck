# PilotDeck SDK 文档建设 Roadmap

本文规划 SDK 文档资产和质量建设，不维护 SDK 功能状态。功能的已实现能力、P0/P1/P2 和不支持项统一以[实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)为准；SDK 代码研发、测试和发布约束见[维护者版开发 SOP](pilotdeck-sdk-development-sop.zh.md)。

## 当前状态

已建立 `docs/sdk/public/` 文档树，包含 Overview、Quickstart、Core Concepts、能力 Guides、TypeScript/Messages/Errors/Compatibility Reference、Examples、Migration、Operations 和 Troubleshooting。当前需要持续收敛的工作是：

- 保持 package README 短小，只负责安装、最短示例和导航；
- 统一 public 页面中的术语、版本、capability 和 owner；
- 让 TypeScript Reference、错误参考和兼容矩阵跟随 public exports；
- 将文档片段与 `packages/sdk/examples/`、编译检查和 smoke test 关联；
- 把 Migration、Changelog、Troubleshooting 纳入每次 SDK 发布。

本轮已落地：核心 Guides 已补充最小代码、ownership、scope、错误和清理边界；Reference 增加 Public Exports 清单；Operations、Migration、Troubleshooting 增加回滚、版本记录和症状处理模板；`docs/sdk/tools/check-public-docs.mjs` 提供导出文件、runtime symbol 和本地链接的可重复检查。

## Phase 0：结构与事实源

产出 Overview、Quickstart、Concepts、Guides、Reference、Operations、Internal 导航；建立 public export、Gateway capability、文档页面、测试证据和术语清单。

完成条件：README 只做入口；每个 public symbol 有唯一 Reference；每个能力有 Guide 或明确无需 Guide；每项声明可追溯到代码和测试。

## Phase 1：最短成功路径

产出 10 分钟 Quickstart、Remote/Embedded 最小示例、安装/认证/Node engines/关闭语义说明和精简 package README。

完成条件：仓库外项目只凭 Quickstart 可以得到 final result；示例只用 public exports；`close()`、`abort()`、disconnect、`result_unknown` 无歧义；片段进入编译和 smoke test。

## Phase 2：核心任务 Guides（当前完成）

优先稳定 Custom Tools、MCP、Permissions、Sessions、Hooks、Transports 六篇 Guide。每页必须包含最小示例、Gateway/Native ownership、session scope、错误/取消/清理和到 Reference 的链接。

完成条件：应用开发者无需阅读内部源码即可添加工具、配置权限、管理 session 和处理断线；MCP 不可达、工具 scope 和 permission deny 有可复现说明。

当前结果：Custom Tools、MCP、Permissions、Sessions、Hooks、Transports 及高级能力页面均已具备示例和边界说明；真实 Gateway smoke 仍属于 Phase 6 自动化门槛。

## Phase 3：Reference 与兼容性（基础完成，持续补齐）

产出完整 TypeScript API、Messages、Errors、Compatibility Reference。每个条目记录 signature、默认值、生命周期、最低版本、capability、retryability 和相关 Guide；Claude 对照放在差异栏。

完成条件：两个 public exports 的符号覆盖率 100%；没有 internal-only symbol；旧 Gateway 对新能力的行为可以由兼容矩阵判断。

当前结果：两个 package entry、runtime/internal 边界和错误/兼容页面已记录；逐字段覆盖率和自动化生成仍列入 Phase 6。

## Phase 4：高级能力与边界

补齐 Settings、Structured Output、Usage/Budget、Checkpoint、Dialogs、Plugins/Skills/Subagents、Output Styles 等 Guide。

每项都说明 scope、生效时机、重启行为、host policy 边界、成熟度和 `unsupported_capability` 行为。实验能力先写限制和验证方法，不提前承诺 Claude 完全等价。

## Phase 5：发布、迁移与排障（基础完成，持续维护）

建立按版本的 Changelog、Migration、Troubleshooting 和 Operations 页面，覆盖安装失败、认证、MCP 不可达、工具不可见、permission 挂起、settings 未生效、断线、未知终态和 Gateway 重启。

完成条件：使用者能从错误码或症状找到处理页面；每个版本能说明新增、变化、弃用、兼容范围和回滚方式；文档与 package/Gateway 版本一起发布。

当前结果：Operations、Migration、Troubleshooting 已提供版本记录、回滚和症状到动作模板；`CHANGELOG.md`、页面 owner 和复核日期仍待仓库级发布流程接入。

## Phase 6：自动化质量门槛（进行中）

加入 Markdown/link/anchor 检查、public export 与 Reference 覆盖检查、文档 TypeScript 片段编译、Quickstart smoke、capability 与 protocol registry 对照，以及页面 owner/复核日期检查。

完成条件：CI 阻止失效链接、无法编译的示例、过期 API 和未声明 capability；每个发布版本可追溯到对应文档快照。

当前结果：已提供 `node docs/sdk/tools/check-public-docs.mjs` 的本地检查；Markdown anchor lint、TypeScript 片段编译、真实 Gateway smoke、capability registry 对照和 CI 接入仍是后续工作。

## 执行顺序

1. README 与 Overview/Quickstart 对齐；
2. 稳定 Tools、MCP、Permissions、Sessions、Transports Guide；
3. 固化 TypeScript/Messages/Errors/Compatibility Reference；
4. 补齐高级能力、Migration、Troubleshooting 和 Operations；
5. 将链接、示例编译和 public export 覆盖纳入 CI。

## 维护规则

- 本文只维护文档建设阶段，不复制 SDK 功能 P0/P1/P2；
- 功能未实现时，公开文档只能写 `unsupported` 或 `future`，不能写成 current；
- public API、协议或生命周期变化必须触发 Reference、Compatibility、Migration 和 Changelog 检查；
- 一个页面完成的标准是正文、示例、链接、版本和验证证据齐全；
- Claude 文档只参考信息架构和用户心智，PilotDeck 语义以自身 public contract 为准。

## 相关文档

- [SDK 文档建设 SOP](pilotdeck-sdk-documentation-sop.zh.md)
- [公开 SDK 文档](public/overview.zh.md)
- [SDK 实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)
