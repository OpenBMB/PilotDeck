# PilotDeck Docker

简体中文版本：[README_DOCKER.zh.md](./README_DOCKER.zh.md)

PilotDeck runs as two cooperating Node.js processes in the container:

- **Gateway**: agent runtime on `PILOTDECK_GATEWAY_PORT` (default `18789`)
- **UI Server**: web frontend + REST/WebSocket adapter on `SERVER_PORT` (default `3001`)

The Docker Compose setup persists the full `PILOT_HOME` directory, including generated config, auth DB, permissions, sessions/projects, memory, skills/plugins, and router stats.

## Quick Start with Docker Compose

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) v20+
- [Docker Compose](https://docs.docker.com/compose/) v2+

Make sure the Docker daemon is running before starting PilotDeck. On macOS/Windows, start Docker Desktop first and wait until the engine is ready:

```bash
docker info
```

The first build pulls base images such as `node:22-bookworm` and `node:22-bookworm-slim` from Docker Hub. If pulling images is slow or fails with `context deadline exceeded`, configure a Docker registry mirror or Docker Desktop proxy, then retry `docker compose up -d --build`. On Docker Desktop, registry mirrors can be configured in **Settings → Docker Engine**. On Linux, add mirrors to `/etc/docker/daemon.json`, then restart Docker.

The container installs dependencies with Node.js 22 and the committed `pnpm-lock.yaml` inside the image, so it does not use the host Node.js runtime or host CPU architecture for native Node modules. The legacy `sqlite`/`sqlite3` packages are not required by PilotDeck and are not part of the source install path.

As a one-off workaround, you can pre-pull the required Node images from a reachable mirror and tag them with the names used by the Dockerfile:

```bash
docker pull mirror.gcr.io/library/node:22-bookworm
docker pull mirror.gcr.io/library/node:22-bookworm-slim
docker tag mirror.gcr.io/library/node:22-bookworm node:22-bookworm
docker tag mirror.gcr.io/library/node:22-bookworm-slim node:22-bookworm-slim
```

The Docker build also downloads Debian and npm packages inside the image, so slow package registries may still require a stable network proxy.

### Option A: Configure via environment variables

Set the model provider variables in `docker-compose.yml` or an `.env` file:

```env
PILOTDECK_MODEL=openai/gpt-4.1
PILOTDECK_API_KEY=sk-your-api-key
PILOTDECK_API_URL=https://api.openai.com/v1
```

Then start:

```bash
docker compose up -d --build
```

If `/root/.pilotdeck/pilotdeck.yaml` does not exist in the `pilotdeck-home` volume, the entrypoint generates it from the `PILOTDECK_*` environment variables on first start.

### Option B: Configure via YAML file

Create the host config file first:

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

Then uncomment the config bind mount in `docker-compose.yml`:

```yaml
volumes:
  - pilotdeck-home:/root/.pilotdeck
  - ${PILOTDECK_CONFIG:-${HOME}/.pilotdeck/pilotdeck.yaml}:/root/.pilotdeck/pilotdeck.yaml:ro
```

Start the service:

```bash
docker compose up -d --build
```

The UI is available at **http://localhost:3001**.

## Workspace Mounts

Agents run inside the container. To let them access a host project, mount it into `/workspace` by uncommenting the workspace bind mount:

```yaml
volumes:
  - pilotdeck-home:/root/.pilotdeck
  - ${PILOTDECK_WORKSPACE:-${PWD}}:/workspace
```

You can set `PILOTDECK_WORKSPACE=/path/to/project` before running `docker compose up`.

## Manual Docker Build & Run

### Build the image

```bash
docker build -t pilotdeck:latest .
```

### Run with environment variables

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  pilotdeck:latest
```

### Run with a config file

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v pilotdeck-home:/root/.pilotdeck \
  -v ~/.pilotdeck/pilotdeck.yaml:/root/.pilotdeck/pilotdeck.yaml:ro \
  pilotdeck:latest
```

### Run with a workspace mount

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

### Run with a proxy

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

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PILOT_HOME` | PilotDeck state directory inside the container | `/root/.pilotdeck` |
| `PILOTDECK_MODEL` | Main model identifier, formatted as `provider/model` | `openrouter/deepseek/deepseek-v4-flash` |
| `PILOTDECK_LIGHT_MODEL` | Lightweight routing/judge model identifier | `openrouter/qwen/qwen3-8b` |
| `PILOTDECK_API_KEY` | API key for the main model provider | `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE` |
| `PILOTDECK_API_URL` | Base URL for the main model provider API | `https://openrouter.ai/api/v1` |
| `PILOTDECK_LIGHT_API_KEY` | API key for a different light-model provider | Falls back to `PILOTDECK_API_KEY` |
| `PILOTDECK_LIGHT_API_URL` | Base URL for a different light-model provider | Falls back to `PILOTDECK_API_URL` |
| `PILOTDECK_PROXY` | HTTP/HTTPS proxy URL | — |
| `SERVER_PORT` | UI server port | `3001` |
| `PILOTDECK_GATEWAY_PORT` | Gateway port used by the UI bridge | `18789` |

## Architecture

```text
Browser (localhost:3001) ──► UI Server (port 3001) ──► Gateway (port 18789)
```

Both processes are managed by `concurrently` inside the Docker container.

## Development

```bash
npm install
npm run dev
```

This starts the Gateway and UI dev server with hot reload.
