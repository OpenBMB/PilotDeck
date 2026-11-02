# 启动过渡与安装、卸载界面

本轮基于 `codex/gateway-startup-diagnostics`，继续此前的启动诊断与日志工作。按最新要求使用默认系统字体，文字保留 PilotDeck；没有打包 PilGi/UnPilgi 字体。配置格式及目录没有再次重构。

## 启动呈现

- Windows、macOS、Linux 桌面原生加载页、Web 首屏 HTML 和 React 启动页共用样式与进度计算，移除方块 P 图标，内容在可用窗口区域水平、垂直居中。
- 保留各阶段的真实进度基线，阶段内部按时间缓慢前进且不越过下阶段；细进度条有持续流动高光。页面切换沿用阶段时间，避免从零重新开始。
- 服务就绪后进度到 100%，再淡出进入已挂载的工作区。非常快的启动保留最短 650 ms 的呈现、240 ms 的完成动画、180 ms 的淡出；服务已经启动，不额外延迟后端。系统开启减少动态效果时取消动画等待。
- 启动过程只显示短状态文字；错误时显示简洁原因、错误码、日志位置、重新启动和保存日志。诊断分类保留此前实现，134 仍不能单独证明 OOM，用户原始崩溃需要日志确认。
- 设置中的运行日志导出也支持 Web：支持 File System Access API 的浏览器使用系统另存为对话框；其他浏览器使用标准下载。桌面继续使用 Electron 原生保存窗口。

## Windows 安装与卸载

沿用现有 electron-builder/NSIS 安装事务、文件替换及取消保护，新增白底、深色文字的简洁欢迎页和完成页。安装进度条改为细的深色连续条，完成页可选择启动 PilotDeck。交互安装及静默更新的启动入口仍经过 Explorer，保留去提权行为。

卸载新增个人数据选择页，默认选中“保留个人数据（推荐）”，提供“清理个人数据”。清理范围明确包含 `.pilotdeck` 中的全部文件（含密钥和会话），以及当前用户的客户端设置、缓存；用户需要保留的文件应提前备份。卸载完成页显示保留、清理或部分清理的实际结果。

自定义文案均提供英文和简体中文，系统按钮使用 NSIS 的对应语言资源。卸载优先读取客户端保存的界面语言，读取失败时使用 Windows 界面语言。仅提供目前客户端支持的这两种语言。

更新替换和静默卸载均保留个人数据。交互卸载若未展示自定义页，则回退到默认选择“否”的本地化确认框。

清理脚本只处理明确的 PilotDeck 目录。根目录、个人主目录、包含 `.git` 的目标、自定义的宽泛 PILOT_HOME、经祖先链接重定向的路径会被拒绝；目标本身为链接时只移除链接。失败或未支持的目标保留并显示部分清理结果。没有对真实用户数据执行清理测试。

## Linux 与 macOS

Linux 打包客户端在支持 pkexec 的 DEB/RPM 环境中，从“关于”页面或桌面快捷方式的卸载动作进入本地确认窗口，提供保留、清理、取消三个选项，默认保留。用户取消授权或包管理器失败时不清理数据并恢复运行；软件包成功移除后才按选择清理数据。卸载前加载清理函数，避免应用文件删除后找不到脚本。

直接运行 apt/rpm 或其他系统卸载方式时保留个人数据；不在包管理器脚本中强制弹出图形窗口。macOS 保持系统移除应用的行为，不额外添加卸载程序。

设计依据：NSIS 使用 electron-builder 的 [自定义页面和卸载钩子](https://www.electron.build/docs/nsis/)；Linux 避免依赖维护脚本中的交互窗口，参见 [Debian 维护脚本的终端要求](https://www.debian.org/doc/debian-policy/ch-maintainerscripts)；macOS 遵循 [Apple 的移除应用流程](https://support.apple.com/en-ae/102610)。实现同时对照本地安装的 electron-builder 模板。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| UI：启动状态衔接、快速完成动画、错误展示、保存取消、关于页及日志设置 | 5 个文件、54 项通过 |
| Node：原生加载 HTML、卸载路径边界、目录链接、只读语言读取、Linux 保留/清理/取消与授权失败 | 12 项通过 |
| Windows NSIS 安装脚本编译 | 通过，验证交互及静默启动均使用 Explorer，包含带空格的项目目录 |
| Windows NSIS 卸载脚本编译 | 通过，验证更新/静默保护、默认保留、双语资源；检查产物中的 UTF-16 中文字符完整 |
| 桌面与 UI TypeScript | 通过 |
| Vite 生产构建 | 通过，沿用现有大体积 chunk 警告 |

复现命令：

```powershell
node --test apps/desktop/scripts/appearance.test.mjs apps/desktop/scripts/uninstall-data.spec.mjs
node apps/desktop/scripts/verify-installer.cjs
node apps/desktop/scripts/verify-uninstaller.cjs
pnpm --dir ui exec vitest run src/components/auth/view/ProtectedRoute.test.tsx src/components/auth/view/StartupPresentation.spec.tsx src/components/settings/view/about/DesktopAboutSections.test.tsx src/components/settings/view/advanced/components/RuntimeLogsSection.spec.tsx src/utils/runtimeLogExport.spec.ts
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json
pnpm --dir ui exec tsc --noEmit -p tsconfig.json
```

用户在原生界面检查期间按 Esc 停止了 Computer Use，之后未继续操作任何窗口。最终安装、卸载页面的外观尚未完成自动走查；未构建完整签名发布包，也未进行 macOS/Linux 实机验证。编译、单元测试不能替代这些检查。

## 本地手测

- 网页部署版：`http://127.0.0.1:3001/`，刷新后加载本轮构建。
- 启动与错误界面演示：`http://127.0.0.1:3001/startup-preview.html`，可切换快速/慢速启动、内存不足、配置错误和文件缺失；这些按钮模拟呈现，不修改配置或注入实际后端故障。
- 使用独立测试配置目录 `%LOCALAPPDATA%/PilotDeck/manual-web-test`，不修改日常配置。测试模型池为空，需要在设置中配置模型后才能测试对话；没有模型时 Gateway 不会启动。
- `node scripts/create-startup-preview.mjs` 可在桌面代码编译且 Web 构建完成后重新生成演示页面。演示文件位于忽略的 `ui/dist`，不加入正式路由和发布资源。

运行日志、测试日志、NSIS 验证产物位于忽略的 `artifacts`，不会提交。代码按启动界面、安装卸载、Web 保存日志分别提交。
