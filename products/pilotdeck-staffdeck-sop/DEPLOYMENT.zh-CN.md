# StaffDeck 解耦 KM / SOP 部署

新后端推荐使用 `independent-v4-local.yaml` 或 `independent-v4-external.yaml`；`native-five-independent.yaml` 保留 v3 部署。PilotDeck 负责 AgentLoop、Tools、Context、模型和会话；Knowledge Core 负责知识数据；SOP runtime 负责定义版本与生命周期。新版不复制 StaffDeck backend。

新的批量执行、foreach、可配置输入与节点模型后端使用独立 v4 环境，见 [SOP v4 后端部署与接口](./SOP_V4_BACKEND.zh-CN.md)。下节说明 v4；其后编号章节保留 KM / SOP v3 部署，不与 v4 共用数据库。

## SOP v4 与独立 KM

复制 `profiles/independent-v4-external.yaml`，设置模型 ID、KM 空间及服务地址；同机 Compose 将两个模块的 `deployment.mode` 改为 `build`，不填 `localRuntime`。外部模式保留 `external`，不打包或管理对应服务。v4 不使用旧管理页面，定义通过 `/v4/definitions` 发布，执行通过 Gateway/SDK 的 `run_sop` 等工具；批量与循环能力见后端文档。

```sh
export PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \
  --profile /absolute/path/v4-profile.yaml \
  --knowledge-root /absolute/path/knowledge_core --out /absolute/path/new-v4-export
cd /absolute/path/new-v4-export
cp .env.example .env
chmod 600 .env
# 填入模型 key、SOP_V4_HOST_TOKEN 和 KM 两个服务凭据。
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

SOP v4 采用独立 `sop-v4-data:/data`，数据库 `/data/runtime.sqlite`；KM 仍使用 `knowledge-core-data`。不复用 v3 的 `sop-runtime-data`。无 StaffDeck checkout 也可导出和构建；独立 KM 源码通过 `--knowledge-root` 提供。托管服务连接内部网络，只有 PilotDeck 绑定宿主 loopback。运行期 key/token 与构建期 profile 分离，修改模块需重新导出和构建。

v4 默认关闭审批，不依赖用户库；`approval: { provider: pilotdeck }` 选择 owner 登录适配器，自定义适配器由宿主注入。Compose Web 仍使用 PilotDeck 正常登录，这是宿主功能，不是 Runtime 依赖。`/healthz` 验协议，认证的 `/v4/ready` 验数据库与凭据；`/api/modules/runtime` 应显示 v4 已启用、ready 且无 unavailable slot。还需实际验收入库、真实模型查询、citation 和 SOP 调用 KM。

备份前停止写入，备份 KM、SOP v4、Pilot home 及配置；禁止生产使用 `down -v`。回退到对应 PilotDeck/profile/前端与 Runtime 版本及其原数据目录，不把旧程序指向不兼容的新库。Docker 构建遇本机代理连接拒绝，可在本次 `docker compose build` 显式清空 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 及小写对应 build args；网络或首次镜像下载耗时不计入准备完成后的进程启动基准。

本轮 YAML、审批适配、真实 KM、外部连接、Compose 持久化与十轮启动实测见 [v4 解耦验收](SOP_V4_DECOUPLED_ACCEPTANCE.zh-CN.md)。源码准备/启动分别执行，托管 SOP 与 KM 并行；失败日志明确到组件，清理本次进程。外部模式只验证连接，不接管进程。生产停止使用 `docker compose stop`，需要拆除容器时使用 `down` 并保留卷。

## 旧 v3 部署

| 服务 | 协议 | Compose 内部地址 | 数据卷 |
| --- | --- | --- | --- |
| pilotdeck | Web / Gateway / KM capability | http://pilotdeck:3001 | pilotdeck-home |
| knowledge-runtime | knowledge-core/v1、rest-http-v1 | http://knowledge-runtime:8787 | knowledge-core-data |
| sop-runtime | sop.lifecycle/v3、sop-http-v3、hostAdapter: pilotdeck | http://sop-runtime:8091 | sop-runtime-data |

只有 PilotDeck 端口绑定宿主 loopback。KM/SOP 各自拥有健康检查和 SQLite，PilotDeck 中不会重复启动本地 runtime。

本次本地构建、真实模型、浏览器与持久化验证见 [Compose 验收记录](COMPOSE-ACCEPTANCE-20261019.zh-CN.md)。
无 Docker 的本地部署见第 8 节及 [源码验收记录](SOURCE-ACCEPTANCE-20261019.zh-CN.md)。

## 1. 前置条件

- Node.js `>=22.13.0 <23`、pnpm `10.32.1`、Docker Compose v2。
- 可访问 npm、PyPI、镜像仓库，以及支持 tools 的 OpenAI-compatible 模型服务。
- 包含 `pyproject.toml`、`setup.py`、`uv.lock`、`ui/package-lock.json`、`src/knowledge_core` 的独立 KM 源码目录。镜像使用 npm/uv 锁文件安装依赖。

`native.yaml` 默认关闭 KM/SOP。旧 `native-five-staffdeck.yaml` 保持原协议与含义；新版使用 `native-five-independent.yaml` 或等价配置。SOP 使用本仓库 `packages/sop-runtime`，无需 StaffDeck checkout。

## 2. 导出

在 PilotDeck 根目录复制 profile，修改 `agent.model` 与 provider 下模型 ID，替换 `replace-with-model-id`。默认 Knowledge 绑定 owner ID `1` 和 `local` space；已有用户环境需填实际用户 ID。SOP 的必填 `defaultSopId` 默认是 `compose_approval`，运行前发布同名定义；也可改成实际定义 ID。

```bash
cp products/pilotdeck-staffdeck-sop/profiles/native-five-independent.yaml /tmp/km-sop.yaml
export PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
node products/pilotdeck-staffdeck-sop/scripts/export-composition.mjs \
  --profile /tmp/km-sop.yaml \
  --knowledge-root /opt/StaffDeck/knowledge_core \
  --out /opt/pilotdeck-km-sop
```

输出目录须为空，包含 PilotDeck、选定的前端 profile、KM UI 与 npm 锁文件、Python 包和独立 SOP 包，可整体移动后构建。`--staffdeck-root` 继续用于旧协议。

模块选择与登录模式在构建期确定，修改模块后须重新导出并构建。模型 URL 在导出时解析，以生成网络排除配置；key 与 token 在运行时注入。更换 URL 时重新导出，只轮换 key 无需重建前端。

`knowledge.localRuntime.python`、`dataDirectory` 转换为容器 Python 与卷，`configFile` 内容复制到 `config/knowledge.json`；旧数据不会自动迁移。自定义配置必须启用 spaces，供首次启动初始化本地 space。`modelConfig`、`identityFile`、`capabilitiesFile` 等不支持的配置明确报错。默认启用 full 模块及认证，关闭需要外部 publisher 的 publication。SOP 本地 Python 路径被移除，功能开关保留，定义通过管理 API 发布。

## 3. 配置与启动

```bash
cd /opt/pilotdeck-km-sop
cp .env.example .env
chmod 600 .env
```

填入不同随机 token，不要提交凭据：

```dotenv
PILOTDECK_API_KEY=replace-with-host-api-key
PILOTDECK_REAL_MODEL_API_KEY=replace-with-model-key
PILOTDECK_REAL_MODEL_BASE_URL=https://model.example.com/v1
PILOTDECK_KM_SERVICE_TOKEN=replace-with-km-service-bearer
PILOTDECK_KM_CAPABILITY_TOKEN=replace-with-host-capability-bearer
SOP_RUNTIME_PUBLISH_TOKEN=replace-with-publish-token
PILOTDECK_PORT=3314
```

KM 通过 `http://pilotdeck:3001/api/internal/km/capabilities` 使用宿主模型与解析能力，只持有 service/capability bearer，不复制模型 key。SOP 发布 token 和审批 owner JWT 分别配置。

```bash
docker compose -p pilotdeck-km-sop config --quiet
docker compose -p pilotdeck-km-sop up -d --build
docker compose -p pilotdeck-km-sop ps
```

打开 `http://127.0.0.1:3314`，首次注册 owner 后正常登录。生成配置在构建期和运行期均启用登录，不要设置 `PILOTDECK_DISABLE_LOCAL_AUTH=1`。KM 启动幂等创建 profile 指定的 space，健康检查不调用宿主模型，避免启动循环。

## 4. 验证

```bash
docker compose -p pilotdeck-km-sop exec -T knowledge-runtime \
  python -c "from urllib.request import urlopen; print(urlopen('http://127.0.0.1:8787/health/ready').read().decode())"
docker compose -p pilotdeck-km-sop exec -T sop-runtime \
  python -c "from urllib.request import urlopen; print(urlopen('http://127.0.0.1:8091/healthz').read().decode())"
curl --fail http://127.0.0.1:3314/health
```

使用登录 JWT 访问 `/api/modules/runtime`，检查 KM 为 `knowledge-core/v1`，SOP 为 `sop.lifecycle/v3`，Gateway ready 且无 unavailable slot。新版 KM 配置接口为 `/api/km/config`，不使用旧 `/module-manifest`。

1. 在 Knowledge 页面创建知识库、导入 Markdown，等待 job 成功。
2. 使用真实模型查询文档，确认 capability 回调成功，解析返回 citation。
3. 创建并发布含 `pilotdeck:owner` handoff 的 SOP，在聊天执行 `/sop <skill_id>`。
4. 等待 handoff，owner 回复并恢复，确认 completed；重试同一请求应返回 duplicate，不能再次投递。
5. 重启、重建容器后检查两份数据库、citation、SOP 状态和会话。
6. 检查桌面与移动端登录、Knowledge、SOP 页面和前端模块一致性。

分别记录镜像构建、真实模型、浏览器、重试与持久化结果。健康和 Compose config 通过不代表业务验收，更不代表生产域名、历史迁移或外部 StaffDeck 服务验收。

## 5. 镜像与外部服务模式

Knowledge 可配置已有镜像，无需 `--knowledge-root`：

```yaml
deployment:
  mode: image
  image: registry.example.com/knowledge-core:compatible-release
```

镜像须包含 `knowledge_core.cli`、Python、依赖及 UI，支持生成的身份、capability 与配置参数。外部服务模式也无需源码：

```yaml
endpoint: https://km.example.com
deployment:
  mode: external
```

外部模式移除 `localRuntime`，不生成相应服务和卷。SOP 同样支持独立外部 endpoint。外部 KM 的租户、space、bearer 必须匹配 profile，并单独配置从 KM 可达的宿主 capability URL；容器 DNS `pilotdeck` 仅适用于同一 Compose 网络。外部 SOP 的发布 token 须匹配 runtime。

这些模式需要兼容 release、网络与认证的单独验收；不能直接使用旧 StaffDeck backend URL 替代 Knowledge Core。

## 6. 数据、升级与回滚

KM 数据库为 `knowledge-core-data:/data/knowledge.sqlite`，SOP 为 `sop-runtime-data:/data/sop-runtime.sqlite`；`pilotdeck-home` 保存账号、会话和宿主状态。部署方负责三份数据、profile、`.env` 和 release 的备份。禁止在持久化部署执行 `down -v`。

升级前停止写入并备份整个卷，保留 SQLite WAL 等关联文件：

```bash
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

升级导出到新目录，保持 Compose project 名不变以复用卷；更改 project 名会创建另一组空卷。回滚同时回退 PilotDeck profile/前端与 KM/SOP runtime；若数据库结构改变，先停服务，恢复与旧 release 配套的三份备份。不要用旧镜像盲目打开不兼容数据库。

## 7. 排障与旧协议

- 镜像源：新版支持 `KM_PYTHON_BASE_IMAGE`、`KM_NODE_BASE_IMAGE`、`SOP_PYTHON_BASE_IMAGE` 环境配置；宿主用 `docker compose build --build-arg NODE_BUILDER_IMAGE=<mirror> --build-arg NODE_RUNTIME_IMAGE=<mirror>`。
- pip/npm 失败：检查包源与 Docker 构建代理。宿主 loopback 代理在容器中可能不可达，可按环境覆盖 proxy build args。
- KM unhealthy：检查 `docker compose logs knowledge-runtime` 的配置、认证和初始 space 创建；检查本身不依赖模型。
- 模型回调失败：检查宿主模型 key/ID、capability token、用户 ID 与 space；healthy 不代表模型可用。
- profile mismatch：核对运行期 `config/pilotdeck.yaml` 与构建期 `profiles/exported.yaml`，重新导出及构建。
- SOP token 或功能开关修改后须重新创建容器，再验证发布与审批。
- 旧 `native-five-staffdeck.yaml`、`portable-sop-v3.yaml` 仍支持原 `--staffdeck-root`。旧 Knowledge 使用 `STAFFDECK_APP_SECRET`、`STAFFDECK_PYTHON_BASE_IMAGE`、`staffdeck-knowledge-data`，与新版卷和协议不同；本方案不迁移历史生产数据。

## 8. 源码部署（无 Docker）

源码模式使用同一新版 profile，但 endpoint 改为 loopback，KM/SOP 由本地启动器管理为独立 Python 进程。不要直接使用 Compose DNS。需要 Python 3.11+；本次验证使用 Python 3.12、Node 22.23.1、pnpm 10.32.1。

在独立 checkout 安装宿主依赖，在独立 KM 源码中构建 UI：

```bash
# PilotDeck 根目录
pnpm install --frozen-lockfile
export PILOT_HOME=/absolute/path/to/source-deployment/home
export PILOTDECK_CONFIG_PATH="$PILOT_HOME/pilotdeck.yaml"
export PILOTDECK_DISABLE_LOCAL_AUTH=0
export HOST=127.0.0.1 SERVER_PORT=3315
export PILOTDECK_GATEWAY_PORT=18815
export PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18815/ws
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
mkdir -p "$PILOT_HOME"
cp products/pilotdeck-staffdeck-sop/profiles/native-five-independent.yaml "$PILOTDECK_CONFIG_PATH"
# 在独立 knowledge_core/ui 目录执行
npm ci
npm run build
```

先编辑复制的 profile：填入实际模型 ID/URL 与运行时 key 引用，暂时删除整个 `modules.knowledge`，保留 native 五槽；SOP 保留 `hostAdapter`、协议与 `defaultSopId`，将 endpoint 和 localRuntime 设置为：

```yaml
endpoint: http://127.0.0.1:18915
localRuntime:
  enabled: true
  python: /absolute/path/to/python3.12
  knowledgeEnabled: true
  versionManagementEnabled: true
```

回到 PilotDeck 根目录准备 KM。该命令从源码安装独立包、检查已构建 UI、创建 local space，并写回 KM binding，尚不启动 Web：

```bash
pnpm start:local --prepare-only \
  --km-package /absolute/path/to/knowledge_core \
  --python /absolute/path/to/python3.12 \
  --data-directory /absolute/path/to/source-deployment/km \
  --port 18895 --user-id 1
```

准备器默认生成关闭认证的 loopback KM，且不自动配置宿主模型回调。若使用本次验收的认证与 capability 方式，启动前完成以下配置，所有路径必须为绝对路径：

- 在生成的 knowledge binding 增加 `namespace: local`、`credentialEnv: PILOTDECK_KM_SERVICE_TOKEN`、`capabilitiesCredentialEnv: PILOTDECK_KM_CAPABILITY_TOKEN`。
- 在 `localRuntime` 增加 `identityFile`、`capabilitiesFile`，指向下列两个 JSON 文件；其 `python`、`dataDirectory`、`configFile` 保留准备器生成值。
- 将 `configFile` 内容设为 `{"preset":"full","modules":{"authentication":true,"publication":false}}`。
- 身份文件示例：`{"replace-with-km-service-bearer":{"id":"pilotdeck","tenant_id":"local","spaces":["local"],"permissions":["read","write"]}}`。替换 key 为实际 service token，文件权限设为 600。
- Capability 文件示例：`[{"tenant_id":"local","space_id":"local","endpoint":"http://127.0.0.1:3315/api/internal/km/capabilities","credential_env":"PILOTDECK_KM_CAPABILITY_TOKEN"}]`。
- 向启动环境注入不同的 `PILOTDECK_KM_SERVICE_TOKEN`、`PILOTDECK_KM_CAPABILITY_TOKEN`、`SOP_RUNTIME_PUBLISH_TOKEN` 及宿主模型 key。KM 不配置 `modelConfig`，模型与解析通过宿主 capability 使用。

配置环境变量时保留凭据原值；读取 dotenv 应使用支持 dotenv 的解析器，不能把文件中的包裹引号当作 key 的一部分。不要将实际凭据提交到仓库。

使用相同 profile 完整构建并启动：

```bash
pnpm build:web
NODE_ENV=production node ui/server/webRuntimeSupervisor.js start-built
```

首次启动会在 `$PILOT_HOME/sop-runtime/venv` 安装本仓库 SOP package。打开 `http://127.0.0.1:3315` 注册/登录，然后按第 4 节验证导入、真实模型/citation、发布、owner handoff/resume 与去重。源码健康地址为 `http://127.0.0.1:18895/health/ready`、`http://127.0.0.1:18915/healthz`。

向 supervisor 发送 SIGTERM 后应等待四个服务端口全部退出，再用相同环境启动。不要只停止 Web 后留下 Python 进程。KM 数据位于配置的 `dataDirectory/knowledge.sqlite`，SOP 位于 `$PILOT_HOME/sop-runtime/runtime.sqlite`；停写并备份整个 KM 数据目录及 `PILOT_HOME`，包含数据库 WAL、身份文件、profile 与会话。源码准备器用 pip 解析依赖，本次未验证离线或冻结依赖安装；需要冻结依赖时应另行使用 KM 的 `uv.lock` 安装流程。
