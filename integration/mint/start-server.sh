#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
: "${PILOTDECK_MINT_PROJECT:=/tmp/mint-pilotdeck-image-offload-20261105}"
: "${PILOTDECK_MINT_STATE_DIR:=$PILOTDECK_MINT_PROJECT/.pilotdeck-mint-state}"
: "${PILOTDECK_MINT_SIDECAR_BIN:=}"
export PILOTDECK_DISABLE_LOCAL_AUTH=1
export PILOTDECK_RUNTIME_BACKEND=mint
export PILOTDECK_MINT_COMMAND="$ROOT/integration/mint/runtime-launch.py"
export PILOTDECK_MINT_PROJECT PILOTDECK_MINT_STATE_DIR
export PILOTDECK_MINT_STRUCTURED_INPUT=1
export PILOTDECK_MINT_MODEL="${PILOTDECK_MINT_MODEL:-mint-minicpm5:2.6b-q4_k_m}"
export PILOT_HOME="${PILOT_HOME:-$PILOTDECK_MINT_PROJECT/.pilotdeck}"
export HOST="${HOST:-127.0.0.1}" SERVER_PORT="${SERVER_PORT:-3101}" PORT="${PORT:-3101}"
exec node --import tsx "$ROOT/ui/server/index.js"
