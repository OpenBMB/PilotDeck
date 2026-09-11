# Claude Agent SDK TypeScript × PilotDeck 语义审计

## 范围与基线

本文档系列起始于一次**现状审计**，并在同一 worktree 中落实为 `@pilotdeck/sdk` alpha。审计结论仍以指定提交快照为准；SDK 实现通过 Gateway adapter 暴露既有语义，不把内部源码 API 误写为稳定公共 API。

- Claude 基线：官方 TypeScript Agent SDK，调研时 npm `@anthropic-ai/claude-agent-sdk` 为 `0.3.263`。
- PilotDeck 基线：`Kaguya-19/refactor/core_agent_loop_0831` 的提交 `20b88268dc8fd8d600facf7fc68af907769cc36d`。
- 本 worktree 为 detached HEAD；不纳入原分支 worktree 的未提交修改。
- 审计基线的根 package 标记为 `private: true`，没有 npm `exports`；下文“SDK 表面”只表示可复用的源码导出、Gateway 协议或 module/sidecar 协议。实现交付新增 `packages/sdk` 的 `@pilotdeck/sdk` alpha package，独立使用 ESM `exports`。

Claude 版本证据：[npm package `0.3.263`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.263)；接口细节以同版本包内 `sdk.d.ts`/`sdk-tools.d.ts` 与官方 TypeScript reference 交叉核对。

## 阅读顺序

1. [Claude TypeScript API 全量清单](claude-agent-sdk-ts-api-inventory.zh.md)
2. [Claude → PilotDeck 语义映射](claude-agent-sdk-pilotdeck-mapping.zh.md)
3. [PilotDeck 当前可复用表面](pilotdeck-sdk-current-surface.zh.md)
4. [能力差距矩阵](sdk-capability-gap-matrix.zh.md)
5. [PilotDeck SDK 与原生模块：简单说明](pilotdeck-sdk-vs-native-modules.zh.md)
6. [PilotDeck SDK 开发与接入 SOP](pilotdeck-sdk-development-sop.zh.md)
7. [Claude Agent SDK 与 PilotDeck：逐函数代码对应表](claude-agent-sdk-pilotdeck-function-map.zh.md)
8. [PilotDeck SDK 实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)

## 结论摘要

- PilotDeck 已经有完整的 AgentLoop、canonical message/event、工具注册与调度、权限运行时、Session/Transcript、Hooks、Subagent、MCP、Skills/Plugins 和 Gateway/sidecar 基础设施。
- 与 Claude Agent SDK 相比，PilotDeck 的核心语义覆盖面很宽，但公共调用体验不是一个稳定的单函数 SDK：调用者通常需要组装 `TurnRunner`、`AgentSession`、Gateway 或内部 runtime。
- Claude SDK 的优势在于把 agent loop、工具、Hooks、Subagents、MCP、会话和结构化输出收敛到 `query()`/`Options`；PilotDeck 的优势在于宿主拥有 session、turn、run、transcript、permission 和 Gateway 最终状态。
- “已有内部实现”不等于“已有对外 SDK”：本次新增的 `@pilotdeck/sdk` alpha 提供 `query()` façade、typed Gateway client、Claude 常用类型别名、SessionStore 镜像、session controls、permission/elicitation callback、SDK-owned MCP、native lifecycle hook callback bridge、Gateway-owned usage aggregate、output-style list/select/reload、带 transcript replay 的 checkpoint rewind，以及 PilotDeck 专有的 `client.cron` 定时任务资源。动态 `AgentDefinition` 已支持 per-agent model、fork-local MCP、只能缩小父技能域的 skills、child-only `memory: "disabled"`，以及 Gateway-owned experimental `background`；后者把 child fork 注册为可由 owning session 停止的 non-blocking task，保留 sidechain transcript，不复用 Bash runtime。生成的 task id 出现在流式 `tool.completed` 的 `data.backgroundTaskId`，供 `stopTask()` 使用；`backgroundTasks()` 只返回是否仍有活跃 background child。Claude 独有 hook event、observer/observerMessage、完整 `AgentDefinition` callback、完整 usage/cost/budget 语义仍是后续能力。`client.cron` 仍不等价于 query-level background task。具体完成度和 P0/P1/P2 归 Roadmap 唯一维护。
- `onUserDialog` 的 P2 experimental 表面除 native `elicitation` 外，还支持显式 `supportedDialogKinds: ["input", "select", "confirm", "form"]`：Gateway 仅在该 session 注册对应 request-user 工具，把请求作为 `user_dialog.requested` 事件投递，并由 SDK callback 回传字符串、boolean、schema-backed object 或取消。`userDialogMode: "manual"` 下，另一个 SDK renderer 可用 `client.dialogs.watch()` 接收同 session 的 requested/lease/settled best-effort 变更提示，再以 `list()` 取得权威快照并 claim/respond；`createManualUserDialogRenderer()` 还提供先 watch、后 list、lease 续租、renderer callback 与 respond/release 的 SDK 协调器。两者都不持久化状态、不带 lease token；重连或漏通知后必须 resync。`form` 使用 Gateway-only 的扩展 schema subset（object/array/string/number 常用约束、schema 型 `additionalProperties`，以及 `email`/`uri`/`uuid`/`date`/`time`/`date-time` 字符串 format），并支持受全局深度/节点、每分支 32 条与每个依赖映射 64 条限制的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`；Gateway 在解除 pending 前校验 object。未知 keyword、format 与 refs 会被拒绝。Gateway 保留 request id、pending lifecycle、类型/select/schema 校验、取消和终态所有权；这不是全量 JSON Schema renderer 或可持久化 dialog 状态机。

## 分类约定

映射文档和差距矩阵只使用以下状态：

- **等价**：主要语义、生命周期和结果形状一致。
- **部分等价**：可以完成同类任务，但控制面、事件、持久化或所有权不同。
- **PilotDeck 专有**：Claude SDK 没有直接对应的产品能力。
- **仅 Gateway/App Server 层**：能力存在于较底层协议，不在高层 SDK façade。
- **缺失**：本基线没有可证实的对应实现。
- **不适用**：Claude 产品特有，或不属于 PilotDeck AgentLoop core ownership。

## 官方资料

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md)
- [TypeScript API reference](https://code.claude.com/docs/en/agent-sdk/typescript.md)
- [Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop.md)
- [MCP](https://code.claude.com/docs/en/agent-sdk/mcp.md)
- [File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md)
- [OpenAI Codex SDK（背景对照）](https://developers.openai.com/codex/sdk.md)
