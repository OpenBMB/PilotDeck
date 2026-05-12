---
name: deploy-politdeck
description: Clone, configure and run the PilotDeck repo end-to-end. After the gateway decoupling refactor (May 2026) the canonical layout is "two cooperating processes from source" — the gateway (`pilotdeck server`, port 18789) owns the agent runtime, and `ui/server` (port 3001) is its websocket client + REST adapter. Both run via `tsx` straight from `src/**` / `server/**`, so `npm run build` is no longer required for day-to-day edits. Use when the user asks how to deploy / run / start / 跑起来 / 部署 PilotDeck, brings up a fresh checkout, switches between dev mode and production mode, or hits startup errors around ports 3001 / 5173 / 18789, ~/.pilotdeck/pilotdeck.yaml, "Unexpected token '<', \"<!doctype ...\" is not valid JSON" on onboarding Test Connection, Save button stuck disabled, node-pty / better-sqlite3 native build, or vite proxy /api /ws.
---

# Deploy PilotDeck

PilotDeck 是 **两个进程**协作：

```
pilotdeck server (port 18789)     ← gateway 进程，吃 src/** 源码
   │
   │ ws://127.0.0.1:18789/ws  (RemoteGateway)
   ▼
ui/server (port 3001)             ← express bridge，吃 server/** 源码
   │
   │ HTTP + WebSocket
   ▼
浏览器 / Vite (dev: 5173 / prod: 3001 自己 serve ui/dist)
```

**单一 Gateway**：`ui/server` 不再自己起 in-process gateway，所有 chat/permission/session/cron 都通过 WebSocket 调用 `pilotdeck server`。从源码运行（`node --import tsx`），改 `src/**` 或 `ui/server/**` 重启对应进程即生效，**不需要 `npm run build`**。

| 启动方式 | 命令 | 端口 | 适用场景 |
| --- | --- | --- | --- |
| **dev（推荐）** | `cd ui && npm run dev` | 18789 + 3001 + 5173 | 改前端 React 用，HMR 起作用 |
| **prod** | `cd ui && npm run start` | 18789 + 3001 | 准生产，build 前端 + 跑 server |
| **只跑 gateway** | `npm run server`（根目录） | 18789 | 给 CLI / TUI / 其它 client 连 |
| **只跑 ui server** | `cd ui && npm run server` | 3001 | 已有 gateway 在 18789 跑着 |

`npm run dev` 等同 `concurrently` 拉 3 个进程；`npm run start` 拉 2 个进程（build + gateway + server）。

## 先决条件

- macOS / Linux，node **v22**（`ui/.nvmrc`、根 `package.json`）
- `git`、`npm`
- 编译 native 模块需要：`python3` + Xcode CLT（`xcode-select --install`），否则 `ui/` 的 `node-pty` / `better-sqlite3` 安装失败
- 一个可达的 LLM provider（OpenAI 兼容 / Anthropic / litellm 等），手头要有 base URL + API key + model 名

## 1. 拉取代码

```bash
git clone git@github.com:Gucc111/PilotDeck.git
cd PilotDeck
nvm use            # 读 ui/.nvmrc → v22；没有 nvm 就自己装 node 22
```

## 2. 安装依赖（不需要 build）

```bash
# 根目录
npm install         # 装 tsx + 内核运行时依赖

# 前端
cd ui
npm install         # postinstall 跑 scripts/fix-node-pty.js
cd ..
```

`npm run build` 只在你**要发布编译产物**到 `dist/` 时跑。日常开发不需要，`tsx` 直接吃 `src/**.ts` 跑。

## 3. 配置文件

只有一个：**`~/.pilotdeck/pilotdeck.yaml`**。`ui/server` 直接读，UI Settings 也直接读写它。`~/.edgeclaw/config.yaml` 已废弃（旧文件可删）。

最小化模板（按你的 provider 改）：

```yaml
schemaVersion: 1
agent:
  model: deepseek/deepseek-v4-pro       # 形如 "<providerId>/<modelId>"
model:
  providers:
    deepseek:                            # ← providerId，跟 agent.model 前缀一致
      protocol: openai                   # openai | anthropic | openai-responses | litellm
      url: https://api.deepseek.com/v1
      apiKey: sk-...
      timeoutMs: 120000
      headers: {}
      models:
        deepseek-v4-pro:                 # ← modelId，跟 agent.model 后缀一致
          displayName: DeepSeek V4 Pro
webui:                                   # ui/server 专用段，gateway 忽略它
  runtime:
    serverPort: 3001
    vitePort: 5173
  memory:
    enabled: true
```

Gateway 第一次启动会在 `~/.pilotdeck/server-token` 写入 32 字节 token，bridge 自动读它来 hello。手动重置：删 `server-token` 文件，下次启动会重新生成。

## 4. 启动

### 4a · 开发（HMR，改 React / src/** 都行）

```bash
cd ui && npm run dev
```

跑起来 3 个进程：

```
[gateway] tsx src/cli/pilotdeck.ts server        → 18789
[server]  node --import tsx server/index.js      → 3001
[client]  vite                                    → 5173
```

浏览器开 **`http://localhost:5173`**。`vite.config.js` 把 `/api` `/memory-dashboard` `/ws` `/shell` 反代到 3001。

成功标志：
```
[gateway] PilotDeck server listening: http://127.0.0.1:18789
[server]  [pilotdeck-bridge] connected → ws://127.0.0.1:18789/ws
[client]  VITE ready in NNNms
```

**改 `src/**` 后**：`Ctrl-C` 重启整个 `npm run dev`（或单独 kill `[gateway]` 进程让 concurrently 重启它）。`ui/server/**` 改完也是重启，但**改 `ui/src/**` HMR 自动接管**。

### 4b · 准生产（无 HMR，build 前端 + 两进程）

```bash
cd ui && npm run start
```

等同 `vite build` 然后 `concurrently` 跑 gateway + server。浏览器开 **`http://localhost:3001`**（ui/server 自己 serve 已 build 好的 `ui/dist/`）。

可选环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SERVER_PORT` | 3001 | bridge 后端端口 |
| `VITE_PORT` | 5173 | Vite dev 端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `PILOTDECK_GATEWAY_URL` | `ws://127.0.0.1:18789/ws` | bridge 连 gateway 的地址 |
| `PILOTDECK_GATEWAY_TOKEN_PATH` | `~/.pilotdeck/server-token` | gateway auth token 文件 |
| `PILOTDECK_WEB_PERMISSION_MODE` | `default` | UI 默认权限模式（`default` / `bypassPermissions`） |
| `CLOUDCLI_DISABLE_LOCAL_AUTH` | 1 | 设为 `0` 启用本地账号登录 |

### 4c · 仅跑 gateway（给 CLI / TUI / 远程 UI 连）

根目录：
```bash
npm run server          # tsx src/cli/pilotdeck.ts server，18789
npm run server:built    # 备用：node dist/src/cli/pilotdeck.js server（需 npm run build）
```

### 4d · 仅跑 ui server（gateway 已在跑）

```bash
cd ui && npm run server     # node --import tsx server/index.js
```

需要确认 `~/.pilotdeck/server-token` 存在（gateway 第一次启动时生成）。

## 5. 验收清单

按 `docs/old-ui-adaptation/04-implementation-plan/03-real-environment-runbook.md` 的精简版：

- [ ] gateway 日志看到 `PilotDeck server listening: http://127.0.0.1:18789`
- [ ] ui/server 日志看到 `[pilotdeck-bridge] connected → ws://127.0.0.1:18789/ws`
- [ ] 浏览器开 5173（dev）或 3001（prod），首页加载，连接状态显示 `connected`
- [ ] 左侧 Projects 至少包含当前 cwd
- [ ] 创建新 session，能选中
- [ ] composer 提交后 user message 立即出现，模型流式回复合并为单条 assistant message
- [ ] running 时 Stop 可点击，点击后流终止
- [ ] 刷新页面后历史按时间顺序加载
- [ ] 工具调用显示 `running` → `ok` / `error`
- [ ] 触发权限的工具弹出黄色 banner，Allow / Deny 后 banner 消失
- [ ] Files / Git tab 可见、未抛 500

## 6. 常见故障速查

| 现象 | 第一定位 |
| --- | --- |
| `[pilotdeck-bridge] gateway connect failed after 30000ms` | gateway 没起或起得太慢；单独 `cd .. && npm run server` 看 stderr |
| `[pilotdeck-bridge] gateway connect failed: Gateway hello timed out` | `~/.pilotdeck/server-token` 内容跟 gateway 当前 token 不一致；删掉 server-token 让 gateway 重新生成 |
| onboarding "Test Connection" 报 `Unexpected token '<', "<!doctype "...` | 你访问的是 18789（gateway 不提供 onboarding REST），切到 `http://localhost:3001`（prod）或 `5173`（dev） |
| Save 按钮一直 disabled 不能点 | 跟上面同一个根因：Test Connection 没成功，`testStatus !== 'success'` |
| 改了 `src/**` 但没生效 | 重启 `[gateway]` 进程（kill PID 或重启整个 `npm run dev`）。ui/server 不需要重启 |
| 改了 `ui/server/**` 但没生效 | 重启 `[server]` 进程。gateway 不需要重启 |
| 改了 `ui/src/**` 但没生效 | dev 模式 Vite HMR 自动接管；prod 模式需要重新 `npm run start`（会 build） |
| `npm install` 报 node-gyp / node-pty / better-sqlite3 | 装 `xcode-select --install` + `python3`；再跑 `cd ui && npm rebuild` |
| 5173 转发 502 | bridge（3001）没起来或 gateway（18789）没起来；查 `[server]` / `[gateway]` stderr |
| WS 不通 | `curl http://localhost:3001/api/health`；不通就是 bridge 没起 |
| 端口被占 | `lsof -i :18789 -i :3001 -i :5173 -sTCP:LISTEN` 找 PID，`kill` 掉 |
| favicon 还是旧 EC 图标 | 浏览器底层缓存。已加 `?v=pd1` cache-buster 应自动失效；不行就清 site data |
| Files 403 | URL 含 `..`，`resolveProject` 拒绝；用合法 projectKey |
| Cron / Always-On 不工作 | `~/.pilotdeck/pilotdeck.yaml` 是否声明 `cron:` / `alwaysOn:` 段 |
| 想暴露给局域网 | `HOST=0.0.0.0`，注意 firewall |

## 7. 常用单条命令速记

```bash
# 全新检出 → dev HMR（浏览器 http://localhost:5173）
git clone git@github.com:Gucc111/PilotDeck.git && cd PilotDeck \
  && npm install && cd ui && npm install \
  && npm run dev

# 全新检出 → prod（浏览器 http://localhost:3001）
git clone git@github.com:Gucc111/PilotDeck.git && cd PilotDeck \
  && npm install && cd ui && npm install \
  && npm run start

# 端口清场（开发态卡住时）
for p in 18789 3001 5173; do
  PID=$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | head -1)
  [ -n "$PID" ] && kill "$PID"
done

# 健康探针
curl -s http://localhost:18789/health     # gateway
curl -s http://localhost:3001/api/health  # bridge
```

## 8. 关键源文件索引

读这些文件确认行为，不要凭记忆：

- gateway 入口：`src/cli/pilotdeck.ts`（`server` 命令）+ `src/cli/createLocalGateway.ts`（构造 InProcessGateway + 注入权限钩子）
- gateway server：`src/cli/pilotdeckServer.ts` + `src/gateway/server/GatewayServer.ts`（HTTP/WS 监听 + token）
- ui server 入口：`ui/server/index.js`（Express + WebSocket）
- gateway 客户端桥：`ui/server/pilotdeck-bridge.js`（**关键文件** — 通过 RemoteGateway 连 gateway）
- 本地工具（无 `dist/src` 依赖）：`ui/server/utils/pilotPaths.js`、`ui/server/utils/proxy.js`
- 配置加载：`ui/server/services/pilotdeckConfig.js`、`ui/server/load-env.js`
- vite 代理：`ui/vite.config.js`
- 复刻规划：`docs/old-ui-adaptation/04-implementation-plan/01-web-ui-replication-development-guide.md`
- 运行验收：`docs/old-ui-adaptation/04-implementation-plan/03-real-environment-runbook.md`
