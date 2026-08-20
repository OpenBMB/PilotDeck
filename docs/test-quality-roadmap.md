# PilotDeck 测试质量建设路线图

状态：规划中  
范围：当前 `feat/cicd_0805` 及其后续合并到 `main` 的代码  
目标：为确定性核心模块建立可信的 100% 单元覆盖样板，为状态机和外部链路建立分层证据。

## 目标与边界

“单元测试 100%”只对可离线、确定性、边界清晰的模块承诺。全仓库不设置统一 100% 阈值，以下内容不纳入核心单元 100%：

- CLI 顶层启动、副作用初始化和操作系统集成。
- 真实模型、公共网络、Docker、浏览器和平台账号链路。
- 生成代码、第三方代码、内置资源和仅负责装配的薄入口。

这些路径必须有入口 smoke、artifact smoke 或 nightly 证据，但不能用虚假的 mock 覆盖率替代真实链路验证。

当前基线：现有 `pnpm test:coverage` 只统计 Gateway、模型协议/streaming 的选定测试，最近一次 Node 22 运行约为 46.2% lines、49.6% functions、57.1% branches。这个数字是局部基线，不代表全仓库覆盖率；P0 的第一项工作是扩大统计范围并输出未加载源码清单。

核心覆盖目标：

| 范围 | Lines | Functions | Branches | 证据 |
| --- | ---: | ---: | ---: | --- |
| `src/model/protocol/**` | 100% | 100% | 100% | node:test + mutation |
| `src/model/streaming` 纯 parser/assembler | 100% | 100% | 100% | node:test + malformed fixtures |
| `src/gateway/protocol/**` | 100% | 100% | 100% | frame/contract tests |
| Gateway server/client 状态机 | 90%+ | 90%+ | 85%+ | process smoke + mutation |
| Router/config 纯函数 | 100% | 100% | 100% | node:test |
| Router runtime/session store | 90%+ | 90%+ | 85%+ | state tests + mutation |
| Session/file safety | 90%+ | 90%+ | 85%+ | temp-dir tests + mutation |
| UI store/reducer/protocol helpers | 100% | 100% | 95%+ | Vitest |
| UI hooks/components | 90%+ | 90%+ | 85%+ | Vitest + public entry smoke |
| Adapters/external/platform | 不设单元阈值 | 不设单元阈值 | 不设单元阈值 | fake transport/nightly |

## 阶段计划

### P0：基线与证据体系

目的：先知道哪些源码被加载、哪些分支没有证据，再提高阈值。

工作项：

- 扩展 `scripts/test-coverage.mjs`，输出 Node 核心范围的 summary、未加载文件和低覆盖分支。
- 为 UI 增加 Vitest V8 coverage，至少覆盖 `useSessionStore`、协议 reducer、chat hooks。
- 固定覆盖配置，不允许通过排除生产源码提高数字；排除项必须记录原因。
- 为 coverage 结果保留基线趋势，第一阶段只报告不阻塞。
- 将当前 `pnpm check`、`test:contract`、`test:artifact`、mutation proof 和 nightly 的职责写清楚。

测试交付：覆盖率报告、未加载模块清单、核心模块阈值配置、失败时可定位到模块和分支。

文档交付：更新 `docs/quality-gates.md`、`docs/test-recovery-audit.md`，必要时新增 `docs/agent-notes/` 决策记录。

验收：Node 22 下报告可重复；缺少 fixture、配置或凭证明确失败；不改变当前 required-check 状态。

### P1：模型协议四协议 100%

范围：OpenAI Chat、OpenAI Responses、Anthropic Messages、Google Gemini 的纯 request/response/stream 转换。

重点模块：

- `src/model/protocol/clone.ts`
- `src/model/protocol/multimodal.ts`
- `src/model/protocol/errors.ts`
- `src/model/providers/*/{request,response,stream}.ts`
- `src/model/streaming/{normalizeStreamEvent,assembleModelMessage,toolCallFormats,repairToolName}.ts`

测试矩阵：正常输入、空值、缺字段、错误类型、usage/finish reason、tool-call 分片、重复和乱序 chunk、SSE 断流、malformed tool call、cache breakpoint 上限、错误归一化、输入深拷贝隔离。

验收：目标目录 lines/functions/branches 100%；每个协议至少有一组表驱动 malformed fixture；至少 3 个关键修复有反向 mutation proof。

文档交付：新增 `docs/agent-notes/model-protocol-contracts.md`，记录 canonical event、终态和 provider 差异；更新审计表的映射和状态。

### P2：Gateway 协议与生命周期

范围：WebSocket frame、HTTP health/auth、submit turn、RPC response、active replay 和 close/abort 生命周期。

测试交付：

- hello 成功、错误 token、协议版本错误、非法 JSON、非法 frame。
- request/response/event/final 配对及 seq 单调性。
- pending request 在 close 时全部 reject。
- busy session、abort 等待完全退出、旧 run 迟到事件隔离。
- permission/elicitation 只 replay 未完成请求。
- server shutdown、重复 close、端口释放和 timer 清理。

验收：`src/gateway/protocol/**` 100%；server/client 状态机达到阈值；所有协议字段变化都有 contract test；artifact smoke 通过。

文档交付：更新 `docs/quality-gates.md` 的 contract gate 说明，更新 `docs/test-recovery-audit.md` 的 Gateway 行。

### P3：Router、配置和持久化状态

范围：orchestration、token saver、fallback、配置 reload、Router session store 和 stats。

测试交付：

- `allowedTools` 未配置、空数组、无匹配、多匹配，以及 allowlist/blocklist 优先级。
- prompt 注入、重复编排禁止、subagent 降级和 session sticky 隔离。
- fallback、zero-usage retry、retryable error、模型冲突软恢复。
- reload 成功、失败保留旧 snapshot、MCP save 触发 extension reload。
- store 文件损坏、并发写、恢复和旧状态保留。

验收：纯函数 100%；runtime/store 达到阈值；每个历史高风险修复至少一个 mutation case；失败不会静默退回默认配置。

文档交付：新增 `docs/agent-notes/router-and-config-contracts.md`，记录 allowlist 语义、reload 原子性和 retry 规则。

### P4：Session、文件和安全边界

范围：transcript、SessionList、FileHistory、workspace/path safety、attachment 和 editor save。

测试交付：

- 损坏/截断 JSON、重复事件、metadata 缺失和旧格式 replay。
- 首次快照幂等、创建文件回滚、快照淘汰、恢复失败。
- workspace ID 碰撞、`..`、相似前缀、符号链接和跨盘符逃逸。
- 编辑器加载失败禁止空覆盖、Office/binary/attachment 边界。

验收：path safety、backup naming、纯恢复函数 100%；FileHistory/TranscriptReplay 达到阈值；全部使用临时目录和短 timeout。

文档交付：新增 `docs/agent-notes/session-and-file-safety.md`，同步 `docs/test-recovery-audit.md` 的 FILES/SESSION 映射。

### P5：Tool、权限和执行恢复

范围：builtin tool 输入、permission/safety、scheduler、timeout/abort、结果截断和引用。

测试交付：

- 每个 builtin tool 的缺参数、错误类型和结构化错误。
- deny/allow/safety precedence、plan/bypass 边界。
- timeout、abort、non-zero exit、tool call/result 严格配对。
- 大结果截断、持久化引用、binary/Office 拒绝和路径安全。

验收：纯 helper 100%；执行 runtime 达到阈值；每个 tool 至少一条失败路径和一条取消路径；不使用 `any`、`ts-ignore` 或弱化断言。

文档交付：更新 `AGENTS.md` 的 tool 不变量说明，并新增 `docs/agent-notes/tool-and-permission-contracts.md`。

### P6：UI 状态与历史/live 一致性

范围：store/reducer、Gateway bridge、chat hooks、WebSocket reconnect 和 editor 状态。

测试交付：

- 跨 session pending/working 隔离、迟到响应不能覆盖当前 session。
- history/live 合并一致、旧连接事件丢弃、active run identity 配对。
- queued send、force-send、abort、permission/elicitation 状态机。
- editor dirty state、加载失败、导航恢复和缓存一致性。

验收：store/reducer/protocol helper 100%；hooks 90%+；优先行为断言，不引入大规模 snapshot；Playwright 继续非阻塞。

文档交付：新增 `docs/agent-notes/ui-state-contracts.md`，更新 `docs/quality-gates.md` 的 UI coverage 说明。

### P7：平台入口与外部链路

范围：WeCom、Feishu、Weixin、Signal 及其他 adapter；真实模型、浏览器、Docker、桌面和 Office。

测试交付：

- 代表平台通过公开 `start()`/`stop()` 和 fake transport 覆盖 inbound、reply、busy、reconnect、cleanup、duplicate delivery。
- 其他平台至少保留 renderer/helper 单测和明确的延期项。
- external nightly 按 provider/group 矩阵运行，缺 secret 明确失败。
- Playwright smoke 覆盖主 UI workflow，但不成为 required PR check。

验收：无真实账号的入口测试全绿；nightly 产物脱敏；平台和桌面缺少 runner 时保持 `DEFER_EXTERNAL`，不得标记为 `COVERED`。

文档交付：更新 `docs/test-recovery-audit.md` external rows、`docs/quality-gates.md` nightly 入口和延迟清单。

## 每批交付协议

每个阶段必须同时提交：

1. 生产行为对应的确定性测试或明确的 external/deferred 记录。
2. 对应的 coverage/mutation 证据；不能只报告“当前通过”。
3. `docs/test-recovery-audit.md` 的当前测试映射和状态变更。
4. 相关 `docs/agent-notes/*.md` 或现有文档的契约更新。
5. 变更说明中的测试命令、Node/pnpm 版本、环境限制和未覆盖项。

## CI 提升策略

当前 CI 继续运行但不作为合并必需项。门槛按以下顺序提升：

1. P0：只上传 coverage 和 trend，不阻塞。
2. P1-P3：只对已达到目标的核心目录启用 coverage gate。
3. 连续两个迭代周期稳定后，再由管理员单独决定是否启用 Branch Protection。

最终 gate 结构保持：`static`、`unit`、`contract`、`build`、`artifact`、`coverage-core`、aggregate verdict。Browser smoke 和 external nightly 独立运行，不混入普通 PR 单元门禁。

## 完成定义

- Node 22.23.1、pnpm 10.32.1 下定向测试和 `pnpm check` 通过。
- 核心 100% 目录的 lines/functions/branches 均有报告和可复现证据。
- 高风险状态机有 mutation proof，不能仅依赖修复后通过。
- 测试不使用真实 sleep、公共网络、真实模型、平台账号或开发者 home。
- `git diff --check` 通过，状态中没有 dist、node_modules、coverage 产物、临时配置或 token。
