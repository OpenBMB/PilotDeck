# PilotDeck Desktop —— 安装指南

## 推荐渠道（按可靠性排序）

| 渠道 | 是否需要修复脚本 | 备注 |
|---|---|---|
| 浏览器（Safari/Chrome） + HTTPS 直链 | 否 | **首选**。浏览器投放的文件 Gatekeeper 信任度高 |
| AirDrop | 否 | 设备间直传，无 sandbox provenance |
| `scp` / `rsync` 命令行传输 | 否 | 命令行进程不带 sandbox identity |
| GitHub Releases / 公司内网 nginx | 否 | 等同于直链 |
| **飞书 / 微信 / QQ / 钉钉 / WhatsApp 文件传输** | **必须** | macOS 14+ 会拒绝执行,见下文根因 |
| 邮件附件 | 视邮件客户端 | Mail.app OK；网页版邮箱通过浏览器下载 OK |

## 标准安装流程

1. 从上表渠道下载 `PilotDeck-<version>-arm64.dmg`
2. 双击 DMG 挂载
3. 把 `PilotDeck.app` 拖到 `Applications`
4. 在 Launchpad / Finder / Dock 双击启动

如果第 4 步**报"无法启动 PilotDeck 应用程序"且窗口一闪消失** → 你大概率是通过沙盒 IM 收到的 DMG，跳到下面"修复"流程。

## 修复流程（DMG 来自飞书等沙盒 IM）

把 `install-pilotdeck.sh` 也下载下来（和 DMG 同一渠道发出），跑：

```bash
bash install-pilotdeck.sh
```

脚本会：
1. 自动找到已经安装的 `PilotDeck.app`
2. 清掉 macOS 添加的隔离 / provenance 扩展属性（不会动签名 / staple ticket）
3. 验证代码签名 + Apple notarize ticket + Gatekeeper 评估
4. 报告每一步结果，告诉你接下来该做什么

成功跑完后再次双击 PilotDeck 即可正常启动。

如果手边没有脚本，最小修复手动版：

```bash
xattr -cr /Applications/PilotDeck.app
open /Applications/PilotDeck.app
```

## 根因（macOS 14+ Gatekeeper 行为）

macOS Sonoma (14) 引入了一个叫 `com.apple.provenance` 的扩展属性。当任何**沙盒应用**（飞书/微信/QQ/钉钉等）在系统上落盘一个文件,macOS 自动把"投放者 App 的 sandbox identity"写进这个属性。Gatekeeper 对带 provenance 的可执行文件做**额外严格**的执行策略评估,沙盒 IM 类应用的信任级别低于浏览器/AirDrop —— 即使代码签名 + Apple 公证 100% 合法,Gatekeeper 仍会拒绝执行,触发"无法启动 ... 应用程序"对话框,且对话框因为 main process 在 launch 阶段被 kill 而**一闪消失**,看起来像是 App 自己崩溃。

技术细节:
- `codesign --verify` **会报告 valid**,因为签名本身没问题（rejection 发生在执行策略层而非签名层）
- 单独 `xattr -d com.apple.quarantine` **不够**,provenance 是独立属性
- `xattr -cr` 清除所有扩展属性是安全的 —— stapled notarize ticket 实际上存在 `Contents/CodeResources` 这个**文件**里,而非 xattr,不会被误删

## 长期方案路线图

当前(0.1.x):
- ✅ DMG 已 codesign + notarize + staple,通过浏览器/AirDrop 渠道无任何摩擦
- ✅ `install-pilotdeck.sh` 兜底,服务通过 IM 渠道收到 DMG 的同事

下一步(规划中):
- 申请 **Developer ID Installer 证书**,改造 `release.sh` 同时产出 `PilotDeck-<version>-arm64.pkg`
- PKG 由 macOS 内置 Installer.app 安装,**绕开** sandboxed-IM provenance 标记
- 用户体验:双击 PKG → 装好 → 直接启动,无任何额外步骤,不论通过什么渠道收到
