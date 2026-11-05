# 测试选择与维护

日常修改应先验证受影响的行为，再执行所属模块的回归。完整测试仍保留；不要通过删除安全边界、掩盖失败或随意增加重试次数来缩短耗时。

## 运行入口

| 场景 | 命令 | 边界 |
| --- | --- | --- |
| 单个 UI／服务端模块 | `pnpm --dir ui exec vitest run <测试文件或目录>` | 文件过滤，不需要重建 Gateway 或下载桌面运行时 |
| 服务端回归 | `pnpm --dir ui test:server` | Node 环境；需要 DOM 的个别文件使用显式环境注解 |
| 前端回归 | `pnpm --dir ui test:client` | jsdom 环境 |
| 当前工作区改动 | `pnpm --dir ui test:changed` | Vitest 根据 Git 改动和导入关系选择测试 |
| 相对某分支的改动 | `pnpm --dir ui exec vitest run --changed=origin/main` | 适合评估分支影响；必须先同步远程引用 |
| 指定生产文件的关联测试 | `pnpm --dir ui test:related src/path/to/file.ts` | 只能追踪静态导入关系 |
| 完整前端及服务端回归 | `pnpm --dir ui test` | 两个 Vitest project；不会误收 `e2e/` 的 Playwright 用例 |
| 模型配置／请求／流式处理 | `node --import tsx --test "tests/model/**/*.spec.ts"` | 不需要完整生产构建；不等于完整 Gateway 回归 |
| 桌面辅助逻辑 | `pnpm --filter pilotdeck-desktop test` | 同时收集 `.test.mjs` 与 `.spec.mjs` |
| 启动的真实浏览器验收 | `pnpm --dir ui build` 后执行 `node ui/e2e/startup-continuity.smoke.mjs` | 验证实际绘制、主题、进度连续性与减少动画模式 |
| 完整 Gateway 回归 | `pnpm test` | 包含完整构建及文件系统／进程等集成测试，适合较大修改和发布验证 |

`test:changed` 和 `test:related` 不是完整 CI 的替代品。通过 `readFile` 读取的模板、脚本、工作流、图标和动态插件可能不在导入图中。修改这些资源、测试配置、依赖锁文件或共享协议时，要主动扩大到相应模块、原生环境或完整回归。

## 每个测试必须说明什么

新增或保留测试前，应能回答：**哪一种真实错误会让它失败？这个错误是否已经由同一边界的其他用例覆盖？**

- 优先断言用户看到的结果、协议载荷、持久化内容、退出码及资源释放。函数名、源码片段、CSS 类名和内部计数通常不是产品契约。
- Mock 外部模型、网络及不受测试控制的系统依赖；保留测试目标自身的行为。调用参数／次数只有在它们本身属于边界契约时才值得断言。
- 同一模块散落在 `.test` 和 `.spec` 文件中的小型测试可按行为分组合并，保留每个不同场景及独立清理。不要把多个不相关功能合并成一个巨大测试文件或一个从登录一路测到卸载的长流程。
- 参数化用例应覆盖不同分支或边界，不必枚举所有语言 × 主题 × 操作系统 × 协议组合。选择一个完整主流程，并对真正存在差异的维度补充针对性用例。
- 时间相关行为优先使用可控调度器、fake timers 或明确的就绪信号。不要用固定睡眠等待页面，也不要为了通过而将所有超时无限调大。
- 功能被移除或契约改变后，检查测试是否还要求旧实现。先确认当前产品需求和调用者，再改写或删除旧断言；不能根据“现在失败”来判定过时。
- 简单转发、常量或文案若已由消费者行为覆盖，不再为实现本身增加一个断言。安全、数据完整性和发布边界需要单独评估，不能仅按覆盖率或耗时裁剪。

## 必须保留的高风险覆盖

文件删除与路径逃逸、工作区检查点与回滚、密钥脱敏、权限与进程所有权、升级失败后的旧版本保护，需要真实边界验证。纯逻辑单测可以覆盖大量错误输入；集成测试只覆盖关键的持久化／系统交互；浏览器或原生流程负责最终交接。这三层的职责不同，不能仅因业务名称相同就判定重复。

例如，Linux 安装验收发现图标文件缺失时，应该检查实际包内容、桌面启动器的 `Icon` 引用和图标主题规范，再决定补齐打包产物还是更新检查。不能直接删除“安装后有图标”的验收。

## 后续 CI 分层建议

这部分是待评估的策略，不是当前工作流已经实施的变化：

1. 每次提交：类型检查、受影响的纯逻辑／组件／服务端测试，目标是尽快给开发者反馈。
2. PR：所属模块的完整回归；涉及系统边界时在对应操作系统运行集成测试；保留一个固定名称的汇总检查，避免条件任务导致 required check 缺失。
3. 涉及 Electron、原生依赖、安装更新、图标打包及锁文件的 PR：扩大原生包验证。
4. 定期构建和发布：执行 Windows/macOS 的 x64、arm64，以及 Linux DEB/RPM 的完整包矩阵。调整前先核对分支保护、发布约束和团队可接受的反馈时间。

目前任何 `ui/**` 修改都会触发八个原生包任务，另外还会执行三平台检查点回归和 Web／Docker 验证。这些检查有价值，但运行频率与变更风险的对应关系值得优化，不能只把成本归因于单元测试数量。

## 调研参考

- [Vitest projects](https://vitest.dev/guide/projects.html) 与 [性能分析](https://vitest.dev/guide/improving-performance.html)：先测量环境启动、导入与执行开销，再选择环境和运行范围。
- [VS Code 的测试分类](https://github.com/microsoft/vscode/blob/main/test/README.md) 与 [测试编写规范](https://github.com/microsoft/vscode/blob/main/.github/instructions/writing-tests.instructions.md)：区分 unit、integration、smoke、release sanity，并明确资源清理。
- [OpenCode 的测试入口](https://github.com/anomalyco/opencode/blob/dev/packages/app/package.json)：区分 unit、browser、E2E、组件与性能测试，没有要求所有修改都执行全部层级。
- [Continue 的 core 配置](https://github.com/continuedev/continue/blob/main/core/vitest.config.ts)：核心测试有独立入口与生命周期配置；不应仅因别的项目使用某个 runner 就迁移整个仓库。
- [Superpowers Writing Good Tests](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/writing-good-tests.md)：要求测试能指出具体会捕获的错误，反对只锁定实现文字及检查 mock 本身。
- [Anthropic webapp-testing](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md)：适合少量关键浏览器流程的探索与验收，不负责筛选单元测试。对于持续连接或轮询的页面，应等待具体就绪条件，不机械套用 `networkidle`。
- [Testing Library](https://testing-library.com/docs/guiding-principles/) 与 [Playwright](https://playwright.dev/docs/best-practices)：以可观察行为和隔离为核心。Playwright 的 [Test Agents](https://playwright.dev/docs/test-agents) 可辅助规划和维护；生成或修复的断言仍须人工核对其业务含义。

## 可重复验证与产物管理

先完成对应 checkout 的 Core、Desktop 和 Web 构建，再执行需要编译产物的验证。启动基准使用临时 PILOT_HOME，桌面模式另建 Electron userData；不要用真实凭据和日常对话做故障注入。

| 场景 | 入口与前提 |
| --- | --- |
| 启动基准与大量历史 | `node scripts/benchmark-startup.mjs --samples 3 --sessions 1000 --artifacts artifacts/startup --output artifacts/startup/summary.json`；加 `--serial` 对照串行启动，`--root <compiled-checkout>` 指定另一份已编译源码 |
| 会话列表磁盘读取基准 | `node scripts/benchmark-session-list.mjs 1000`；只使用合成会话，不等同于完整客户端启动时间 |
| 真实桌面故障注入 | `node scripts/benchmark-startup.mjs --desktop --fault slow-start --artifacts artifacts/startup --hold-ms 180000`；另支持 abort、oom、module-missing、web-module-missing、config-invalid；向产物目录写入 `stop` 文件可提前结束 |
| 启动界面演示 | Core、Desktop 和 Web 编译后执行 `node scripts/create-startup-preview.mjs`，使用本地 Web 服务查看 `/startup-preview.html`；只演示界面，正式构建会覆盖该页面 |
| Windows 安装器 | `node apps/desktop/scripts/verify-installer.cjs`、`node apps/desktop/scripts/verify-installer-shortcut.cjs`；检查真实 NSIS 宏、中文路径及快捷方式，需 Windows 和桌面构建依赖 |
| Windows 卸载与预览 | `node apps/desktop/scripts/verify-uninstaller.cjs`、`node apps/desktop/scripts/preview-installer.cjs`；产物分别写入 `artifacts/uninstaller-verification/` 和 `artifacts/installer-preview/` |
| Windows 系统通知 | `pnpm --filter pilotdeck-desktop exec electron scripts/verify-windows-notifications.cjs`；需先编译 Desktop，使用独立通知身份并清理 |
| TUI 权限交互 | `pnpm exec tsx scripts/tui-e2e-permission.tsx`；使用模拟 Gateway，无模型调用；仍应在临时 PILOT_HOME 中运行 |
| iLink 本地联调 | `pnpm exec tsx scripts/mock-ilink.ts`；启动本地模拟服务后通过 `/inject` 注入合成消息 |
| 模型协议实测 | `node scripts/smoke-llm-center-protocols.mjs` 默认跳过；显式设置 `PILOTDECK_RUN_LIVE_LLM_CENTER=1` 及对应环境凭据后才请求远端 |

消息流的稳定身份、历史与增量协调由 [session timeline 契约](architecture/session-timeline.md) 说明；思考参数由 [reasoning settings](reasoning-settings.md) 说明。API 文档、TRD 与 OpenAPI 分别面向调用、设计边界和机器契约，不因主题相同而合并删除。

临时截图、日志、请求记录、单次基准 JSON 和安装器预览放在 `artifacts/<topic>/` 或 `outputs/<topic>/`，使用后清理；不要提交本机路径、真实对话、用户文档、凭据或一次性执行结果。PR 描述记录本次验证，长期文档只保留行为契约、前提和复现入口。Git 忽略规则只忽略根目录的 `/test/` 和 `/test.ts` 草稿，模块内的正式测试正常跟踪。

测试隔离仍需逐项核对：`ui/server/database/db.js` 在导入时会打开数据库，系统集成测试也可能依赖 Git、HTTP、Python、文件链接权限或本地配置。使用临时 profile 和数据库目录，并明确平台前提；不能以单元测试通过替代真实安装、卸载或跨平台验收。
