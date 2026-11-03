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

## 2026-11-03 审计记录

以 `6e3cab1c` 的 Git 跟踪文件为起点，识别到 508 个 `.test`／`.spec` 文件，约 74,172 行：Gateway 166 个、前端 204 个、UI 服务端 94 个、桌面 35 个、共享包 2 个、其他 7 个。文件数量不等于冗余数量；其中有大量文件系统、真实进程、权限、打包等集成测试。

| 发现 | 结论与处理 |
| --- | --- |
| 52 个服务端文件没有环境注解，继承全局 jsdom | 分离 server/node 与 client/jsdom projects；保留显式的 DOM 测试注解 |
| 12 个服务端文件、133 个用例的交错复测 | 原配置两次为 40.74、32.46 秒；新配置为 6.23、10.56 秒，全部用例通过。此数据仅代表本机该子集，不是完整 CI 的提速承诺 |
| `useChatSessionState`、`sessionLauncher` 各有一对 `.test`／`.spec` | 合并为每模块一个文件；比较执行器输出的完整用例名称，32 个场景全部保留 |
| 合并后的测试是否仍能识别错误 | 在独立工作区临时把消息执行目录错误地改为项目目录，合并后的测试按预期失败；随后恢复生产文件，确认无残留 diff |
| `streamSmoother` 的旧测试仍要求已移除的输出行为，且生产模块已没有调用者 | 历史提交 `f7342da2` 明确将其移出消息流管线；核对全部生产引用后删除死代码及旧测试，清理 CI 排除项，并验证实际的 store／实时消息／帧批处理测试 |
| 桌面入口只收集 `*.test.mjs` | 补收 `runtime-log-export.spec.mjs`、`uninstall-data.spec.mjs`，恢复 11 个涉及脱敏和数据保留／清理的场景 |
| 静态筛查标记 43 个包含源码读取与文本断言的文件 | 作为人工复核候选，不作为删除清单。发布权限、平台边界、恶意路径和安全策略的静态防线仍可能有独立价值 |
| 任何 UI 改动都会进入八个原生包构建任务 | 保留现有门禁，先提出按变更风险分层的方案；需要结合分支保护和发布策略再调整 |

中间阶段完整 UI／服务端回归执行了 296 个文件、2,637 个用例：2,597 通过、23 失败、17 跳过。随后沿生产导入图确认 smoother 已不用，删除其中 4 个临时改写的 smoother 用例及未使用模块；最终复跑收集 295 个文件、2,633 个用例：2,591 通过、25 失败、17 跳过。其中 23 个失败断言逐项匹配先前在干净 `main` 上复现的基线，另两个是本次高负载执行中的 Git／命令集成测试超时；随后用单 worker 单独复跑所属两个文件，24 个用例全部通过，耗时 78.18 秒。没有用新的跳过列表掩盖失败。桌面辅助测试 220 通过、9 个平台跳过；直接从 TypeScript 执行模型测试 128 项通过；实际聊天流及合并模块回归 126 项通过；UI 类型检查通过。

中间阶段完整回归用了 430.15 秒，末次复跑用了 610.80 秒。worker 数、超时参数、工作区及机器负载均会影响整体结果；本次不能证明完整仓库或 CI 已稳定加速，也不把墙钟差异归因于单一配置调整。上表交错子集测试才是本次环境优化的主要对照证据。慢速且易超时的系统集成测试需要独立调度和可控 fixture，而不是把整仓超时统一调大。

另以 `ui/src/main.jsx` 为入口检查相对静态导入图，标记了 `VersionBadge`、`DesktopBuildInfo`、`restartUi` 等仅由测试引用的旧入口候选，应继续核对其他入口及动态注册，再决定删除或把测试迁到实际入口。`LlmConfigurationStep` 同样不在主入口图中，但它实际编排了仍在使用的 `ProviderStep`、`ConnectionStep` 和 `useLlmSetup`；其模型保存、凭据与取消行为测试应保留，可将编排壳迁到测试 fixture。`i18n/testInstance` 则是有意存在的测试工具，不能把“不在生产入口图中”直接等同于无价值。

较大的文件也需要区别对待：`ui/server/routes/config.test.js` 有 2,945 行，`MessagesPaneV2.render.test.tsx` 有 1,899 行，`useSessionStore.streaming.test.ts` 有 1,763 行。对它们更合适的后续工作是按配置保存／引用修复／消息投影等责任划分断言，复用小型 fixture，把组合输入下沉到纯函数或协议契约层，界面层只保留独有交互与关键连通流程。它们不应被进一步合并成更大的回归文件，也不能仅凭行数删掉时序、数据完整性或安全用例。

运行时隔离还需继续完善：完整回归日志出现了用户目录中的 `auth.db` 路径，而 `ui/server/database/db.js` 在导入时会打开数据库并确保配置表存在。下一阶段应统一临时 profile／数据库目录，避免读取真实用户配置，也让需要真实 Git、HTTP、Python、文件链接权限的用例明确声明前提。此项尚未通过全局环境重写实施，不能声称本轮已经解决了全部测试隔离问题。
