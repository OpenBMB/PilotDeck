# Windows 系统通知与角标验收说明

## 背景及本次计数调整

反馈版本：`v2026.10.28`（安装包版本 `2026.1028.0`）。用户反馈应用内通知已开启、任务在后台完成，但没有横幅，Windows 通知设置中也找不到 PilotDeck；任务栏数字模糊，安装后出现 25。

本次共享逻辑修改位于 `codex/fix-notification-badges`，基于 `upstream/main` 的 `bc37c4c5`。Windows 排查应先包含本分支，避免重复修复旧的未读计数。

新的产品约定：

- 网页标题保持 `PilotDeck`，网页及 PWA 不显示全局数字；清除旧版遗留的应用角标。
- 桌面角标表示本轮后台期间收到提醒的任务数，不再使用会话未读总数。
- 同一会话的两个任务可以计 2；同一任务的审批、提问、完成、失败或断网提醒，在本轮后台期间最多占一个计数。
- 主窗口恢复并获得焦点时清零，覆盖 Dock、任务栏、托盘菜单、窗口切换、点击通知等入口。只打开托盘菜单不清零。
- 客户端启动、历史快照、侧栏未读恢复不增加应用角标；前台任务不增加。新的后台提醒重新累计。
- 会话未读紫点独立保留，实际查看对应会话后才清除。没有新增提醒列表或“全部已读”入口。
- 角标设置独立于横幅设置和系统通知 API 的可用性。角标能显示，不代表系统横幅已经投递成功。

## 实现及排查入口

1. `ui/server/session-notifications.js` 将 `taskId` 与 `createdAt` 放入提醒。审批、提问和完成使用同一个执行任务 ID；队列发送失败使用对应的任务／输入 ID。
2. `ui/src/hooks/useSystemNotifications.ts` 仅对实时提醒调用 `recordTaskReminder`。历史活动快照仅恢复会话状态，不提交应用计数。横幅仍通过 `showNotification` 投递。
3. `apps/desktop/src/preload.ts` 暴露两个独立 IPC：`pilotdeck:notification-reminder` 和 `pilotdeck:notification-show`；账号上下文通过 `pilotdeck:notification-scope` 设置。
4. `apps/desktop/src/notifications.ts` 在主进程中按账号、会话、任务去重，并以进程启动／前台确认时间拦截旧事件。计数不持久化。`main.ts` 使用主窗口原生 `focus` 事件清零。
5. Windows 任务栏使用 `BrowserWindow.setOverlayIcon`；托盘数字由 `desktopTray` 接收。两者应同时清零。旧的 renderer `setNotificationBadge(count)` 接口已移除，避免历史未读覆盖新计数。

## Windows 同事需要核查或修复的部分

### 1. 原生通知未出现、系统设置没有 PilotDeck

优先确认请求在哪一层停止：实时 `session-notification` → renderer → `pilotdeck:notification-show` → Electron `Notification.show()` → 原生 `show`／`failed` 事件。记录事件 ID、任务 ID、时间及原生错误信息即可，避免记录对话正文或密钥。

当前构建配置 `appId` 与运行时 `app.setAppUserModelId()` 都是 `cn.pilotdeck.desktop`。不能仅因代码常量一致，就认定机器上的注册正确；也不能仅因设置列表缺少应用，就断定没有调用到通知 API。

请核查实际 NSIS 安装后：

- 开始菜单快捷方式存在，目标指向本次安装的程序，AppUserModelID 与进程一致。
- 系统实际使用的通知激活注册及 ToastActivatorCLSID 是否正确，包含当前运行用户与安装用户的区别。
- 首次安装、覆盖升级、旧快捷方式保留、固定在任务栏后的启动路径。
- 应用确实以普通用户身份运行；系统通知、勿扰及组织策略状态。
- 投递成功后，系统通知设置中的名称、图标是否正确，横幅是否进入通知中心，点击是否打开对应会话。

现有 `Notification.isSupported()` 只代表 API 支持，设置页返回的权限是 `unknown`；开启应用内开关不等于 Windows 已允许投递。目前异步 `failed` 事件只写日志，IPC 返回值不代表实际送达。这部分仍需 Windows 侧结合真实错误完善反馈，不需要新增“测试通知”按钮。

参考：[Electron 42 通知平台说明](https://github.com/electron/electron/blob/v42.3.3/docs/tutorial/notifications.md#windows)、[Electron Notification 事件](https://github.com/electron/electron/blob/v42.3.3/docs/api/notification.md)。

### 2. 任务栏与托盘角标模糊

本分支调整的是计数来源与确认时机，没有重做图像绘制。现有 `badgeBitmap()` 使用固定 32×32 位图及像素字形，托盘还会缩放合成，仍需改进并在 Windows 验收。

请覆盖 100%、125%、150%、200% 缩放，浅色／深色主题，以及不同 DPI 显示器间移动窗口。检查 1、2、25、99+ 的文字、圆形边缘、透明度、位置，以及任务栏与托盘同时清零。可以参考 ChatGPT 的清晰度；横幅外观由系统渲染，不要求逐像素复刻。

ChatGPT 截图中的通知回复框属于增强交互，本轮不实现。先完成原生投递和点击跳转；若后续增加回复，需要独立设计发送与审批边界。

## 计数验收用例

| 操作 | 应用角标 | 会话未读状态 |
|---|---|---|
| 启动有大量历史会话的客户端 | 0 | 沿用会话自己的未读状态 |
| 前台发出消息，任务尚未产生提醒 | 0 | 按现有会话逻辑显示 |
| 两个独立任务在后台完成（包含同一个会话） | 2 | 每个相关会话保留未读点 |
| 同一任务先提问／审批，随后完成 | 本轮最多计 1 | 等待状态和未读状态按各自规则更新 |
| 重放同一个事件或流式文本分片 | 不增加 | 不生成重复状态 |
| 打开托盘菜单但没有恢复主窗口 | 保持 | 保持 |
| 恢复并聚焦主窗口，包括停留在设置页 | 清零 | 未查看的其他会话仍保留未读点 |
| 再次后台化后产生新提醒 | 重新累计 | 新提醒仍正常标记 |
| 关闭横幅、保持角标开启 | 后台任务正常累计 | 保持 |
| 关闭角标 | 不显示 | 保持 |
| 切换账号、退出后重新启动 | 0 | 按账号隔离 |
| 清零后才到达的旧事件 | 不重新点亮 | 不覆盖较新的会话已读进度 |

## 自动化与真机验证

- 共享控制器：`node --test apps/desktop/scripts/notifications.test.mjs`，参数化覆盖 macOS、Windows、Linux。
- 原生窗口：`node apps/desktop/scripts/verify-desktop-lifecycle.cjs notification-badge`。使用隔离配置及模拟 HTTP runtime，不访问用户真实数据，也不发送系统横幅。
- Windows 现有托盘 CI 和 macOS 生命周期 CI 默认包含上述新场景；Linux DEB CI 通过 Xvfb/Openbox 验证原生窗口焦点。
- 网页／Service Worker：`node ui/e2e/notification-order.smoke.mjs`，使用隔离 Chrome 配置和真实 IndexedDB。

这些检查不能替代安装包在 Windows 真机上的系统通知注册、横幅、通知中心、点击激活和 DPI 验收。请分别记录“计数正确”与“系统通知送达”的结果。
