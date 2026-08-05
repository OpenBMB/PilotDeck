# PilotDeck 接入 StaffDeck 配置说明

本文说明 PilotDeck 连接 StaffDeck、发现可访问数字员工并在群组中调用员工时所需的运行配置。

当前产品范围是：**一个本地 PilotDeck 主智能体负责理解用户需求，并按需调用一个或多个 StaffDeck 数字员工**。暂不把多个 PilotDeck 实例共同建群作为当前版本的配置或验收要求。

## 配置存放位置

本地源码安装默认从以下文件读取配置：

```text
~/.pilotdeck/pilotdeck.yaml
```

StaffDeck 配置放在 `customEnv` 下。该文件是本机运行配置，不应提交到 Git：

```yaml
customEnv:
  STAFFDECK_BASE_URL: http://staffdeck.example.com:10087
  STAFFDECK_API_KEY: sd_live_replace_with_your_key
```

`pilotdeck.yaml` 中的凭据目前是本地明文，不经过 Keychain 或数据库加密。建议将文件权限限制为当前用户可读写：

```bash
chmod 600 ~/.pilotdeck/pilotdeck.yaml
```

## 支持的认证方式

PilotDeck 支持账号认证和 Open API Key 两种主要接入方式。

### 方式一：StaffDeck 账号认证

需要按当前 StaffDeck 账号动态获取“自己创建的员工”和“公开可用的员工”时，配置完整的账号信息：

```yaml
customEnv:
  STAFFDECK_BASE_URL: http://staffdeck.example.com:10087
  STAFFDECK_TENANT_ID: tenant_demo
  STAFFDECK_USERNAME: your_username
  STAFFDECK_PASSWORD: your_password
  STAFFDECK_POLL_INTERVAL_MS: "1000"
```

账号模式的行为：

- 通过 `POST /api/auth/login` 登录 StaffDeck，访问令牌只缓存在 PilotDeck 进程内存中。
- 通过 `GET /api/enterprise/agents` 获取当前账号可访问的员工。
- 普通账号能看到自己拥有的私有员工，以及当前发布到员工广场的公开员工。
- PilotDeck 保留员工的创建者、所有权/公开状态、角色、专长和工作方式等元数据。
- 第一次调用尚未使用的公开员工前，PilotDeck 自动调用 `POST /api/chat/agents/{agent_id}/use`。
- 员工对话通过 `POST /api/chat/turn` 执行，并复用群组与员工对应的持续会话。

### 方式二：StaffDeck Open API Key

服务端到服务端接入可只配置 API Key：

```yaml
customEnv:
  STAFFDECK_BASE_URL: http://staffdeck.example.com:10087
  STAFFDECK_API_KEY: sd_live_replace_with_your_key
  STAFFDECK_POLL_INTERVAL_MS: "1000"
```

API Key 模式的行为：

- StaffDeck 根据 Key 自身的 Credential scope 决定可访问员工，PilotDeck 不维护第二套员工白名单。
- 通过 `GET /api/v1/agents` 获取 Key 可访问的员工。
- 通过 `POST /api/v1/agents/{agent_id}/sessions` 创建或恢复持续会话。
- 优先通过 `POST /api/v1/agents/{agent_id}/runs:stream` 启动员工任务并消费 SSE 公开过程事件。
- PilotDeck 将 StaffDeck 的 Public Trace 规范化为可持久化的群组步骤，包括 `run.plan`、`run.intent`、`run.task_frame.*`、`run.capability.*`、`run.citation`、`run.tool.completed`、`run.sop.*`、`run.skill.*`、`run.loop.*`、`run.status` 以及 `run.output.delta/replace/completed`；Run ID 从 `X-Run-ID` 响应头读取。
- Public Trace 是 StaffDeck 主动发布的可审计执行摘要，不包含原始思维链。能力调用结果会作为结构化步骤详情保存，主时间线默认折叠，右侧协作详情默认展开。
- 旧版 StaffDeck 不支持流接口时，自动回退到 `POST /runs`，轮询 `GET /runs/{run_id}` 并在完成后读取 `/result`。
- PilotDeck 为会话和 Run 发送幂等键，避免重试产生重复执行。
- 用户点击群组输入框中的停止按钮时，PilotDeck 会中止入口 Gateway 轮次、清理同一会话尚未执行的队列，并在已获得 `X-Run-ID` 时调用 `POST /api/v1/runs/{run_id}:cancel` 终止远端数字员工任务。

`STAFFDECK_BASE_URL` 可以填写 StaffDeck 服务根地址，也可以填写完整的 `/api/v1` 地址；API Key 模式会自动规范化为 Open API v1 Base URL。

## 凭据选择优先级

连接选择遵循以下顺序：

1. 存在 `STAFFDECK_API_KEY` 时，使用 Open API v1；这是对流式 Run 协议的显式选择。
2. 未配置 API Key，且同时存在 `STAFFDECK_TENANT_ID`、`STAFFDECK_USERNAME` 和 `STAFFDECK_PASSWORD` 时，使用账号认证。
3. `STAFFDECK_API_TOKEN` 仅用于兼容旧部署，不建议作为新接入方案。

因此，同时保留完整账号信息和 API Key 时，**API Key 优先**，确保 `runs:stream` 及 Public Trace 不会被旧账号聊天协议绕过。需要切回账号模式时，应删除或留空 `STAFFDECK_API_KEY`。

## 配置项一览

| 配置项 | 必需条件 | 说明 |
| --- | --- | --- |
| `STAFFDECK_BASE_URL` | 始终必需 | StaffDeck 服务根地址或 `/api/v1` 地址，仅允许 `http`/`https`，不能在 URL 中嵌入用户名或密码 |
| `STAFFDECK_API_KEY` | API Key 模式必需 | `sd_live_...` 服务端凭据，权限边界由 StaffDeck Credential scope 决定 |
| `STAFFDECK_TENANT_ID` | 账号模式必需 | StaffDeck 租户 ID |
| `STAFFDECK_USERNAME` | 账号模式必需 | 用于登录和判断“当前账号创建”的员工 |
| `STAFFDECK_PASSWORD` | 账号模式必需 | StaffDeck 账号密码，仅用于换取访问令牌 |
| `STAFFDECK_POLL_INTERVAL_MS` | 可选 | 仅在旧服务不支持 SSE、回退到 Run 状态轮询时使用；默认 `1000` 毫秒，测试环境可以设为 `0` |
| `PILOTDECK_GROUP_MEMBER_TIMEOUT_MS` | 可选 | 单次群组成员或 StaffDeck Run 的最长执行时间；默认 `300000` 毫秒。超时后 PilotDeck 会取消已取得 Run ID 的远端任务，并把错误记录在委派/协作过程内 |
| `PILOTDECK_GROUP_TURN_TIMEOUT_MS` | 可选 | 群组入口 PilotDeck 整轮的最长执行时间；默认比成员超时多 `60000` 毫秒，让成员失败或取消结果能先返回入口智能体完成解释和收口 |
| `STAFFDECK_API_TOKEN` | 仅兼容旧部署 | 旧版账号兼容 Token，新部署不建议使用 |

## 员工发现与权限边界

- PilotDeck 不通过员工 ID 白名单筛选 StaffDeck 员工。
- 账号模式完全遵循 StaffDeck 对当前账号返回的可访问员工列表。
- API Key 模式完全遵循 StaffDeck Key 的 Credential scope。
- 已归档员工和 StaffDeck 的总体协调 Agent 不会作为可邀请的数字员工展示。
- 邀请面板按“我创建的”“公开可用的”“其他可访问的”分类，并显示创建者、角色、专长和描述。
- 用户发送自然语言消息后，由 PilotDeck 主智能体自主决定是否调用数字员工以及调用哪些员工；没有必要时不会调用。

## 加载与更新

- `npm run dev` 和服务启动命令会从 `~/.pilotdeck/pilotdeck.yaml` 加载 `customEnv`。
- 运行中的 UI 服务监听该文件的变化；更新后通常可以热加载。
- 修改凭据、协议或 Base URL 后，建议重启 PilotDeck，确保内存中的 StaffDeck Token、会话和员工激活缓存全部刷新。

## 验证配置

启动 PilotDeck 后，可以通过本地接口验证连接和员工发现结果，输出不会包含 API Key 或密码：

```bash
curl -sS http://127.0.0.1:3001/api/groups/available-members \
  | jq '{
      configured: .staffdeckConfigured,
      error: .staffdeckError,
      count: (.staffdeck | length),
      employees: [.staffdeck[] | {
        name,
        access: .staffdeckAccess,
        creator: (.creatorDisplayName // .creatorUsername),
        role: .roleName
      }]
    }'
```

正常结果应满足：

- `configured` 为 `true`。
- `error` 为 `null`。
- `employees` 只包含 StaffDeck 允许当前账号或 Key 访问的员工。
- 自建员工的 `access` 为 `owned`，员工广场公开员工为 `public`。

还应在 PilotDeck 群组中完成一次真实验证：邀请一个 StaffDeck 员工，发送明确任务，确认时间线中依次出现委派步骤、StaffDeck 实时阶段、员工回复和 PilotDeck 主智能体的后续总结。主时间线的最近步骤默认折叠，右侧详情中的全部步骤默认展开。

## 安全要求

- 不得把真实 API Key、密码或访问令牌写入仓库、测试快照、群组消息或日志。
- 示例、文档和测试只能使用占位符或测试凭据。
- 生产环境优先使用 HTTPS，并定期轮换 `STAFFDECK_API_KEY`。
- Key 泄露后应先在 StaffDeck 撤销旧 Key，再更新本机配置并重启 PilotDeck。
- PilotDeck 只持久化员工 ID、公开元数据、消息和执行状态，不把 StaffDeck 密码、API Key 或登录 Token 序列化到群组数据中。

## 常见问题

### 显示“StaffDeck 未配置”

确认 `STAFFDECK_BASE_URL` 存在，并且账号模式或 API Key 模式至少有一组完整凭据。

### 账号下员工数量与 API Key 不一致

这是预期行为。账号权限和 API Key Credential scope 是两套独立的 StaffDeck 权限边界；配置 `STAFFDECK_API_KEY` 时 PilotDeck 使用 Key 的范围，删除 Key 后才会使用完整账号凭据。

### 修改 Key 后仍然调用失败

确认旧 Key 已撤销、新 Key 可直接访问 StaffDeck Open API，并重启 PilotDeck 清除进程内缓存。不要在错误报告中粘贴完整 Key。

### 公开员工能看到但首次调用失败

检查当前 StaffDeck 账号是否有权执行 `/api/chat/agents/{agent_id}/use`，以及员工是否仍处于已发布、未归档状态。
