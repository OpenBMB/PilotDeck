# PilotDeck + SOP v4 + 独立 KM 部署

本文件是当前版本的统一部署入口，覆盖源码部署、Compose 和外部服务。无需 StaffDeck checkout、backend 或用户数据库。使用全新实例和数据目录，不导入历史定义、数据库或进行中的执行。

批量执行、foreach、输入映射、节点模型及 Gateway/SDK 接口见 [SOP v4 后端执行](SOP_V4_BACKEND.zh-CN.md)。下列命令从 PilotDeck 仓库根目录执行，除非明确要求切换目录。

## 1. 拓扑与前置条件

| 组件 | 职责 | 协议与存储 |
| --- | --- | --- |
| PilotDeck Web | 登录、聊天、Knowledge 页面、工具权限确认 | 宿主自己的账号和会话 |
| PilotDeck Gateway | AgentLoop、模型、工具、权限、工作空间、SOP 执行宿主 | 单执行宿主 |
| SOP Runtime | 定义、调度、处理项、租约、审批等待和事件 | sop.lifecycle/v4、sop-http-v4，独立 SQLite |
| Knowledge Core | 资料入库、检索、citation 和知识数据 | knowledge-core/v1、rest-http-v1，独立 SQLite |

源码组合部署中四个组件独立运行；Compose 中 Web/Gateway 位于 pilotdeck 容器，SOP/KM 各自位于独立容器。SOP 的模型和工具调用经过 PilotDeck。KM 不依赖 SD 用户表；PilotDeck 登录和可选审批身份适配属于宿主层。

- Node.js `>=22.13.0 <23`、pnpm `10.32.1`、Python `>=3.11`；本机验收使用 Python 3.12。
- 独立 Knowledge Core 安装包或源码。源码部署前须在该包的 `ui` 目录运行 `npm ci`、`npm run build`，确保安装包包含构建后的 UI；准备器不会替 KM 执行 UI 构建。仅有 PilotDeck 仓库不足以安装 KM。
- KM 源码包含 `pyproject.toml`、`setup.py`、`uv.lock`、`ui/package-lock.json`、`src/knowledge_core/cli.py`。
- Compose 模式另需 Docker Compose v2；首次安装/构建需访问 npm、PyPI、镜像仓库。
- 可用的模型 endpoint、API key 和支持工具调用的模型 ID。示例均为占位值，不要提交真实凭据。

使用 `profiles/independent-v4-local.yaml` 或 `profiles/independent-v4-external.yaml`。默认 `native.yaml` 关闭 SOP/KM，不能直接用于本组合。

## 2. 源码部署：SOP + KM + Web

### 准备依赖与模型

```sh
node --version
pnpm --version
pnpm exec node --version
pnpm install --frozen-lockfile
```

准备仓库外的私有模型配置，例如 `/absolute/path/private/pilotdeck.yaml`：

```yaml
schemaVersion: 1
agent:
  model: provider1/replace-with-model-id
model:
  providers:
    provider1:
      protocol: openai
      url: https://model.example.com/v1
      apiKey: ${PILOTDECK_REAL_MODEL_API_KEY}
      models:
        replace-with-model-id:
          capabilities: { supportsToolUse: true }
```

源码准备器复制该文件的 `agent.model` 和 `model.providers`；组合 profile 决定模块绑定。源码模式使用模型配置里的 URL，不依赖 exporter 的 URL 替换。准备和每次启动均须提供配置引用的环境变量；托管 KM 的模型配置还会写入私有 `knowledge-model.json`。

```sh
chmod 600 /absolute/path/private/pilotdeck.yaml
export PILOTDECK_REAL_MODEL_API_KEY='<model-api-key>'
export SOP_V4_MODEL_CONFIG=/absolute/path/private/pilotdeck.yaml
export SOP_SOURCE_PYTHON=/absolute/path/to/python3.12
node scripts/sop-v4-source.mjs prepare /absolute/path/new-sop-km \
  --profile products/pilotdeck-staffdeck-sop/profiles/independent-v4-local.yaml \
  --knowledge-package /absolute/path/knowledge_core --build
```

部署目录必须不存在。`prepare --build` 创建 venv、安装 SOP/KM、构建 PilotDeck 与 Web，并使用生成的实例 profile 构建前端。正常 `start` 不安装、不构建、不下载。准备器重写托管服务路径与端口，样例中的本地占位路径无需替换。此命令不带 `--without-web`，因此启用浏览器登录和交互权限确认。

### 启动、登录与停止

```sh
node scripts/sop-v4-source.mjs start /absolute/path/new-sop-km
node scripts/sop-v4-source.mjs status /absolute/path/new-sop-km
```

SOP/KM 并行启动，检查通过后启动 Gateway，再启动 Web。输出实际 Web/Gateway/Runtime 地址，自动分配的端口保存在 `deployment.json`。打开 Web 地址，首次注册 owner 后登录。KM 默认绑定用户 ID `1` 和 `local` space；已有用户环境须在准备前修改 profile 的 `pilotDeckUserId`、namespace 和 spaces。

实例配置为 `home/pilotdeck.yaml`。Web 默认 `agent.interactionProfile: interactive`，Gateway 将工具权限请求交给浏览器；保持 Default Permissions，按请求单次确认。显式 profile 的交互配置优先。SOP v4 没有独立管理页面，定义通过 API 发布，执行通过聊天工具、Gateway 或 SDK。

```sh
node scripts/sop-v4-source.mjs stop /absolute/path/new-sop-km
# 保持同一模型凭据环境，再启动时数据保留。
node scripts/sop-v4-source.mjs start /absolute/path/new-sop-km
```

停止命令管理本实例全部进程，不要只关闭 Web。启动失败会报告组件与日志位置，并清理本次新启动的进程。

### 模块选择与审批

- SOP-only：复制 local profile，将 `modules.knowledge` 整段替换为 `{ enabled: false }`，无需 `--knowledge-package`。
- KM-only：将 `modules.sop` 整段替换为 `{ enabled: false }`，保留 KM 参数。
- 纯服务：prepare 增加 `--without-web`，不构建/启动 Web，交互默认 headless；需要人工工具权限应答时使用可处理 Gateway 交互的客户端。
- 仅启动托管 Runtime：`start --services-only`，供独立宿主连接。
- 组合样例默认 `approval.provider: disabled`，普通 SOP 可执行，含审批节点的定义在执行前拒绝。需要 owner 审批时 prepare 增加 `--approval-provider pilotdeck` 并保留 Web。自定义宿主可注入 `SopApprovalAuthority`，见后端文档。

工具权限弹窗与 SOP 业务审批节点是两条独立链路。修改模块、交互配置或凭据后重启实例/会话；修改前端模块选择还须按实例 profile 重新构建，不支持运行中热插拔。

已有实例手动重建 Web：

```sh
PILOTDECK_CONFIG_PATH=/absolute/path/new-sop-km/home/pilotdeck.yaml \
PILOTDECK_FRONTEND_PROFILE=/absolute/path/new-sop-km/home/pilotdeck.yaml \
PILOTDECK_DISABLE_LOCAL_AUTH=0 pnpm --dir ui run build
```

## 3. 连接外部 SOP / KM

复制 `profiles/independent-v4-external.yaml`，修改 endpoint、空间/身份绑定和模型 ID；移除对应 `localRuntime`。源码模式不能仅靠 `deployment.mode` 判断托管，必须移除 `localRuntime`。源码仍从 `SOP_V4_MODEL_CONFIG` 读取模型，Compose 使用 profile 自身模型配置。

在准备和启动环境提供声明的凭据：

```sh
export SOP_V4_HOST_TOKEN='<external-sop-host-token>'
export PILOTDECK_KM_SERVICE_TOKEN='<external-km-service-bearer>'
export PILOTDECK_KM_CAPABILITY_TOKEN='<external-km-capability-bearer>'
node scripts/sop-v4-source.mjs prepare /absolute/path/new-external-client \
  --profile /absolute/path/external-profile.yaml --build
node scripts/sop-v4-source.mjs start /absolute/path/new-external-client
```

无需 `--knowledge-package`；宿主只检查协议和连接，不启动或停止外部进程。外部服务需要兼容 release、网络、TLS、认证及匹配的 namespace/spaces。KM 若使用宿主 capability，须另配可达的回调 URL 和 bearer，不能使用其他主机的 loopback 或其他 Compose 网络的 DNS。外部服务数据由所属部署备份和验收。

YAML 是连接声明；若同时使用过渡环境变量 `PILOTDECK_SOP_V4_ENDPOINT`，endpoint/token 必须一致，冲突启动报错。建议仅使用 YAML 和其 `credentialEnv`。

## 4. Compose 自包含部署

复制 `independent-v4-external.yaml`，设置实际模型 ID，将 `modules.sop` 和 `modules.knowledge` 的 `deployment` 分别设为 `{ mode: build }`，保留完整 methods，不增加 `localRuntime`。浏览器交互显式配置：

```yaml
agent:
  model: provider1/replace-with-model-id
  interactionProfile: interactive
```

导出器将托管 endpoint 改为内部地址。外部服务保留 `{ mode: external }`；已有兼容镜像可用 `{ mode: image, image: registry.example.com/component:release }`，镜像入口和协议须单独验证。

```sh
export PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \
  --profile /absolute/path/v4-compose-profile.yaml \
  --knowledge-root /absolute/path/knowledge_core \
  --out /absolute/path/new-v4-export
cd /absolute/path/new-v4-export
cp .env.example .env
chmod 600 .env
```

输出目录须为空；完整目录可移动到部署主机，不依赖原 checkout。仅打包独立 SOP/KM，不复制 SD 后端。KM 为 image/external 模式时无需 `--knowledge-root`。编辑 `.env`，使用不同私有凭据，不将服务 token 当登录密码：

```dotenv
PILOTDECK_API_KEY=replace-with-host-api-key
PILOTDECK_REAL_MODEL_API_KEY=replace-with-model-key
PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
SOP_V4_HOST_TOKEN=replace-with-sop-host-token
PILOTDECK_KM_SERVICE_TOKEN=replace-with-km-service-bearer
PILOTDECK_KM_CAPABILITY_TOKEN=replace-with-host-capability-bearer
PILOTDECK_PORT=3314
```

```sh
docker compose -p pilotdeck-km-sop --env-file .env config --quiet
docker compose -p pilotdeck-km-sop --env-file .env up -d --build
docker compose -p pilotdeck-km-sop --env-file .env ps
```

访问 `http://127.0.0.1:3314`。仅 Web 绑定宿主 loopback，SOP/KM 不暴露宿主端口：

| 服务 | 内部地址 | 持久卷与数据库 |
| --- | --- | --- |
| pilotdeck | http://pilotdeck:3001 | pilotdeck-home |
| sop-runtime | http://sop-runtime:8091 | sop-v4-data，/data/runtime.sqlite |
| knowledge-runtime | http://knowledge-runtime:8787 | knowledge-core-data，/data/knowledge.sqlite |

构建期确定 profile、前端模块和登录模式，运行期注入 key/token。更改模块或模型 URL 须重新导出和构建；URL 在导出期还用于网络排除配置。只轮换凭据时更新 `.env` 并重新创建容器。Compose KM 模型/解析经过宿主 capability；源码托管 KM 使用私有本地模型配置，不混用两者配置。

## 5. 验证与验收

先检查基础健康，源码模式替换为 `status` 输出的实际端口再执行：

```sh
curl --fail http://127.0.0.1:<web-port>/health
curl --fail http://127.0.0.1:<sop-port>/healthz
curl --fail http://127.0.0.1:<km-port>/api/km/config
```

SOP 应为 `sop.lifecycle/v4`，KM 应为 `knowledge-core/v1`。SOP 认证的 `/v4/ready` 检查数据库和 host token；KM `/health/ready` 检查就绪。Compose 内探测：

```sh
docker compose -p pilotdeck-km-sop exec -T sop-runtime \
  python -c "import os; from urllib.request import Request,urlopen; print(urlopen(Request('http://127.0.0.1:8091/v4/ready',headers={'Authorization':'Bearer '+os.environ['SOP_V4_HOST_TOKEN']})).read().decode())"
docker compose -p pilotdeck-km-sop exec -T knowledge-runtime \
  python -c "from urllib.request import urlopen; print(urlopen('http://127.0.0.1:8787/health/ready').read().decode())"
```

登录后检查 `/api/modules/runtime`：Gateway ready、SOP/KM enabled、协议一致、无 unavailable slot。继续业务验收：

1. Knowledge 页面创建库、上传资料，等待 job 成功。
2. 用真实模型查询，打开 citation，核对原文和上传文件。
3. 通过 `/v4/definitions` 发布定义，聊天调用 `run_sop`，在 Default Permissions 下单次确认，再用 `sop_wait`、分页 `sop_result` 核对实际输出。helper 示例见后端文档。
4. SOP 节点调用 `knowledge_query`、`knowledge_resolve_citation`，显式使用有权限的 space，核对结果和工具记录。
5. 启用业务审批时，验证正确主体允许、错误主体拒绝、等待后重启仍可恢复。
6. 完整停止/重启后核对资料、citation、SOP 状态和会话。

源码可重跑脚本：

```sh
node scripts/accept-sop-v4-km.mjs /absolute/path/new-sop-km
node scripts/accept-sop-v4-source.mjs /absolute/path/new-sop-km
node scripts/accept-sop-v4-approval.mjs /absolute/path/new-sop-km
```

这些脚本创建测试资料/定义并消费真实模型，仅用于专用验收目录。`accept-sop-v4-source.mjs` 包含真实登录审批与全实例重启，运行前需启用 PilotDeck 审批适配器和 Web；账号记录在私有 `owner-login.json`，不要输出或提交。`accept-sop-v4-approval.mjs` 则在实例下新建隔离测试目录，自行启动 Runtime/宿主并注入自定义审批适配器，验证允许、拒绝、等待与跨进程恢复，不依赖 Web 或 owner 用户库。

模块、拓扑及性能检查：

```sh
export SOP_RUNTIME_PYTHON=/absolute/path/new-sop-km/venv/bin/python
node scripts/test-sop-v4-modules.mjs
# 下列两项从已停止的专用组合实例开始。
node scripts/accept-sop-v4-topologies.mjs /absolute/path/stopped-combined \
  /absolute/path/new-evidence /absolute/path/knowledge_core
node scripts/benchmark-sop-v4-startup.mjs /absolute/path/stopped-combined
```

模块协议夹具、真实 KM/模型、浏览器、Compose 和性能分别记录。性能目标是依赖/构建准备完成后连续十轮（首次及九次完整重启）均在 10 秒内，通过协议、数据库和 Gateway 绑定检查，报告最大值与中位数。`prepare-timing.json`、`start-timing.json`、`startup-benchmark.json` 分别记录准备、单次启动和基准。模型首响应另计，不宣称操作系统冷缓存或其他主机性能。

历史证据见 [v4 解耦验收](SOP_V4_DECOUPLED_ACCEPTANCE.zh-CN.md)、[源码插拔验收](SOP_V4_SOURCE_ACCEPTANCE.zh-CN.md)、[v4 执行验收](SOP_V4_ACCEPTANCE.zh-CN.md)，不代表本次部署已重新验收。公网生产域名、企业外部审批、真实支付核账和历史数据迁移不在本机冒烟范围。

## 6. 数据、备份与回退

源码停写并停止全部组件后备份整个实例目录，至少包含：

| 路径 | 内容 |
| --- | --- |
| home/ | 模型/profile、账号、会话、宿主状态 |
| runtime-data/runtime.sqlite | SOP 状态、租约、审批等待和事件 |
| knowledge-data/knowledge.sqlite | KM 数据 |
| workspace/ 和实际注册的项目目录 | 上传资料、.sop-inputs、.sop-results、生成文件 |
| knowledge-*.json、private.json、deployment.json | 配置、身份、凭据及进程路径 |

保留 SQLite WAL 等关联文件。外部服务由所属部署独立备份。源码 `deployment.json` 记录 checkout 路径，不是可随意移动的自包含 release。

Compose 备份从导出目录执行：

```sh
mkdir -p backups/pre-upgrade
docker compose -p pilotdeck-km-sop stop
docker compose -p pilotdeck-km-sop cp knowledge-runtime:/data backups/pre-upgrade/knowledge
docker compose -p pilotdeck-km-sop cp sop-runtime:/data backups/pre-upgrade/sop
docker compose -p pilotdeck-km-sop cp pilotdeck:/root/.pilotdeck backups/pre-upgrade/host
cp -R config backups/pre-upgrade/config
cp .env backups/pre-upgrade/runtime.env
chmod 600 backups/pre-upgrade/runtime.env
docker compose -p pilotdeck-km-sop start
```

未启用的服务跳过对应命令。备份含私有凭据，按部署目录同级保护。普通停止用 `stop`，拆容器用 `down` 并保留卷，禁止持久化部署使用 `down -v`。

升级前保存代码版本、profile、前端产物及全部数据备份。Compose 保持 project 名以复用卷；更名会创建空卷。回退同时恢复 PilotDeck/profile/前端、SOP/KM 版本和匹配数据，不用旧程序打开不兼容的新库。源码升级用匹配 checkout 重新 prepare 新实例，保留原实例目录作为回退入口，不覆盖旧数据。

## 7. 故障排查

- `No interaction answerer is available`：Web 的 `agent.interactionProfile` 应为 `interactive`；修改后重启实例/会话，页面单次确认，不关闭权限检查。
- 首页 `No token provided`：Web 构建和服务端登录模式不一致；按第 2 节带实例 profile 和 `PILOTDECK_DISABLE_LOCAL_AUTH=0` 重建。
- profile mismatch：核对前端构建 profile 和运行配置。SOP v4 提供执行工具，不加载旧管理 UI。
- KM 页面 `list_jobs` 等被拒：保留新版 profile 完整 methods；Agent 仍仅开放 query/resolve_citation，不将 UI 方法缩成 Agent 方法列表。
- `Unknown SOP execution field or operation`：只读操作不传 requestId；helper 的 runId 位于 data，读取结果须显式 limit。
- KM UI 缺失：确认独立包包含构建后的 UI；源码准备器不执行 KM npm 构建。
- 服务 unhealthy：源码查看 `logs/`、`knowledge-data/service.log`；Compose 查看 `docker compose logs sop-runtime knowledge-runtime pilotdeck`，核对协议、凭据、存储和空间。
- 模型失败：核对模型 ID/URL、启动环境 key、工具绑定及 KM capability；healthy 不代表模型可用，节点不会静默换模型。
- 包源/镜像失败：检查网络和容器代理；Compose 可设置 `KM_PYTHON_BASE_IMAGE`、`KM_NODE_BASE_IMAGE`、`SOP_PYTHON_BASE_IMAGE`，宿主构建可覆盖 `NODE_BUILDER_IMAGE`、`NODE_RUNTIME_IMAGE`。
- `result_unknown`：副作用结果无法确认，禁止自动重放/普通重试；先人工核账，再决定是否另建业务运行。
