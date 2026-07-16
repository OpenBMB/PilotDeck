# PilotDeck Docker 部署

PilotDeck 在容器内由两个协作的 Node.js 进程组成：

- **Gateway**：智能体运行时，监听 `PILOTDECK_GATEWAY_PORT`（默认 `18789`）
- **UI Server**：Web 前端 + REST/WebSocket 适配层，监听 `SERVER_PORT`（默认 `3001`）

Docker Compose 会持久化完整的 `PILOT_HOME` 目录，包括自动生成的配置、认证数据库、权限、会话/项目、记忆、技能/插件和路由统计数据。

English version: [README_DOCKER.md](./README_DOCKER.md)

## Docker Compose 快速开始

### 前置条件

- [Docker](https://docs.docker.com/get-docker/) v20+
- [Docker Compose](https://docs.docker.com/compose/) v2+

启动 PilotDeck 前，请确认 Docker daemon 正在运行。macOS/Windows 用户需要先启动 Docker Desktop，并等待 engine ready：

```bash
docker info
```

首次构建会从 Docker Hub 拉取 `node:22-bookworm` 和 `node:22-bookworm-slim` 等基础镜像。如果拉取镜像很慢，或出现 `context deadline exceeded`，请配置 Docker registry mirror 或 Docker Desktop proxy 后重试 `docker compose up -d --build`。Docker Desktop 可在 **Settings → Docker Engine** 中配置 registry mirrors；Linux 可在 `/etc/docker/daemon.json` 中添加 mirror，然后重启 Docker。

容器会在镜像内使用 Node.js 22 和仓库提交的 `pnpm-lock.yaml` 安装依赖，因此不会使用宿主机 Node.js 运行时，也不会受宿主机 CPU 架构影响。PilotDeck 不需要旧的 `sqlite`/`sqlite3` 包，它们不属于源码安装路径。

如果只是临时处理 Docker Hub 连接不稳定问题，可以先从可访问的镜像源拉取所需 Node 镜像，并打成本仓库 Dockerfile 使用的名称：

```bash
docker pull mirror.gcr.io/library/node:22-bookworm
docker pull mirror.gcr.io/library/node:22-bookworm-slim
docker tag mirror.gcr.io/library/node:22-bookworm node:22-bookworm
docker tag mirror.gcr.io/library/node:22-bookworm-slim node:22-bookworm-slim
```

Docker 构建过程中还会在镜像内下载 Debian 和 npm 软件包，因此包 registry 很慢时仍可能需要稳定网络代理。

### 方式 A：通过环境变量配置

在 `docker-compose.yml` 或 `.env` 文件中设置模型 Provider 变量：

```env
PILOTDECK_MODEL=openai/gpt-4.1
PILOTDECK_API_KEY=sk-your-api-key
PILOTDECK_API_URL=https://api.openai.com/v1
```

然后启动：

```bash
docker compose up -d --build
```

如果 `pilotdeck-home` volume 中还没有 `/root/.pilotdeck/pilotdeck.yaml`，entrypoint 会在首次启动时根据 `PILOTDECK_*` 环境变量生成配置。

### 方式 B：通过 YAML 文件配置

先创建宿主机配置文件：

```bash
mkdir -p ~/.pilotdeck
cat > ~/.pilotdeck/pilotdeck.yaml <<'YAML'
schemaVersion: 1
agent:
  model: openai/gpt-4.1
model:
  providers:
    openai:
      protocol: openai
      url: https://api.openai.com/v1
      apiKey: sk-your-api-key
      models:
        gpt-4.1: {}
YAML
```

然后取消 `docker-compose.yml` 中配置文件 bind mount 的注释：

```yaml
volumes:
  - pilotdeck-home:/root/.pilotdeck
  - ${PILOTDECK_CONFIG:-${HOME}/.pilotdeck/pilotdeck.yaml}:/root/.pilotdeck/pilotdeck.yaml:ro
```

启动服务：

```bash
docker compose up -d --build
```

UI 地址：**http://localhost:3001**。

## Workspace 挂载

智能体运行在容器内。如果希望它们访问宿主机项目，请取消 `/workspace` bind mount 的注释：

```yaml
volumes:
  - pilotdeck-home:/root/.pilotdeck
  - ${PILOTDECK_WORKSPACE:-${PWD}}:/workspace
```

运行 `docker compose up` 前，也可以设置 `PILOTDECK_WORKSPACE=/path/to/project`。

## 手动 Docker Build & Run

### 构建镜像

```bash
docker build -t pilotdeck:latest .
```

### 使用环境变量运行

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  pilotdeck:latest
```

### 使用配置文件运行

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -v ~/.pilotdeck/pilotdeck.yaml:/root/.pilotdeck/pilotdeck.yaml:ro \
  pilotdeck:latest
```

### 挂载工作区运行

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -v "$PWD":/workspace \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  pilotdeck:latest
```

### 使用代理运行

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  -e PILOTDECK_PROXY=http://host.docker.internal:7890 \
  pilotdeck:latest
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PILOT_HOME` | 容器内 PilotDeck 状态目录 | `/root/.pilotdeck` |
| `PILOTDECK_MODEL` | 主模型标识，格式为 `provider/model` | `openrouter/deepseek/deepseek-v4-flash` |
| `PILOTDECK_LIGHT_MODEL` | 路由/判别用轻量模型标识 | `openrouter/qwen/qwen3-8b` |
| `PILOTDECK_API_KEY` | 主模型 Provider API Key | `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE` |
| `PILOTDECK_API_URL` | 主模型 Provider API Base URL | `https://openrouter.ai/api/v1` |
| `PILOTDECK_LIGHT_API_KEY` | 轻量模型使用不同 Provider 时的 API Key | 回退到 `PILOTDECK_API_KEY` |
| `PILOTDECK_LIGHT_API_URL` | 轻量模型使用不同 Provider 时的 API Base URL | 回退到 `PILOTDECK_API_URL` |
| `PILOTDECK_PROXY` | HTTP/HTTPS 代理 URL | — |
| `SERVER_PORT` | UI server 端口 | `3001` |
| `PILOTDECK_GATEWAY_PORT` | UI bridge 使用的 Gateway 端口 | `18789` |

## 架构

```text
Browser (localhost:3001) ──► UI Server (port 3001) ──► Gateway (port 18789)
```

两个进程由容器内的 entrypoint 管理。

## 开发模式

```bash
npm install
npm run dev
```

这会以热更新模式启动 Gateway 和 UI dev server。
