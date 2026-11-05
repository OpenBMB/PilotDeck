#!/bin/sh
set -eu
cd /Users/a1/Documents/ChatGPT/pilotdeck-mint-integration
export PILOTDECK_DISABLE_LOCAL_AUTH=1
export PILOTDECK_RUNTIME_BACKEND=mint
export PILOTDECK_MINT_COMMAND=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/utf8-unified/launch.py
export PILOTDECK_MINT_PROJECT=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/utf8-registry-project
export PILOTDECK_MINT_STATE_DIR=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/utf8-unified/web-acp-map
export PILOTDECK_MINT_STRUCTURED_INPUT=1
export PILOTDECK_MINT_MODEL=mint-minicpm5:2.6b-q4_k_m
export PILOT_HOME=/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime/.pilotdeck
export HOST=127.0.0.1 SERVER_PORT=3101 PORT=3101
exec node --import tsx ui/server/index.js
