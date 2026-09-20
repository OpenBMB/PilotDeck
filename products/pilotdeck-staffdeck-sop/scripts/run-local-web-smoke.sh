#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PILOTDECK_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
STAFFDECK_ROOT="${STAFFDECK_SOP_RUNTIME_CONTEXT:-$PILOTDECK_ROOT/../StaffDeck-portable-sop}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pilotdeck-staffdeck-web.XXXXXX")"
WEB_PORT="${PILOTDECK_WEB_SMOKE_PORT:-13001}"
GATEWAY_PORT="${PILOTDECK_WEB_SMOKE_GATEWAY_PORT:-18790}"
SOP_PORT="${PILOTDECK_WEB_SMOKE_SOP_PORT:-18091}"
MODEL_PORT="${PILOTDECK_WEB_SMOKE_MODEL_PORT:-18092}"
SOP_ENABLED="${PILOTDECK_WEB_SMOKE_SOP_ENABLED:-true}"

cleanup() {
  for pid in $(jobs -p); do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT INT TERM

if [ ! -d "$STAFFDECK_ROOT/portable_sop" ]; then
  echo "StaffDeck portable_sop checkout not found: $STAFFDECK_ROOT" >&2
  exit 2
fi

if [ "$SOP_ENABLED" = "true" ]; then
  SOP_CONFIG="modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: http://127.0.0.1:$SOP_PORT
    definitionsPath: $RUNTIME_DIR/onboarding.yaml
    defaultSopId: browser_smoke"
else
  SOP_CONFIG="modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop: { enabled: false, provider: staffdeck }"
fi

"$PYTHON_BIN" -m venv "$RUNTIME_DIR/venv"
"$RUNTIME_DIR/venv/bin/pip" install --quiet "$STAFFDECK_ROOT/backend"
cat >"$RUNTIME_DIR/onboarding.yaml" <<'YAML'
sops:
  - id: browser_smoke
    version: "1"
    name: Browser SOP smoke
    content:
      start_node_id: begin
      nodes:
        - node_id: begin
          instruction: Read browser-smoke-input.txt before completing this step.
          allowed_actions: ["call_tool:read_file"]
        - node_id: approval
          type: handoff
          instruction: Wait for browser operator approval.
      edges:
        - source_node_id: begin
          next_node_id: approval
      terminal_node_ids: [approval]
YAML
printf '%s\n' 'browser business tool succeeded' >"$RUNTIME_DIR/browser-smoke-input.txt"
cat >"$RUNTIME_DIR/pilotdeck.yaml" <<YAML
schemaVersion: 1
agent:
  model: smoke/smoke
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    smoke:
      protocol: openai
      url: http://127.0.0.1:$MODEL_PORT
      apiKey: local-only
      models:
        smoke:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
$SOP_CONFIG
YAML

if [ "$SOP_ENABLED" = "true" ]; then
  PYTHONPATH="$STAFFDECK_ROOT/backend:$STAFFDECK_ROOT/backend/src:$STAFFDECK_ROOT/portable_sop/src" \
    "$RUNTIME_DIR/venv/bin/python" -m uvicorn staffdeck_sop_runtime.api:app --host 127.0.0.1 --port "$SOP_PORT" >"$RUNTIME_DIR/sop.log" 2>&1 &
fi
BROWSER_SMOKE_INPUT_PATH="$RUNTIME_DIR/browser-smoke-input.txt" \
LOCAL_OPENAI_MOCK_SOP_ENABLED="$SOP_ENABLED" \
LOCAL_OPENAI_MOCK_PORT="$MODEL_PORT" node "$SCRIPT_DIR/local-openai-mock.mjs" >"$RUNTIME_DIR/model.log" 2>&1 &
if [ "$SOP_ENABLED" = "true" ]; then
  for _ in $(seq 1 50); do
    if curl --fail --silent "http://127.0.0.1:$SOP_PORT/healthz" >/dev/null; then break; fi
    sleep 0.1
  done
fi
cd "$PILOTDECK_ROOT"
PILOT_HOME="$RUNTIME_DIR" \
SERVER_PORT="$WEB_PORT" \
PILOTDECK_GATEWAY_PORT="$GATEWAY_PORT" \
PILOTDECK_GATEWAY_URL="ws://127.0.0.1:$GATEWAY_PORT/ws" \
node ui/server/webRuntimeSupervisor.js start-built
