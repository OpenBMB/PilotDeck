# PilotDeck

PilotDeck is an AI-powered coding agent with a web-based UI. It runs as two cooperating Node.js processes — a **Gateway** (agent runtime, port 18789) and a **UI Server** (web frontend + REST/WebSocket adapter, port 3001).

## Quick Start with Docker Compose

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+)
- [Docker Compose](https://docs.docker.com/compose/) (v2+)

### Option A: Configure via YAML file

Create a config file at `~/.pilotdeck/pilotdeck.yaml`:

```yaml
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
```

Then start:

```bash
docker compose up -d
```

The UI is available at **http://localhost:3001**.

### Option B: Configure via environment variables

If you don't have a YAML config file, set environment variables in `docker-compose.yml`:

```yaml
services:
  pilotdeck:
    build: .
    image: pilotdeck:latest
    ports:
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PILOTDECK_MODEL=openai/gpt-4.1
      - PILOTDECK_API_KEY=sk-your-api-key
      - PILOTDECK_API_URL=https://api.openai.com/v1
    restart: unless-stopped
```

The entrypoint will auto-generate `pilotdeck.yaml` from these env vars on first start.

## Manual Docker Build & Run

### Build the image

```bash
docker build -t pilotdeck:latest .
```

### Run with a config file

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -v ~/.pilotdeck/pilotdeck.yaml:/root/.pilotdeck/pilotdeck.yaml \
  pilotdeck:latest
```

### Run with environment variables (no config file needed)

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  pilotdeck:latest
```

### With proxy

```bash
docker run -d --name pilotdeck \
  -p 3001:3001 \
  -e PILOTDECK_MODEL=openai/gpt-4.1 \
  -e PILOTDECK_API_KEY=sk-your-api-key \
  -e PILOTDECK_API_URL=https://api.openai.com/v1 \
  -e PILOTDECK_PROXY=http://host.docker.internal:7890 \
  pilotdeck:latest
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PILOTDECK_MODEL` | Model identifier (e.g. `openai/gpt-4.1`) | `anthropic/claude-sonnet-4.6` |
| `PILOTDECK_API_KEY` | API key for the model provider | — |
| `PILOTDECK_API_URL` | Base URL for the model provider API | `https://api.anthropic.com` |
| `PILOTDECK_PROXY` | HTTP/HTTPS proxy URL | — |
| `SERVER_PORT` | UI server port | `3001` |

## Architecture

```
Browser (localhost:3001) ──► UI Server (port 3001) ──► Gateway (port 18789)
```

- **Gateway**: Agent runtime — manages sessions, tools, model calls
- **UI Server**: Web frontend (Vite-built SPA) + WebSocket/REST bridge to the Gateway

Both processes are managed by `concurrently` inside the Docker container.

## Development

```bash
npm install
npm run dev
```

This starts the Gateway and UI dev server with hot-reload.
