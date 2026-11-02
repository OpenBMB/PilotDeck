# PilotDeck 配置架构与主流 Agent Harness 对照

> 状态更新（2026-11-02）：本文的配置统一部分仅保留为调研提案；实现已按用户要求回退，当前继续使用 main 的配置路径和格式。

日期：2026 年 11 月 2 日。代码基线：`fcf1ecc9`。面向 PilotDeck 配置架构和桌面运行时维护。

PD 最值得优先收敛的是配置解释和诊断入口。主配置已集中在 `pilotdeck.yaml`，但 UI 与 Gateway 分别维护默认值、校验和环境映射；MCP、权限和指令又有各自的作用域规则。用户很难判断某项设置保存在哪里、哪个进程正在使用、何时生效。

建议保留按职责划分的文件，建立共享配置核心和统一查看入口。先统一读取、校验、来源追踪与写入，再考虑文件迁移。Gateway 的 `134` 退出不能据此归因于配置分散；当前已确认的是故障现场信息不足。

## PD 当前配置与状态的边界

以下路径中的 `~/.pilotdeck` 通常可由 `PILOT_HOME` 改写；桌面 `userData` 是 Electron 管理的另一处目录。

| 内容 | 当前主要位置 | 读取和写入边界 |
| --- | --- | --- |
| 模型、Agent、路由、记忆、IM、定时任务、代理、Web 运行参数 | `~/.pilotdeck/pilotdeck.yaml`，或 `PILOTDECK_CONFIG_PATH` | Gateway 的 `loadPilotConfig` 与 UI 的 `pilotdeckConfig.js` 分别解释；UI 负责大量写操作 |
| 全局和项目 MCP | `~/.pilotdeck/mcp.json`、`<project>/.pilotdeck/mcp.json` | 项目同名 server 覆盖全局定义；桌面托管的 Computer Use server 另有保留名称和受控来源 |
| 工具授权偏好 | `~/.pilotdeck/permissions.json` | 包含 allow、ask、deny 和 skipPermissions，由权限模块独立读写 |
| 长期指令与规则 | 用户 `PILOTDECK.md`、`rules/*.md`，项目及目录级对应文件、`PILOTDECK.local.md` | 指令发现器按目录收集；属于模型上下文，不等同于程序配置或强制策略 |
| 桌面外观、硬件加速等 | `<userData>/appearance.json`、`appearance-images/` | 桌面进程读取；硬件加速等在进程启动前生效 |
| 浏览器外观和编辑器偏好 | `localStorage` 中的主题、编辑器和 `pilotdeck-settings` 等键 | 由前端读取，通常按浏览器与 origin 隔离；部分设置与桌面桥同步 |
| 用户及通知偏好、认证数据 | 默认 `~/.pilotdeck/auth.db`，可通过 `webui.runtime.databasePath` 调整 | UI 服务数据库负责；多用户部署具有用户作用域 |
| 登录凭证 | 模型 key 可在 YAML 或引用环境变量；微信另有 `weixin-credentials.json` | 尚无覆盖各类凭证的统一存储入口；微信默认路径直接基于系统 home，支持显式 credentialsPath |
| 会话、项目注册、自动任务执行记录、遥测队列、日志 | `projects/`、相关运行目录、`telemetry/`、桌面 logs | 主要是运行状态和诊断资料，不宜当作可共享配置导出 |

代码依据：[主配置加载](../src/pilot/config/loadPilotConfig.ts)、[UI 配置服务](../ui/server/services/pilotdeckConfig.js)、[MCP 加载](../src/mcp/config/loadMcpServerConfig.ts)、[权限设置](../src/permission/settings.ts)、[指令发现](../src/context/instructions/InstructionDiscovery.ts)、[桌面外观存储](../apps/desktop/src/appearanceStorage.ts)、[浏览器设置](../ui/src/components/settings/shared/hooks/useSettingsController.ts)、[数据库](../ui/server/database/db.js)、[微信凭证](../src/adapters/channel/weixin/WeixinChannel.ts)。

### 主配置实际如何生效

核心加载器先选定一个文件：调用方 `configPath` 优先，其次 `PILOTDECK_CONFIG_PATH`，再到 `PILOT_HOME/pilotdeck.yaml`。选定文件是替换入口，不是额外覆盖层。文件读取后叠加 `PILOT_AGENT_MODEL`；provider 凭证解析等还会按各自规则使用环境变量。不能把所有环境变量概括成同一种最高优先级。

`paths.ts` 虽然导出了 `getPilotProjectConfigFilePath()`，当前 `loadPilotConfig()` 并没有调用它自动合并项目 YAML，`PilotConfigStore` 也只监视选定的主配置文件。因此不能把 `<project>/.pilotdeck/pilotdeck.yaml` 当作已经生效的项目覆盖层。MCP 和指令文件则确实支持项目层。这是当前作用域体验不一致的一个来源。[路径函数](../src/pilot/paths.ts)、[配置存储](../src/pilot/config/PilotConfigStore.ts)

当前 `mergeConfigSources` 对对象递归合并，数组整体替换。运行中重载失败时，`PilotConfigStore` 保留上一次可用快照，并保留新的诊断；改动分类已有 next-request、runtime-live、next-runtime、restart-required 等基础能力，可以继续复用。[合并实现](../src/pilot/config/merge.ts)、[改动分类](../src/pilot/config/classifyChanges.ts)

### 优先处理的重复和隐式行为

1. **共享一个文件，却有两套解释器。** UI 的 `buildDefaultPilotDeckConfig`、normalize 和 validate，与核心 parser 的默认值和校验并存。UI 的宽容默认值支持首次配置流程，Gateway 的完整校验支持启动运行；两者可以有不同模式，但应调用同一套字段定义和规则。
2. **环境变量混合了输入和派生结果。** `buildRuntimeEnv()` 将 YAML 转成环境变量，`applyConfigToProcessEnv()` 再修改 UI 服务的 `process.env`。以后重新读取时，某些派生变量会像外部输入一样参与决策，来源不再清楚。[环境映射](../ui/server/services/pilotdeckConfig.js)、[启动加载](../ui/server/load-env.js)
3. **多进程传播需要显式契约。** `customEnv` 由 UI 映射到自己的环境；桌面父进程则提前保存 `commonEnv`，再用它分别启动 UI 和 Gateway。沿这条代码路径推断，UI 后续改动自己的环境不能保证传到 Gateway。应通过统一解析结果或明确的启动参数传递，不能依靠子进程修改父进程环境。[桌面启动](../apps/desktop/src/main.ts)
4. **同一 home 路径有多种实现。** 核心和 UI 另有一份注明“保持同步”的路径辅助实现，UI 配置服务还保存模块初始化时的 home 常量；微信默认凭证路径直接使用 `homedir()`。应统一路径解析并明确旧凭证兼容规则。[核心路径](../src/pilot/paths.ts)、[UI 路径](../ui/server/utils/pilotPaths.js)
5. **设置入口没有呈现作用域和生效时机。** 浏览器、桌面设备、用户、项目、运行时选项并列出现，保存成功并不说明当前 Gateway 已使用该值。UI 应显示来源、覆盖关系和是否需要重启。

## 主流 Agent Harness 的设计对照

这些工具普遍允许多个文件。真正值得借鉴的是稳定的职责划分、明确的覆盖规则和可查询的最终生效值。下面按当前官方文档比较；环境变量、策略和个别字段可能有专门规则。

| Harness | 配置与作用域 | 覆盖及合并要点 | 对 PD 的启发 |
| --- | --- | --- | --- |
| Codex | 用户 `~/.codex/config.toml`，可信项目 `.codex/config.toml`，profile 等层 | CLI 高于可信项目层，再到 profile、用户、组织默认、系统默认和内置默认；强制 requirements 与默认值分开 | 保留项目覆盖，但先明确可信边界和策略约束；CLI 与 IDE 使用共同配置层。[官方说明](https://learn.chatgpt.com/docs/config-file/config-basic) |
| Claude Code | 用户 `settings.json`、项目共享 `settings.json`、项目私有 `settings.local.json`，另有 managed 配置 | managed、`--settings`、项目私有、项目共享、用户依次降低；许多列表合并，部分有序模型字段例外；环境变量按字段处理 | 区分团队可提交配置和个人项目偏好；不要把不同字段的合并规则藏在通用 deepMerge 中。[官方说明](https://code.claude.com/docs/en/settings) |
| Gemini CLI | 用户及项目 `.gemini/settings.json`，另有 system-defaults 与 system settings | 默认、系统默认、用户、项目、系统覆盖、环境、CLI 逐层提高；配置有 JSON Schema | 系统默认与强制覆盖分别建模；前端和运行时共享 schema，解释哪些设置需要重启。[官方说明](https://geminicli.com/docs/reference/configuration/) |
| OpenCode | JSON/JSONC 的用户、项目配置和 `.opencode` 资源；TUI 独立 `tui.json` | 从远端默认到全局、自定义路径、项目、资源目录、inline 与 managed 逐层合并；不冲突字段保留 | 可把 UI 偏好与服务运行参数分开，同时保留统一解析和 debug config 入口。[官方说明](https://opencode.ai/docs/config/) |
| Pi | 默认 `~/.pi/agent/` 下独立的 settings、models、MCP、auth 和资源文件；项目 `.pi/` | 项目配置在信任后加载，设置覆盖用户层，资源列表另有组合规则 | 文件按职责拆分仍能清楚；模型端点、凭证和用户偏好无需装进同一个文件。[官方配置](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/configuration.md)、[设置规则](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) |
| OpenClaw | 中心 JSON5 `~/.openclaw/openclaw.json`，支持 include、环境引用和秘密引用等能力 | 严格 schema；无效启动配置拒绝启动；无效热重载保留当前可用配置；向导、CLI 和控制 UI 共用 schema | 与 PD 的 Gateway、多渠道场景更接近，值得借鉴字段级 schema 查询、doctor 和可恢复迁移。[官方说明](https://docs.openclaw.ai/gateway/configuration) |

Claude Code 自身也把部分账号、MCP 和项目状态放在 `~/.claude.json`。因此“文件少”不能单独作为架构质量指标；需要看每个字段是否有明确的归属、加载规则和恢复机制。[官方说明](https://code.claude.com/docs/en/settings)

## PD 建议的目标架构

### 一个配置核心和清楚的文件职责

保留 YAML 作为主配置格式，避免在统一行为的同时更换序列化格式。抽出不依赖 Electron、Express 或 React 的共享配置核心，供 UI、Gateway、CLI 和桌面启动器调用。核心统一处理路径、默认值、迁移、凭证引用、字段校验和诊断，支持“首次配置的部分文档”与“可启动的完整配置”两种校验模式。

| 类别 | 建议归属 | 约束 |
| --- | --- | --- |
| Agent 和服务行为 | 保留 `pilotdeck.yaml`，后续添加明确的项目覆盖层 | 每个字段声明允许的作用域；项目不能重设全局监听地址、认证库路径等服务级参数 |
| MCP | 保留现有 `mcp.json` 兼容入口，纳入统一来源查看和校验 | 区分用户配置、可信项目配置与桌面托管 server；明确同名 server 的覆盖规则 |
| 权限 | 纳入共享核心的权限域，先兼容读取 `permissions.json` | deny 规则与管理员约束有独立语义，不使用普通对象覆盖实现权限放宽 |
| 桌面与浏览器外观 | 作为设备或用户偏好域，继续由合适的本地存储负责 | 启动前选项必须能在渲染器加载前读取；Web 多用户偏好不能退化成设备全局值 |
| 凭证 | 从共享配置中引用环境或独立凭证存储 | UI 展示引用来源，不回传明文；迁移应保留现有 `${ENV}` 引用 |
| 状态与缓存 | 会话、登录状态、项目注册和日志继续由状态存储负责 | 明确区分备份、配置导出和故障诊断导出 |

### 覆盖顺序与项目作用域

建议普通偏好采用：内置默认 → 用户配置 → 可信项目共享配置 → 项目私有配置 → 明确登记的环境覆盖 → 当前会话或 CLI 覆盖。管理员约束在最终结果上独立校验。平台路径、监听端口等启动参数另有专门作用域，不能让某个项目配置改变其他项目使用的共享 Gateway。

对象按字段合并，普通有序数组整体替换；权限规则、资源目录、模型列表各自声明规则。`null` 是否意味着清空、删除还是非法，也应逐字段定义。共享项目配置不得自动携带认证秘密、启用可执行 hooks 或新增未受信任的 MCP 执行项。

实现项目 YAML 前还要处理一个现有行为：`ensurePilotProjectGitIgnore()` 会向 `.pilotdeck/.gitignore` 追加 `*`。如果项目配置要进入版本控制，必须先划清可共享文件与内部运行文件，不能仅增加一个加载步骤。[现有忽略规则](../src/pilot/paths.ts)

### 能解释最终值的配置接口

建议提供 `pd config paths`、`pd config inspect`、`pd config explain <key>` 和 `pd doctor` 等能力，名称可与现有 CLI 命令体系对齐。下面是目标接口示例，不是当前已实现命令：

```text
pd config explain agent.model

effective: provider/model
source: user
path: ~/.pilotdeck/pilotdeck.yaml
overriddenSources: []
appliesTo: next-request
revision: ...
```

UI 使用同一接口：每个设置展示作用域、最终来源、被覆盖原因和生效时机；保存时指定目标作用域。写入采用原子替换与 revision 比较，并为多个进程提供统一写入协调。当前 UI 的 Promise 写队列只串行化同一进程中的调用，不等于跨进程互斥。

`doctor` 应在 Gateway 没启动时仍能运行，报告文件语法、字段路径、缺失的凭证引用、实际路径、运行时版本和安装完整性；诊断导出默认隐藏秘密。配置错误、端口占用、依赖错误和 Node 致命退出要分开，原始退出码和堆栈继续保留。

### 升级与恢复

迁移按 schema 版本逐步执行，先验证完整的新配置，再原子写入，保留有上限的备份。比当前程序更新的 schema 应明确拒绝破坏性回写。热重载继续保留 last-known-good 快照；启动失败时给出精确字段诊断和显式恢复入口，避免静默改掉模型、凭证或权限。

## 分阶段落地

| 阶段 | 改动 | 可验收的结果 |
| --- | --- | --- |
| 当前故障诊断 | 启动前开启 Node 致命报告，保留阶段、退出信息和 stderr，提供日志入口 | `134` 无错误证据时保持未知；受控 OOM 能读到具体原因；报告不包含环境变量 |
| 共享配置核心 | 合并路径、默认值、schema、迁移与校验；保留现有文件 | 同一份配置在 UI、CLI 和 Gateway 得到相同标准化结果；首次配置模式显式区分 |
| 配置可解释性 | paths、inspect、explain、doctor 与设置页来源展示 | 能回答设置存在哪、谁覆盖它、哪个运行时已采用、是否需要重启 |
| 项目配置 | 增加信任检查、共享与私有层、逐字段作用域和 git 规则 | 多项目共用 Gateway 时互不污染，团队配置能提交且不会带出个人凭证 |
| 凭证与偏好整理 | 逐类迁移，兼容旧读路径并清楚标记权威写入位置 | 凭证、设备偏好和服务配置各有稳定归属，迁移中不存在双写竞争 |

本分支只实现第一阶段的已确认诊断缺陷。其他阶段是后续设计建议，尚未改变现有配置格式或覆盖顺序。真实用户的 `134` 根因仍需由故障日志或致命报告确认。

致命报告通过子进程 stderr 送到桌面父进程，再保存到 `<logs>/diagnostics/gateway-<diagnostic-id>.json`；原始流同时保留在 `runtime.log`。受控测试发现内置 Windows Node 22.23.1 直接写含中文的 report-directory 会失败，因此采用父进程保存。Node 原生报告写入路径使用 `std::ofstream`，也提供 stderr 输出分支。[对应 Node 源码](https://github.com/nodejs/node/blob/v22.23.1/src/node_report.cc#L807)
