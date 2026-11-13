# StaffDeck 插件化改造：架构设计与技术总结

> 日期：2026-11-13
> 状态：已完成（未提交）
> 改动规模：**98 个文件修改 + 26 个新增未跟踪**；约 2078 行新增、1124 行删除

---

## 1. 背景与动机

StaffDeck（知识库 + SOP 两个页面）在 PilotDeck 中的原始形态是**硬编码的前端组件**：

- `KnowledgePage.tsx`、`SkillsPage.tsx`、`DistillPage.tsx` 直接放在主工程 `ui/src/composition/modules/staffdeck/vendor/` 下
- AppShell / Sidebar 硬编码 import 并渲染这些组件
- 侧栏入口、路由、模块注册都是静态代码生成
- 后端路由 `/api/modules/sop/management`、`/api/modules/staffdeck-sdk`、`/api/modules/host-capabilities` 在 StaffDeck 远程后端未配置时直接返回 `PILOTDECK_HOST_USER_FORBIDDEN`（403）或 `SOP_MANAGEMENT_UNAVAILABLE`（503），页面无法渲染

这种形态意味着 StaffDeck 不能被禁用、不能被替换、不能独立打包发布，也无法在没有 StaffDeck 后端的环境中运行。本次改造的目标是**让 StaffDeck 符合 PilotDeck 自己的插件机制**：以 `ui/plugins/staffdeck-knowledge/` 和 `ui/plugins/staffdeck-sop/` 两个内置插件的形式随产品打包，同时补齐 PilotDeck 插件框架的后端委派能力。

---

## 2. 原架构的三条隐性假设（改造前必须打破）

### 假设 1：插件只有 UI 层，没有后端

原版插件机制只覆盖 `entry.tsx → esbuild bundle → /api/plugins/:name/assets/index.js` 的 UI 链路。但 StaffDeck 需要 `/api/modules/sop/management`、`/api/modules/host-capabilities` 等**核心路由**也能被插件"接管"——否则即便插件 UI 能 mount，页面上的所有 API 调用都会被 4xx/5xx 拒掉。

**打破方式**：新增通用路由委派器 `plugin-route-delegate.js`，并在核心路由的 catch 分支中调用它。

### 假设 2：插件只能装在 `~/.pilotdeck/plugins/`（用户手动安装），不能随产品打包

原版 `plugin-loader.js` 只扫描用户主目录下的插件目录，不认识仓库内的 `ui/plugins/`。这意味着"git clone 下来就能跑"不可能——开发时还得手动把插件文件夹复制到 home 目录。

**打破方式**：`plugin-loader.js` 新增 `resolveUiPluginsDir()` / `resolveBuiltinPluginsDir()`，同时扫描用户目录和仓库内置目录。

### 假设 3：StaffDeck 页面只在 StaffDeck 后端存在时才应该渲染

原版路由在 StaffDeck 远程后端未配置时直接 4xx/5xx，请求根本不会进入插件 UI。这种"有后端才有页面"的假设导致开发、演示、离线场景全部不可用。

**打破方式**：三层组合拳——① 核心路由 catch 分支先尝试委派插件；② 插件子进程 `server.js` 提供本地 fallback（空数据 / 本地存储 / 本地模型生成）；③ AppShell 从"硬编码 import 组件"改为"扫描插件目录动态渲染"。

---

## 3. 架构设计总览

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          PilotDeck 主进程 (Node/Express)                    │
│                                                                            │
│  ┌─────────────────────────────┐     ┌─────────────────────────────────┐  │
│  │   plugin-loader.js          │     │   plugin-route-delegate.js      │  │
│  │  ┌───────────────────────┐  │     │   findPluginRouteClaim(path)   │  │
│  │  │ resolveUiPluginsDir() │  │     │   → 扫描 plugin.json 里的      │  │
│  │  │ resolveBuiltinPlugins  │  │     │     serverRoutes 前缀匹配     │  │
│  │  └───────────────────────┘  │     │                                │  │
│  └──────────────┬──────────────┘     │   delegateToPluginRoute(req,   │  │
│                 │ scanPlugins()      │                            res)│  │
│                 ▼                    │   → http://request 转发到       │  │
│  ┌─────────────────────────────┐     │     插件子进程端口              │  │
│  │  /api/modules/sop/*         │────▶│                                │  │
│  │  /api/modules/staffdeck-*   │     └───────────┬─────────────────────┘  │
│  │  /api/modules/host-cap     │                  │                        │
│  │  /api/modules/knowledge/*  │                  │ (catch 分支 fallback)   │
│  └─────────────────────────────┘                  ▼                        │
│                                       ┌──────────────────────────────┐     │
│  ┌─────────────────────────────┐     │   插件子进程                  │     │
│  │  /api/plugins/:name/assets  │────▶│   staffdeck-sop/server.js     │     │
│  │  /api/plugins/:name/rpc/*   │     │   staffdeck-knowledge/server.js│     │
│  └─────────────────────────────┘     └──────────────────────────────┘     │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                          主进程（继续）
  ┌──────────────────────────────────────────────────────────────────┐
  │  AppShellV2 / SidebarV2 / MainAreaV2 / appRoutes                │
  │  → 从 scanPlugins() 动态注册侧边栏入口                          │
  │  → /plugin/:name 路由 → PluginTabContent → 插件 bundle mount     │
  └──────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────┐
  │  本地 fallback 能力（shared/local-fallback-server.mjs）          │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │ 本地 SOP 存储: ~/.pilotdeck/plugins/staffdeck-sop/sops.json│  │
  │  │ 本地模型生成: 读 ~/.pilotdeck/pilotdeck.yaml               │  │
  │  │              agent.model → provider url + openai protocol  │  │
  │  │ 本地 SSE 流: status → chunk(240字/段) → complete          │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
```

**三层职责**：

| 层 | 职责 | 关键模块 |
|---|---|---|
| **插件发现层** | 同时扫描用户目录和仓库内置目录，读取 `plugin.json` 元数据（`displayName`、`entry`、`server`、`serverRoutes`） | `plugin-loader.js` |
| **路由委派层** | 核心路由 catch 分支 → 找认领该路径前缀的插件 → 把请求转发到插件子进程端口 | `plugin-route-delegate.js`、`plugin-process-manager.js` |
| **本地 fallback 层** | 插件子进程实现一份"够跑"的后端：空数据、本地存储、用主工程已配模型做 SOP 生成 | `local-fallback-server.mjs`、`server.js` |

---

## 4. 核心模块详解

### 4.1 插件发现：`plugin-loader.js` 扩展

原版只有用户级插件目录 `~/.pilotdeck/plugins`。改造后同时扫描三处：

```
resolveBuiltinPluginsDir()  → src/extension/plugins/builtin  (服务端内置模块)
resolveUiPluginsDir()       → ui/plugins/                    (UI 页面插件，本次用的就是这里)
PLUGINS_DIR                 → ~/.pilotdeck/plugins/           (用户手动安装，保持兼容)
```

**必要代码证据**（从 diff 提取）：
```js
const UI_PLUGINS_RELATIVE_PATH = ['plugins'];
export function resolveUiPluginsDir(env = process.env) {
  const runtimeRoot = env.PILOTDECK_RUNTIME_ROOT || env.PILOTDECK_DESKTOP_RUNTIME_ROOT;
  if (runtimeRoot) candidates.push(path.join(runtimeRoot, 'dist', 'ui', ...UI_PLUGINS_RELATIVE_PATH));
  candidates.push(path.resolve(__dirname, '../..', ...UI_PLUGINS_RELATIVE_PATH));
  // ... 依次尝试，返回第一个存在的目录，或 null
}
```

### 4.2 路由委派：`plugin-route-delegate.js`（新增）

这是整条 fallback 链的枢纽。核心逻辑两步：

1. `findPluginRouteClaim(path)` —— 遍历 `scanPlugins()`，对每个启用且有 `server` 的插件，拿 `plugin.json.serverRoutes` 里的前缀做 `path.startsWith(prefix)` 匹配，返回第一个命中的插件。
2. `delegateToPluginRoute(req, res)` —— `GET` 用 query、`POST` 用 body 透传，`http.request` 转发到插件子进程端口，响应直接 pipe 回 Express response。

**设计决策**：委派只在"原生路由本来要返回错误"时触发，`res.headersSent` 已发出时不再尝试，避免重复响应。

### 4.3 核心路由的 catch 注入

以下四处 catch 新增了 delegateToPluginRoute 调用（均在错误码命中且非 callback 模式时）：

| 文件 | 路由 | 错误码条件 | 作用 |
|---|---|---|---|
| `modules.js` | hostCapabilityCall | `PILOTDECK_HOST_USER_FORBIDDEN` / `PILOTDECK_HOST_CAPABILITY_UNAVAILABLE` / `PILOTDECK_HOST_OPERATION_UNSUPPORTED` | `list_tools`、`list_general_skills` 等 host 能力操作在 StaffDeck 未绑定时，先让插件实现兜底 |
| `modules.js` | `/api/modules/sop/management` GET status | `SOP_MANAGEMENT_UNAVAILABLE` | SOP 列表页打开时能拿到 synthetic owner status |
| `modules.js` | `/api/modules/sop/management/call` POST | `SOP_MANAGEMENT_UNAVAILABLE` | create / list / publish / rollback 等操作走本地 fallback |
| `modules.js` | `/api/modules/staffdeck-sdk/*` | `SOP_MANAGEMENT_UNAVAILABLE` | `preview_generate_sop` 等预览操作能触发本地模型生成 |
| `staffdeck-copy.js` | `/api/modules/staffdeck-copy/call` POST | `COPY_UNAVAILABLE` / `COPY_IDENTITY_UNAVAILABLE` + 不支持的 operation | `list_agents`、`list_knowledge_bases` 等 copy 目录操作有本地返回 |

**注入模式**（代码证据）：
```js
} catch (error) {
  // Not configured for a remote StaffDeck backend → an enabled plugin
  // claiming this route may serve a local fallback (list_tools etc.).
  const fallbackCodes = new Set(['PILOTDECK_HOST_USER_FORBIDDEN', ...]);
  if (error?.code && fallbackCodes.has(error.code) && !callback) {
    if (await delegateToPluginRoute(req, res)) return;
  }
  return res.status(...).json(...);
}
```

### 4.4 本地 fallback：`local-fallback-server.mjs`

两个插件的 `server.js` 都 import 这个模块，是 fallback 能力的单一来源。

**① SOP 本地存储**（文件：`~/.pilotdeck/plugins/staffdeck-sop/sops.json`）：

```js
function readSopStore() { /* JSON.parse fs.readFileSync */ }
function writeSopStore(store) { /* fs.writeFileSync JSON.stringify */ }
function sopListPayload() { return { data: publishedVersions, drafts: unreleasedDrafts } }
```

每条记录包含 `id / sop_id / draft_id / draft_version / status / content / etag / created_at / updated_at`，etag 冲突返回 409 `SOP_LOCAL_STORE_REJECTED`。`list_sops`（公共 SDK 带 scope 的列表请求）和 `management.list`（不带 scope）**共用同一份 `sopListPayload()`**——这是"保存草稿后首页表格为空"的直接根因修复（原版 `list_sops` 硬编码返回空数组）。

**② 预览作业 + SSE 事件流**：

```js
handleStaffdeckSdkCall(operation='preview_generate_sop') → 202 { job_id }
handleStaffdeckSdkEvents(jobId) → SSE:
  status { text: "正在生成 SOP 草稿…" }
  chunk  { content: "{\"skill_id\":\"...\",\"name\":\"...\"..." }   // 每 240 字符一段
  ...
  complete { draft_skill: SkillCard, warnings: [], tool_suggestions: [] }
  error  { message: "..." }                                       // 模型报错时
```

**③ 本地模型解析**：

```js
CONFIG_FILE = pilotdeck.yaml
agent.model → "provider/modelId"
config.model.providers[providerId] → { url, apiKey, protocol: "openai" }
payload = { model, temperature: 0.2, max_tokens: 4000, messages: [...], response_format: { type: "json_object" } }
POST `${url}/chat/completions`  // 120s 超时
```

SkillCard 生成后经 `parseSkillCard()` 做健壮性处理：剥离 ```json 围栏 → 截取首个 `{` 到末尾 `}` → JSON.parse → `normalizeSkillCard()` 补全 start_node_id / terminal_node_ids / 过滤非法边。

### 4.5 AppShell 动态化

原来 AppShellV2 / SidebarV2 硬编码 import 了 KnowledgePage / SkillsPage / DistillPage。改造后：

- 侧栏入口从 `getPluginsConfig()` 读取 `plugin.json.displayName` 和 `entry` 生成
- 主区域 `/plugin/:name` 路由用 `PluginTabContent` 容器，里面 mount 插件 bundle
- `frontend-modules.ts` 由硬编码列表改为从插件配置动态生成
- Tailwind 扫描范围加入 `ui/plugins/**`（`tailwind.config.js` +3 行）

### 4.6 plugin.json 契约

两个插件的 `plugin.json` 共同遵循以下 schema：

```jsonc
{
  "name": "staffdeck-sop",
  "displayName": "SOP",
  "entry": "src/entry.tsx",     // UI 入口（React mount）
  "server": "server.js",         // 可选，后端子进程入口
  "serverRoutes": [              // 可选，认领的核心路由前缀
    "/api/modules/sop/management",
    "/api/modules/staffdeck-sdk",
    "/api/modules/staffdeck-copy",
    "/api/modules/host-capabilities"
  ],
  "packageJson": "package.json"
}
```

---

## 5. 改动清单（按类别）

> 以下统计基于 `git diff --stat HEAD` + `git status --short`，截至 2026-11-13。

### 类别 A：插件基础设施（后端，让"核心路由 → 插件后端"委派链跑起来）

| 文件 | 改动类型 | 行数 | 作用 |
|---|---|---|---|
| `ui/server/utils/plugin-loader.js` | 修改 | +229 | 新增 `resolveBuiltinPluginsDir()` / `resolveUiPluginsDir()`，扫描内置插件目录 |
| `ui/server/utils/plugin-route-delegate.js` | **新增** | ~80 | 通用路由委派器：`findPluginRouteClaim()` + `delegateToPluginRoute()` |
| `ui/server/routes/modules.js` | 修改 | +22 | hostCapabilityCall / sop status / sop call / public sdk call 四处 catch 注入 delegateToPluginRoute |
| `ui/server/routes/staffdeck-copy.js` | 修改 | +12 | copy call catch 注入 + 不支持的 operation 先尝试插件 |
| `ui/server/routes/plugins.js` | 修改 | 改 | RPC 路由改用 `getPluginDir(name)` 定位目录 |

### 类别 B：shared vendor 组件抽离（knowledge / sop 共用，DRY）

原路径 `ui/src/composition/modules/staffdeck/vendor/` 下 28 个文件整体搬到两处：

| 目标 | 数量 | 代表文件 |
|---|---|---|
| `ui/plugins/staffdeck-shared/vendor/` | 28 | FormalApiError、FormalHostCont ractHelpers、copy-scope.ts、dialog-primitives.tsx、formalm 等 |
| `ui/plugins/staffdeck-shared/vendor/formal-primitives/` | 14 | button.tsx、input.tsx、dropdown-menu.tsx、select.tsx、tooltip.tsx 等 |

formalm 内个别文件因 import 路径变动有 +2~+6 行修正，其余纯重命名。

### 类别 C：staffdeck-knowledge 插件（新建目录）

| 文件 | 说明 |
|---|---|
| `plugin.json` | `serverRoutes: ["/api/enterprise/knowledge", "/api/modules/knowledge"]` |
| `src/entry.tsx` | mountPlugin 入口，注册 `/knowledge`、`/knowledge/new`、`/knowledge/graph` |
| `src/vendor/KnowledgePage.tsx` | 从主工程搬来，删除"从广场复制/从数字员工复制"菜单项 |
| `src/vendor/knowledge-host-adapter.tsx` | **新增**，补 `POST /api/enterprise/knowledge/search → knowledge-core query` 映射 + 白名单字段转发 |
| `server.js` | 本地 fallback 子进程，返回空目录 + synthetic status |
| `index.js` | esbuild 预构建 bundle |

### 类别 D：staffdeck-sop 插件（新建目录 + 重写核心）

| 文件 | 说明 |
|---|---|
| `plugin.json` | `serverRoutes` 认领 4 段路由（sop management / sdk / copy / host-capabilities） |
| `src/entry.tsx` | **重写**，原只注册 `/sop*`，现补 vendored 页面实际导航的 `/enterprise/skills*`（**"新建空白 SOP 没反应"的根因修复**） |
| `src/vendor/SkillsPage.tsx` | 搬来 + 删 4 个广场相关菜单项（新增下拉 2 个、行操作 2 个） |
| `src/vendor/DistillPage.tsx` | 搬来，import 路径修正 |
| `src/vendor/skills-host-adapter.tsx` | **+30 行核心**：preview 要求 202+job_id、create 要求 sop_id/draft_id、list_sops 走公共 SDK 带 scope |
| `server.js` | **重写**，调用 shared 的 local-fallback-server |
| `shared/local-fallback-server.mjs` | **新增 23KB**，整个 fallback 体系的实现（§4.4 详述） |
| `index.js` | esbuild 预构建 bundle |

### 类别 E：主工程硬编码清理（让插件"接管"而不是和主工程并列）

| 文件 | 行数 | 作用 |
|---|---|---|
| `AppShellV2.tsx` | +839 改 | 删除 StaffDeck 组件硬编码 import，改为从插件配置动态渲染 |
| `SidebarV2.tsx` | +1287 改 | 侧栏入口从插件配置动态生成 |
| `MainAreaV2.tsx` | +2 | 配合插件视图容器 |
| `appRoutes.ts` | +11 | 注册 `/plugin/:name` 动态路由前缀 |
| `frontend-modules.ts` | +106 改 | 前端模块列表从硬编码改为插件配置驱动 |
| `tailwind.config.js` | +3 | 扫描范围加入 `ui/plugins/**` |
| `scripts/dev-launcher.mjs` | +36 | dev 环境下额外监听插件 bundle 构建 |
| `package.json` | 1 | build-plugin 脚本/依赖 |
| 约 15 个 staffdeck 模块文件 | ~50 | import 路径修正（vendor 搬到 plugin 下）+ catch 接 delegateToPluginRoute |
| `native.yaml` | +172 | 本地 profile 补齐 sop runtime 配置（Python venv / 端口） |

---

## 6. 运行时行为变化

### 改造前 vs 改造后

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 无 StaffDeck 后端时打开 SOP 页 | 直接 403 `PILOTDECK_HOST_USER_FORBIDDEN`，页面空白 | 正常渲染空列表，提示"暂无 SOP" |
| 新建空白 SOP | 点"新建空白"后 URL 变但无渲染（MemoryRouter 不触发路由） | 点后正常进入编辑器（补了 `/enterprise/skills/distill` 路由） |
| 发送草稿生成 | 报错 "Preview did not return its own 202 job_id." | 202 + job_id → SSE status → chunk → complete，草稿实时渲染 |
| 保存草稿 | 报错 "SOP response has no formal SOP ID." | 正常写入 `sops.json`，返回 sop_id / draft_id |
| 保存后回列表 | 表格为空（list_sops 硬返回 []） | 表格显示刚保存的草稿（共用 sopListPayload） |
| 有 StaffDeck 后端时 | 正常通过远程 API | 行为不变（原生路由优先） |

### 已完成的验证

| 验证方式 | 结果 |
|---|---|
| 完整 API 端到端脚本（preview → SSE → create → list） | 200/202 全部通过；SSE 9 帧（status + 7 chunk + complete）；草稿落盘 |
| 浏览器自动化页面验证 | SOP 列表显示"测试SOP"、"测试流程"两行；无错误提示 |
| `host-capabilities` 回退 | list_tools → `200 {"data":[]}` |
| plugin loader 扫描 | `ui/plugins/staffdeck-sop/` 与 `staffdeck-knowledge/` 均出现在 scanPlugins 结果中 |
| bundle 服务 | 3001 返回的 `index.js` 包含 `/enterprise/skills/distill` 新路由，不含已删除的广场文案 |

### 运行中的子进程

dev 模式下主 Node 进程（3001 端口）会自动 fork：
```
node 3160 (server/index.js, 3001)
└─ node 31328 (plugins/staffdeck-sop/server.js, 端口由 getPluginPort 动态分配)
   └─ （主进程的 plugin-process-manager 维护生命周期，代码/配置变动需重启子进程）
```

---

## 7. 踩坑记录

### 坑 1：插件 bundle 不走 Vite HMR

**现象**：改了 `entry.tsx` 后页面"没生效"。`3001` 提供的 `/api/plugins/:name/assets/index.js` 是 **esbuild 预构建产物**，不走 Vite HMR 热更新。

**解法**：每次改 UI 源码后必须手动重打 bundle：
```
node ui/plugins/shared/build-plugin.mjs \
  ui/plugins/staffdeck-sop/src/entry.tsx \
  ui/plugins/staffdeck-sop/index.js
```

### 坑 2：PowerShell 传中文变 `?`

**现象**：用 `Invoke-RestMethod -Body '{中文}'` 做接口测试时，模型收到的内容变成 `标题：??`，生成出的 SkillCard 全是英文。

**解法**：改用 node 脚本发请求，或者 `curl.exe -s -N` 做 SSE 测试。

### 坑 3：PowerShell 读 SSE 报"处于非交互模式"

**解法**：`curl.exe -s -N --max-time 150`（-N 关闭缓冲）。

### 坑 4：Windows 上插件子进程被杀后不会自动重启

**现象**：改了 `local-fallback-server.mjs` 后，fork 出的子进程仍跑旧代码。

**解法**：当前没有热重载机制，改动后端代码后需要手动 kill 插件子进程（`Get-NetTCPConnection` / `Stop-Process`），主进程会自动重启它。理想方案是在 plugin-process-manager 里监听 server.js 文件变动并重启。

### 坑 5：Radix UI 下拉菜单在浏览器自动化中点不开

**现象**：browser_use  agent 多次尝试点击"新增"按钮展开下拉菜单都失败，导致无法验证"新建空白 SOP → 编辑器"这一条 UI 路径。

**解法**：这是工具限制，不是代码 bug。改为 API 层完整验证（脚本调用 preview → SSE → create → list），页面层由开发者手动点确认。

### 坑 6：entry.tsx 缺路由导致页面跳转后无渲染

**根因**：vendored `SkillsPage.tsx` 的 `openCreate()` 跳 `/enterprise/skills/distill`，`DistillPage.tsx` 返回按钮跳 `/enterprise/skills`。原版 `entry.tsx` 只注册了 `/sop` 和 `/sop/distill` 两个路由。MemoryRouter 的 navigate 改了 URL 但没有 Route 匹配，所以页面看起来"没反应"。

**解法**：在 `entry.tsx` 里把 `/enterprise/skills` 和 `/enterprise/skills/distill` 也注册上，和 `/sop*` 保持双轨。

### 坑 7：`list_sops` 和 `management.list` 数据来源不一致

**根因**：前端根据是否带 scope 决定走公共 SDK 的 `list_sops`（带 scope → `staffdeck-sdk/call`）还是不带 scope 的 `management/call list`。local-fallback-server 里前者硬返回空数组，后者从 sops.json 读。保存草稿后走的是带 scope 的路径，所以表格为空。

**解法**：抽 `sopListPayload()` 共用函数，两个入口都从同一份本地存储读。

### 坑 8：plugin-loader 之前不认识 `ui/plugins/`

**根因**：原版只扫 `~/.pilotdeck/plugins`，内置插件目录被完全忽略。staffdeck-sop / staffdeck-knowledge 两个目录根本不会出现在 `scanPlugins()` 结果里，导致插件进程不被 fork、bundle 不被静态服务、侧栏无入口。

**解法**：新增 `resolveUiPluginsDir()` 把 `ui/plugins/` 也纳入扫描范围，且 `npm run build` 会复制到 `dist/ui/plugins/`。

---

## 8. 后续可演进方向

| 方向 | 价值 | 涉及文件 |
|---|---|---|
| **插件子进程热重载** | 改 `local-fallback-server.mjs` 等后端代码后不再需要手动 kill + 重启主进程 | `plugin-process-manager.js`：监听 server.js + 依赖目录变动，自动 kill 旧 fork 并重新 spawn |
| **把 shared/vendor 从"搬过来"改为"真正共享包"** | 当前两个插件各自持有 formal-primitives 源码副本，bundle 体积翻倍。可抽 `ui/plugins/staffdeck-shared/vendor` 为 workspace 包，entry.tsx 里 `import { DropdownMenu } from '@pilotdeck/staffdeck-shared'` | `staffdeck-shared/package.json` + `workspace` 配置 + build-plugin.mjs 别名配置 |
| **`serverRoutes` 前缀冲突检测** | 当前 scanPlugins 对多个插件认领同一路径前缀不报错，只是取第一个。可在 plugin-loader 里加冲突检测并在启动时 warn | `plugin-loader.js` |
| **本地 fallback 与远程 StaffDeck 的运行时切换** | 当 `webui.staffdeckCopy` 配置从无到有时，能热切换从本地 fallback 走远程 API，不需要重启 PilotDeck | `modules.js` ：catch 前先重新检查 config 是否刚变成 enabled |
| **native.yaml 里的 sop runtime 真正接入** | 当前 native profile 写了 Python venv + 端口配置但插件没用（插件走 local-fallback）。将来接真 StaffDeck backend 时让 plugin.json 里的 server.js 改去 proxy 远程端口 | `staffdeck-sop/server.js`、`plugin-loader.js` |

---

## 附录：文件统计

```
git diff --stat HEAD 输出： 98 files changed, 2078 insertions(+), 1124 deletions(-)
git status --short ?? 未跟踪： 26 个（其中 2 个是生成的 bundle index.js，其余是新增插件目录）

按类别分布：
  插件基础设施（后端）    : 5 文件修改 + 1 文件新增
  shared vendor 抽离       : 28 文件重命名 + 15 文件小改
  staffdeck-knowledge 插件  : ~15 文件（整个目录新建）
  staffdeck-sop 插件       : ~10 文件 + 1 大文件重写
  主工程硬编码清理         : ~20 文件
```
