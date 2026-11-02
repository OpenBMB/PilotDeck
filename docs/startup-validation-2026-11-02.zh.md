# 启动修复验证记录

日期：2026-11-02。基线 main：`fcf1ecc9`。当前分支：`codex/gateway-startup-diagnostics`。

## 变更范围

按用户最新要求，配置统一和 YAML 自动迁移已回退，提交为 `9cdf878f`，并由 `e31b40e3` 清理延期的偏好路由引用。主配置、MCP、权限、桌面设置、Computer Use 和凭证存储的原读写实现与 main 一致。启动入口的原文件位置保留。保留错误诊断、日志、Windows 原生 Job 辅助程序、按需模块加载与遥测队列限制。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| Core 与 Desktop TypeScript 编译 | 通过 |
| Web TypeScript 检查与 Vite 生产构建 | 通过 |
| Core 配置/权限/MCP/遥测相关回归 | 46 项通过 |
| 进程管理、桌面关闭、错误接口及错误界面回归 | 36 项通过；6 项为其他操作系统用例而跳过 |
| Node 致命错误诊断 | 6 项通过，包含真实 OOM、中文目录报告、分片 stderr 和日志写入失败 |
| 错误分类与脱敏 | 2 项通过，覆盖嵌套 cause、未知 134、权限/端口/超时、配置错误及 query key |
| Web 更新相关回归 | 23 项通过，单独以 20 秒超时执行 |
| 工作区及打包运行时 frozen lockfile | 均通过 |
| 隔离编译版真实启动 | 3 轮通过；Web/Gateway 就绪、项目 HTTP 接口及旧配置字节不变均验证 |
| Windows Electron 界面 | 已实际启动临时配置实例，看到中文主界面、模型选择及输入框；日志确认 bridge 成功连接 Gateway |

没有调用真实模型 API，未使用开发者现有配置或密钥进行迁移。没有制作或验证完整签名 NSIS 安装包，也没有在 macOS/Linux 实机运行。

## 性能测量

同一 Windows x64 主机、Node 22.23.2、相同依赖，使用独立 profile 和编译产物，先启动 Web，再启动 Gateway。

| 指标 | main | 保留诊断与性能修复、回退 YAML 后 |
| --- | --- | --- |
| 已有 profile：Web 就绪 | 4.84–4.90 秒 | 2.90–2.95 秒 |
| 已有 profile：Web＋Gateway 就绪 | 9.88–9.99 秒 | 5.74–5.80 秒 |
| 当前项目接口可用 | 未采集此指标 | 6.12–6.15 秒 |
| 空受管理进程启动 | 2.55–2.66 秒 | 0.55–0.60 秒 |

已有 profile 的后端就绪时间减少约 42%。首轮数据另存于 JSON，受磁盘缓存、数据库初始化和首次权限准备影响，不把其比例作为冷启动承诺。这是 PilotDeck 自身同机对照，不是与 WorkBuddy、Hermes 或 DSH 的实测排名。

原始数据：[Windows 启动样本](benchmarks/windows-startup-2026-11-02.json)。复现：先完成 Core 编译，再运行 `node scripts/benchmark-startup.mjs --samples 3`；比较另一个已编译 checkout 时使用 `--root <path>`。`--desktop` 会创建独立 Electron userData 和临时配置，显示调试窗口后清理受管理进程。

## 全量测试的限制

探索阶段跑过完整 UI 测试，未全绿，不能把它宣称为全套通过。问题包括 Vitest 收集 Playwright e2e 文件、Windows 无文件符号链接权限、macOS 路径夹具在 Windows 上使用 POSIX 分隔符，以及部分原有计时测试。计时失败已在 main 隔离 checkout 复现；更新测试在放宽到正常集成测试超时后 23 项通过。相关配置读写模块已恢复 main，因此不为修复这些旧测试而继续改动它们。

原有 MCP 安装命令测试在缺少 POSIX shell 的 Windows 夹具中也会失败；该实现不属于这轮修改。最终受影响的诊断、进程生命周期、配置兼容与启动主流程按上表单独完成验证。

截图中的用户故障还缺少真实崩溃日志：134 本身无法区分 OOM 与其他 abort。本分支已验证分类和日志采集，但没有据此声称找到了所有用户报告的唯一根因。
