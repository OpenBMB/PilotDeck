#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PILOTDECK_ROOT="$(cd -- "$PRODUCT_DIR/../.." && pwd)"
STAFFDECK_ROOT="${STAFFDECK_SOP_RUNTIME_CONTEXT:-$PILOTDECK_ROOT/../StaffDeck-portable-sop}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pilotdeck-staffdeck-sop.XXXXXX")"
SOP_PORT="${STAFFDECK_SOP_E2E_PORT:-18091}"
SOP_PID=""

cleanup() {
  if [ -n "$SOP_PID" ] && kill -0 "$SOP_PID" 2>/dev/null; then
    kill "$SOP_PID"
    wait "$SOP_PID" 2>/dev/null || true
  fi
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT INT TERM

if [ ! -d "$STAFFDECK_ROOT/portable_sop" ]; then
  echo "StaffDeck portable_sop checkout not found: $STAFFDECK_ROOT" >&2
  exit 2
fi

"$PYTHON_BIN" -m venv "$RUNTIME_DIR/venv"
"$RUNTIME_DIR/venv/bin/pip" install --quiet "$STAFFDECK_ROOT/backend"
PYTHONPATH="$STAFFDECK_ROOT/backend:$STAFFDECK_ROOT/backend/src:$STAFFDECK_ROOT/portable_sop/src" \
  "$RUNTIME_DIR/venv/bin/python" -m uvicorn staffdeck_sop_runtime.api:app \
  --host 127.0.0.1 --port "$SOP_PORT" >"$RUNTIME_DIR/sop.log" 2>&1 &
SOP_PID=$!

for _ in $(seq 1 50); do
  if curl --fail --silent "http://127.0.0.1:$SOP_PORT/healthz" >/dev/null; then
    break
  fi
  sleep 0.1
done
curl --fail --silent "http://127.0.0.1:$SOP_PORT/healthz" >/dev/null

echo "Running Gateway -> StaffDeck SOP HTTP E2E on http://127.0.0.1:$SOP_PORT"
cd "$PILOTDECK_ROOT"
npm run test:sop:core
STAFFDECK_SOP_E2E_ENDPOINT="http://127.0.0.1:$SOP_PORT" npm run test:sop:http-e2e
STAFFDECK_SOP_E2E_ENDPOINT="http://127.0.0.1:$SOP_PORT" node "$SCRIPT_DIR/run-process-restart-smoke.mjs"

if [ "${PILOTDECK_RUN_REAL_MODEL_SMOKE:-0}" = "1" ]; then
  REAL_MODEL_SOURCE_PILOT_HOME="${REAL_MODEL_SOURCE_PILOT_HOME:-/Users/a1/.pilotdeck}" \
    STAFFDECK_SOP_SMOKE_ENDPOINT="http://127.0.0.1:$SOP_PORT" \
    node "$SCRIPT_DIR/run-real-model-smoke.mjs"
fi
