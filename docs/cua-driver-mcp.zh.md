# PilotDeck 电脑操控：内置 Driver + MCP

## 统一设置页面

浏览器与桌面客户端均在「设置 → 外部集成 → 电脑操控」中配置，显示相同的开关、系统权限和连接状态。入口位于「Office 预览」下方，默认关闭。页面统一调用经过认证的 `/api/computer-use` 接口，由后端返回能力和权限归属，不依赖 Electron 的前端桥接。

桌面安装包和网页部署环境均携带固定版本 `0.34.1` 的 Cua Driver，用户无需另行安装或配置 MCP。源码构建及标准网页启动脚本会自动准备这一依赖，校验归档 SHA-256 后放入 `resources/cua-driver`；桌面安装包将同一目录放入 `Resources/runtime/resources/cua-driver`。后端默认只查找随包资源，不依赖 PATH、用户的安装记录或 `/Applications/CuaDriver.app`。只有部署者明确配置 `PILOTDECK_CUA_DRIVER_PATH` 时才借用指定的外置服务。

1. 打开「启用电脑操控」。macOS 权限不足时显示「等待系统授权」，此时不向 Agent 提供内置工具。
2. macOS 使用「前往授权」，在系统设置中给页面提示的应用开启「辅助功能」和「屏幕录制」：桌面正式包为 **PilotDeck**，开发宿主为 **Electron**，独立网页后端为 **PilotDeck Computer Use**（环境包内的原生组件，所有系统语言均使用此英文名称）。这些应用的授权彼此独立。
   独立网页的授权请求异步启动原生宿主，网页不会等待系统确认而超时。授权宿主最多保留五分钟，供用户处理系统提示、登录密码或 Touch ID；授权完成、重新检测、关闭功能或后端退出时结束。屏幕捕获探测返回未授权不会提前关闭首次授权弹窗。
   若系统列表没有显示应用，展开「授权列表里没有应用？」。点击「显示授权应用」在 Finder 中定位正确应用并拖入权限列表，或复制应用路径，在系统设置的 `+` 选择窗口中按 `⌘⇧G` 粘贴。权限不足时这段引导默认展开。路径由后端提供：桌面端指向拥有权限的外层 PilotDeck/Electron 应用，独立网页指向包内原生组件。显示应用的接口只使用宿主选定的路径，不接受网页传入的路径，也不启动 Driver 或发起授权。
3. 授权后点击「重新检测」。独立网页会重新启动所属组件，使新进程读取授权；若系统仍要求重开桌面客户端，则按系统提示退出并重新启动。状态为「已连接，可使用」后可在任务中请求电脑操控。
4. 「停止并关闭」会撤销此实例的 MCP 连接并保存关闭偏好。实例拥有的 Driver 子进程会停止；默认内置的网页 Driver 也会停止；仅明确配置的外置共享服务会保留。正常退出也会撤销连接并清理实例拥有的进程，但保留开关偏好供下次启动。

操作审批沿用当前任务的权限设置，模型须支持图片输入。此版本使用本机登录用户的真实桌面，多个任务仍可能争用同一桌面，按单任务使用。Driver 崩溃后显示错误，由用户重新检测；不会自动重放完成情况不明的动作。

页面访问方式不决定权限归属。桌面后端通过已有的私有父子进程 IPC 将 HTTP 请求交给 Electron 主进程，保持直接 GUI 宿主关系；独立网页后端通过 LaunchServices 启动包内 `PilotDeck Computer Use.app`，使用私有 socket 和 FIFO 生命周期管道；Node 退出或开关关闭时，FIFO 关闭使 Driver 结束，不会连接或停止系统上另装的 CuaDriver。这个轻量原生宿主使用 PilotDeck 自己的 bundle ID `cn.pilotdeck.computer-use`，直接启动 embedded Driver 子进程；权限请求也由宿主处理，不调用上游公共 CLI 硬编码的 Applications 路径。权限不足时不向 Agent 发布工具。读取状态不会启动服务或弹出授权，仅启用、重新检测或点击授权会执行相应操作。接口检查请求来源与本机 Host，避免免登录本地部署被其他网页调用。

独立网页后端会自动接管全局配置中与本机 Driver 路径一致、参数恰为 `["mcp"]` 且无自定义环境或会话策略的旧 `cua-driver` POC 条目，先保存完整备份 `PILOT_HOME/computer-use/legacy-mcp.backup.json`，再移除该条目，避免开关关闭后仍通过重复配置暴露工具。其他手动配置保持独立，开关只控制保留服务 `pilotdeck-computer-use`。

HTTPS 反向代理部署需开启登录（`PILOTDECK_DISABLE_LOCAL_AUTH=0`），代理保留浏览器访问的 `Host`（包含非标准端口），并覆盖 `X-Forwarded-Proto` 为实际公开访问协议。后端默认仅信任 loopback 代理；代理位于另一台机器或容器网络时，以 `PILOTDECK_TRUST_PROXY` 配置其 IP/CIDR，多个地址用逗号分隔。设为 `0` 或 `false` 可禁用转发头信任。未受信任的直接连接不能通过伪造转发头改变请求协议；来源检查不采用 `X-Forwarded-Host`。本地免登录模式仍限制本地 Host，不因代理配置而开放公共域名的电脑操控入口。

```text
PilotDeck Electron 主进程
  ├─ Cua Driver serve --embedded（直接子进程、私有 socket / named pipe）
  └─ Gateway / Agent
       └─ 内部 MCP 客户端 → cua-driver mcp --embedded → 上述 Driver
```

Driver 放在 ASAR 外，由 macOS 打包流程签署嵌套可执行文件。主进程负责权限请求和生命周期；Gateway 只连接代理，不启动自动化守护进程。macOS 同时检查 `health_report` 的实际父进程身份与 `check_permissions` 的权限归属。进程关闭时通过 stdin 生命周期管道结束 Driver，异常退出也会撤销本代连接。

桌面开关存放在 Electron `userData/computer-use/settings.json`；独立网页后端存放在 `PILOT_HOME/computer-use/settings.json`。同目录 `mcp.json` 是当前进程生成的连接描述，Gateway 通过 `PILOTDECK_COMPUTER_USE_MCP_CONFIG` 读取并监听；不要手动编辑。项目配置和插件不能覆盖这个保留服务。Agent 不会获得内置 Driver 的更新、全局配置、扩展安装和轨迹重放工具。

## 支持范围

| 客户端 | Driver 资源 | 当前边界 |
| --- | --- | --- |
| macOS x64 / arm64，DMG / ZIP | 通用二进制 | PilotDeck 拥有辅助功能、屏幕录制授权 |
| Windows x64 / arm64，Setup EXE | 对应原生 EXE | 当前交互桌面；管理员窗口和安全界面受系统限制 |
| Linux x64 / arm64，DEB / RPM | 对应 GNU 二进制 | 当前用户桌面；X11 为主要路径，Wayland 显示部分能力受限 |

沿用现有 DEB 的 Ubuntu 22.04 和 RPM 的 Rocky Linux 9 构建基线。补充 X11、Wayland 客户端和键盘库运行依赖。没有捆绑 Wayland 桌面插件或 Windows UIAccess 辅助服务；这类能力不作为当前版本的完整支持承诺。

## 版本和构建

[scripts/computer-use/cua-driver.json](../scripts/computer-use/cua-driver.json) 固定版本、发布标签、各平台资源和 SHA-256。构建仅下载指定资源，校验成功后复制二进制及 MIT 版权声明。运行时还会核对二进制版本。上游发布新版本不会自动替换安装包内的 Driver。

升级由我们修改该清单及校验值，完成相关平台验证，再随 PilotDeck 发布。`PILOTDECK_CUA_BASE_URL` 可指定下载镜像；`PILOTDECK_CUA_ARCHIVE` 可指定本地归档（兼容原 `PILOTDECK_DESKTOP_CUA_*` 变量），二者都不能绕过固定校验。

原生组件使用 [scripts/computer-use/icon.png](../scripts/computer-use/icon.png) 的深蓝与香槟金航向 P 图标，准备资源时自动生成完整尺寸的 `computer-use.icns`，并校验源图和生成资源的哈希。应用目录为 `PilotDeck Computer Use.app`，系统显示名称为 `PilotDeck Computer Use`，bundle ID 仍为 `cn.pilotdeck.computer-use`。设置侧栏保留与现有图标一致的单色光标，中文功能入口仍为「电脑操控」。主应用仍使用深蓝 P 图标；`apps/desktop/scripts/rebuild-icon.mjs` 从同一份 `icon-source.png` 生成 ICNS、ICO 和 PNG，包括 macOS 标准及 Retina 尺寸。

```sh
# 使用 Node.js 22，在仓库根目录执行
pnpm --filter pilotdeck-desktop run download-cua-driver
pnpm --filter pilotdeck-desktop run compile
node --test apps/desktop/scripts/computer-use.test.mjs
pnpm run build
pnpm run test:mcp
pnpm --dir ui test src/components/settings/view/computerUse/index.test.tsx src/components/settings/navigation.spec.ts
pnpm --filter pilotdeck-desktop run dev
```

现有各平台发布流程已加入资源和生命周期检查；安装后运行固定版本的 `--version`，Windows 还核对 PE 架构，macOS 核对嵌套签名。开发模式中的 macOS 宿主是 Electron，系统授权归属 Electron；正式安装包归属 PilotDeck。

2026-10-10 本机验证：macOS arm64 目录包构建及深度签名校验通过；真实嵌入 Driver 的父进程身份、权限归属、MCP 初始化、工具发现和关闭通过。普通浏览器经统一 HTTP 接口启用、关闭桌面宿主的内置 Driver，桌面页面同步状态。独立网页环境包使用包内 Driver，完成首次授权后的截图、辅助功能树读取和关闭后重新连接。自动化覆盖默认关闭、缺少权限、私有连接撤销、异常退出、手动重连、项目覆盖保护、IPC 断连、输入校验与请求来源限制。Windows/Linux 的代码和构建接入已完成，仍需对应系统上的安装包与桌面实测。

### macOS 首次授权实测

使用构建后的共享网页环境包，在独立 `PILOT_HOME` 中启动；初始开关关闭，组件可用，辅助功能和屏幕录制均未授权。环境包部署在桌面 `.app` 外，使用原生组件 `cn.pilotdeck.computer-use` 的独立授权身份。另装的 CuaDriver 保留；此前通过仅对测试 Driver 限制外置应用、命令和公共 socket 的隔离测试验证了包内路径。本轮不是全新 macOS 账户或虚拟机测试。

辅助功能授权流程能够进入系统设置，用户完成系统登录验证后，后端识别授权。屏幕录制首次请求在本机 macOS 27 上没有自动将组件加入系统列表；需要在「录屏与系统录音」点击 `+`，选择环境包内 `resources/cua-driver/PilotDeck Computer Use.app` 并开启权限。系统提示退出后，在网页点击「重新检测」会重新启动此实例的组件，两项权限变为已授权。页面现已补上手动添加引导、Finder 定位和可复制/选中的应用路径；系统没有自动列出应用时可完成这条授权路径。

使用环境包内正式 `loadMcpServerConfig → McpRuntime → PluginToToolBridge` 加载自动生成的连接，发现 58 个 Driver 工具，初始化指引可读取。`health_report` 返回 `ok`；权限归属为包内宿主而非外置 CuaDriver。`get_window_state` 返回系统设置的 182 个辅助功能元素和 1200 × 1038 PNG，图片成功经过 PilotDeck 的工具结果转换。关闭开关后连接描述为空、私有 socket 删除、所属宿主及 Driver 进程退出；重新开启后保留系统授权，自动生成新连接并再次成功截图。现有 3001 实例也已重新检测并完成相同的 MCP 读取验证。

引导修复验证：相关 UI/API/服务测试 43 项、桌面控制器测试 7 项通过；桌面 TypeScript 编译、前端构建及共享环境打包通过。3001 实际点击按钮，Finder 选中正确组件；复制的路径可粘贴进系统「前往文件夹」窗口。更新后 MCP 截图及辅助功能读取仍通过。本轮保留上一轮系统授权，没有再次重置权限或模拟新系统账户。

名称与图标更新验证：相关 UI/API/服务、桌面控制器及图标格式测试共 69 项通过，前端、共享环境和 macOS arm64 目录包构建通过，嵌套签名及组件资源检查通过。系统设置实际显示「PilotDeck 电脑操控」和新图标。本机临时签名更新后，旧权限开关仍显示开启但组件检测未授权；移除并重新添加这个测试组件的权限记录后，两项权限生效，3001 恢复「已连接，可使用」。通过正式 MCP 转换链读取 190 个辅助功能元素及 1200 × 1038 PNG，`health_report` 返回 `ok`。这轮没有替换 `/Applications/PilotDeck.app`，主应用的图标更新仅包含在新构建的目录包内。

最终 A 方案验证：改用深蓝与香槟金图标，并将所有系统语言下的组件名称统一为 `PilotDeck Computer Use`，移除中文显示名称覆盖。相关测试共 83 项通过，桌面 TypeScript 编译、前端、共享环境和 macOS arm64 目录包构建通过，嵌套签名与固定版本资源检查通过。更新此临时签名组件的辅助功能和录屏记录后，3001 两项权限均已授权，状态为「已连接，可使用」。真实 MCP 发现 58 个工具，`health_report` 为 `ok`，正式工具转换链返回 181 个辅助功能元素及 1200 × 1038 PNG，包含最终英文组件名称。

本机录屏列表有两个同名 `PilotDeck` 主应用条目。已核实 `/Applications/PilotDeck.app` 使用正式 Developer ID 签名，而本地目录包为临时签名，两者 bundle ID 相同、指定要求不同。根据 [Apple 对指定要求和 TCC 身份的说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)，推测同名记录来自这两种签名身份；没有读取受保护的 TCC 数据库，不能确认上下两条分别对应哪一个路径。本轮保留这两条主应用记录，仅更新独立组件的权限。正式包升级仍需稳定签名身份，临时签名测试不能代表正式包的授权迁移结果。

重开系统设置后的显示验证：本机辅助功能页曾在重开后回退为旧 `PilotDeckComputerUse` 名称和默认图标。Launch Services 中残留六条旧测试组件注册，包含已不存在的路径及保留的旧包，均与当前组件共用 bundle ID。将仍存在的三份旧测试应用归档保存、注销六条旧注册并更新当前包注册后，连续两次完全退出并重开系统设置，辅助功能与录屏页均显示 `PilotDeck Computer Use` 和最终图标，原有授权保持生效。当前组件注册只剩正在使用的包内路径；没有重置 TCC 或修改主应用授权。随后真实 MCP 的权限、健康检查、控件树与截图再次通过。

参考：[Cua 固定版本嵌入契约](https://github.com/trycua/cua/blob/cua-driver-rs-v0.34.1/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md)。

### PR 前回归与完整 Agent 验收

`pnpm run test:mcp` 已接入 PR 的 macOS、Windows、Linux 回归矩阵，覆盖 stdio 传输、图片与结构化观察结果、初始化指引、重连策略和内置服务配置保护；本机 33 项通过。桌面控制器的启动/关闭、崩溃后手动重连和应用退出测试不再跳过 Windows。测试通过 Node 运行 Driver 协议夹具，保留真实子进程、stdin 生命周期与系统连接；Windows 使用真实 named pipe，PID 文件独立存放，不将管道路径当作普通文件。Windows 的管道与进程退出断言需在 PR CI 上实际执行。本机控制器 7 项通过，桌面辅助测试共 154 项中 153 项通过，1 项既有 Windows Job 测试因运行于 macOS 跳过；桌面 TypeScript 检查通过。

2026-10-10 在 3001 网页实例完成内置组件的真实 Agent 任务：只使用 `mcp__pilotdeck-computer-use__*` 工具，先检查权限与健康状态，再启动计算器、获取控件树和截图，以最新 `element_token` 点击清除，通过 `type_text` 输入 `23*17`，再用 `press_key` 求值，最终截图与辅助功能文本均确认结果 `391`。共 12 次 MCP 调用，全部返回成功，无权限拒绝。键盘工具返回效果未核实时，Agent 继续观察；中间期望单个操作数的断言未满足，实际观察到完整表达式 `23 × 17`，确认输入成功后继续求值，没有重复输入。实测 Driver 版本为 `0.34.1`，权限归属为 `cn.pilotdeck.computer-use`，执行路径位于随包的 `resources/cua-driver/PilotDeck Computer Use.app`；没有借用外置 CuaDriver。此次验收为 macOS arm64，不能代替 Windows/Linux 桌面实测或正式签名安装包的首次安装与升级验证。

## 外置 Driver POC（已验证）

PilotDeck 通过已有的 MCP 客户端启动 `cua-driver mcp`，由它连接同一台 Mac 上的 CuaDriver 守护进程。守护进程负责截图、辅助功能树和桌面输入；模型、权限审批、工具调度和会话记录仍由 PilotDeck 负责。

```text
PilotDeck 网页 → Gateway / Agent → MCP 客户端
                                    ↓ stdio
                              cua-driver mcp
                                    ↓ 本机连接
                              CuaDriver.app → macOS 应用
```

本例使用 Cua Driver 自带的 MCP 服务，不需要另写包装服务，也不需要安装 Python Cua SDK。网页只是交互入口；控制的是运行 Driver 的那台 Mac。远程网页部署需要另行设计通往这台 Mac 的连接，不能直接使用服务器上的 stdio 去控制用户电脑。

## macOS 准备

1. 从 [Cua 官方发布页](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.1)安装 Driver。本轮验证版本为 `0.34.1`。
2. 在「系统设置 → 隐私与安全性」中给 CuaDriver 开启「辅助功能」和「屏幕与系统音频录制」，按系统提示完成直接屏幕捕获授权。
3. 启动守护进程并检查权限：

```sh
open -n -g -a CuaDriver --args serve
"$HOME/.local/bin/cua-driver" permissions status --json
```

如果安装路径不同，配置中的 `command` 要换成实际可执行文件的绝对路径。

## PilotDeck 配置

在网页「Settings → MCP Servers」的全局 JSON 配置中，合并 [示例配置](../examples/mcp/cua-driver.macos.json)里的 `cua-driver` 条目，再应用 JSON。对应文件是 `$PILOT_HOME/mcp.json`；未设置 `PILOT_HOME` 时为 `~/.pilotdeck/mcp.json`。已有其他服务时保留其条目。

`concurrencySafe: false` 禁止该服务的只读工具进入并行工具批次。它不提供跨会话的桌面锁；本轮按单会话使用。Driver 使用原生桌面，不要配置浏览器专用的 `perSession`。

模型需要支持图片输入，否则截图无法进入模型上下文。工具返回的 PNG、AX 文本、`structuredContent` 中的窗口信息和 `element_token` 会进入 PilotDeck 的工具结果与会话记录。Driver 的初始化指引会注入系统提示。

## 本地网页验证

从源码启动需要 Node.js 22 和 pnpm。为测试使用独立的 `PILOT_HOME`，在其 `pilotdeck.yaml` 中配置模型，并把 `webui.runtime.workspacesRoot` 设成另一个独立目录；该目录与 `PILOT_HOME` 不应相互包含。

```sh
pnpm install --frozen-lockfile
PILOT_HOME="$HOME/.pilotdeck-cua-test" \
HOST=127.0.0.1 SERVER_PORT=3002 VITE_PORT=5174 \
PILOTDECK_GATEWAY_PORT=18790 \
PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18790/ws npm run dev
```

打开 `http://127.0.0.1:5174`，保存上述 MCP 配置。可发送：

> 只使用 cua-driver MCP 打开 macOS 计算器，获取窗口状态，使用当前快照的 element_token 计算 12 × 7，再获取一张新截图和辅助功能树确认结果。不要使用终端或其他应用。

通过 PilotDeck 原有的工具审批界面批准测试操作。工具名为 `mcp__cua-driver__launch_app`、`mcp__cua-driver__get_window_state`、`mcp__cua-driver__click` 等。

动作应以新观察结果中的 token 为依据，完成后再次观察。连接在动作派发后丢失时，PilotDeck 不会自动重放未声明可重试的动作；它会提示先观察当前状态。只读或声明幂等的工具允许一次重连重试，但新连接必须重新获取标注并仍声明可重试。后续调用无需由调用者再次发现工具；缓存回收后会自动重新获取标注。调用取消保留正常连接，超时或关闭的连接会被清理，供后续调用重新建立。

## 已完成验证

2026-10-10 的本机测试通过网页保存配置，并由 PilotDeck 发起 9 次实际 MCP 调用完成 `12 × 7 = 84`。截图与辅助功能树均确认结果。Driver 重启后，下一次只读观察成功建立新连接并获取新截图。

自动化测试使用真正的 MCP SDK stdio 子进程，覆盖初始化指引、图片和结构化结果进入模型上下文、错误结果、会话过期、进程退出、动作不重复执行、只读重试、取消与超时恢复：

```sh
node --import tsx --test tests/mcp/*.spec.ts tests/mcp/client/McpClient.spec.ts \
  tests/context/prompt-skill-path.spec.ts tests/context/prompt-file-delivery.spec.ts
```

本轮仍未覆盖多会话同时操作同一桌面、远程 Driver 连接和其他操作系统。
