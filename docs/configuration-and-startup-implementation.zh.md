# PilotDeck 配置迁移与启动优化实施方案

日期：2026 年 11 月 2 日。分支：`codex/gateway-startup-diagnostics`。

## 约定与验收目标

用户配置以 `~/.pilotdeck` 为默认根目录，保留 `PILOT_HOME` 和显式主配置路径的兼容能力。模型及 Agent 主配置继续使用 `pilotdeck.yaml`；其余用户配置按功能使用 YAML。项目级配置留在项目的 `.pilotdeck` 内。密钥按用户选择保存到 YAML，文件使用限制性权限，接口和日志隐藏明文。

旧 JSON、桌面 userData 和浏览器偏好需要迁移；新版 YAML 一旦存在即成为权威来源。迁移保留原件或备份，不在每次启动时重新导入旧值，且软件安装目录、版本号和临时端口不能决定用户配置目录。会话记录、认证数据库、诊断报告、第三方协议文件和可再生缓存属于状态或互操作产物，保持各自格式；它们依赖的用户设置、身份凭证和密钥需有持久化来源。

配置读取不能因单个错误终止程序。合法兄弟字段保留；非法字段恢复各自默认值并给出字段路径、错误码及日志位置。损坏 YAML 尽可能保留可解析节点，并备份原件；无法恢复的部分采用默认值。默认密钥为空、可选集成关闭、权限不自动放宽；没有可用模型时进入配置界面。写入接口仍应明确报告写入失败或非法用户提交，不能谎报保存成功。

## 配置职责

| 文件或目录 | 职责 |
| --- | --- |
| `pilotdeck.yaml` | 模型、Agent、路由、记忆、IM、服务、代理及定时任务配置 |
| `appearance.yaml` 与 `appearance-images/` | 桌面及可持久化外观设置、背景资源 |
| `notifications.yaml` | 桌面通知配置及需要恢复的通知状态 |
| `permissions.yaml` | 工具 allow、ask、deny 与权限偏好 |
| `mcp.yaml` | 用户 MCP 定义；项目同名文件保留项目作用域 |
| `computer-use.yaml` | Computer Use 用户开关；连接信息属于可再生协议产物 |
| `credentials/` | 按集成划分的 YAML 凭证，保留旧凭证入口迁移 |
| `users/` | Web 用户隔离的偏好与密钥配置，浏览器 localStorage 仅作为缓存及旧版导入源 |
| `backups/configuration/` | 修复或迁移前的原始文件，避免覆盖有效凭证 |

具体文件可按功能增加，必须登记读取方、写入方、默认值、迁移源和重载时机。共享配置包负责 YAML 读写、原子替换、并发写入、路径和迁移规则，不允许各服务继续复制这些逻辑。

## 错误体系

错误码表达稳定类别，不承担唯一根因识别。所有启动失败、进程错误、超时、配置恢复、文件系统与未知异常必须可映射；未知类别统一兜底。每次故障保留诊断编号、阶段、原始 code/signal、异常链和日志路径。配置警告与阻止启动的运行环境故障区分。诊断导出不包含环境变量或密钥明文。

## 启动性能调查

分别记录进程启动、模块导入、Computer Use 初始化、UI 服务监听、Gateway 就绪和界面可用时间。使用隔离数据目录、无真实 API 请求的固定配置、多轮同机测试；区分源码 tsx、编译产物与安装包，不能把转译开销误当成发行版性能。

重点验证：Windows 每次创建进程的身份查询和 PowerShell Job 初始化、主进程串行等待、UI/Gateway 静态依赖图、启动时重复配置解析、遥测 Git 探测和非必要功能的初始化。优化必须保留进程归属与退出清理，不能用裸 PID 替代身份校验。

DeepSeek Harness 的启动器只加载所选 runner，Desktop 在 Host 启动时立即加载打包 UI，使用 IPC 传递就绪状态；这支持将界面可用与可选功能准备分离的方向。[DSH CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、[DSH Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)

Electron 官方建议减少启动时模块加载、避免同步阻塞并测量主进程工作。WorkBuddy 文档确认旧模型配置持续兼容和 UI 自动保存，但公开文档没有可直接对比的同机启动基准；竞品的速度不能由文档推算。[Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)、[WorkBuddy 模型配置](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)

## 分功能提交顺序

1. 共享 YAML 存储及迁移基础，验证原子写入、并发、损坏文件恢复和权限。
2. 主配置逐项容错与默认值，验证模型及集成部分损坏不会阻止界面启动。
3. 迁移 MCP、权限、桌面偏好、集成凭证和浏览器偏好，逐项验证旧版到新版与重启恢复。
4. 统一错误映射与启动日志提示，覆盖进程退出、spawn、超时、I/O 和未知异常。
5. 增加性能基线与阶段计时，按测量结果优化模块加载及启动路径。
6. 升级模拟、全套相关回归与文档，记录实际测量结果、提交和剩余限制。

每个提交仅包含对应功能及验证；已有用户改动不纳入。使用临时目录验证故障与升级，不修改开发者现有密钥、配置或外观文件。
