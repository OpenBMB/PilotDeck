#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
RUNTIME=${PILOTDECK_TEST_RUNTIME:-/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime}
mkdir -p "$RUNTIME/pids"
for service in server vite; do
 if [ -f "$RUNTIME/pids/$service.pid" ] && kill -0 "$(cat "$RUNTIME/pids/$service.pid")" 2>/dev/null; then
  echo "$service already running"; exit 1
 fi
done
nohup sh integration/mint/start-server.sh > "$RUNTIME/web-unified.log" 2>&1 &
echo $! > "$RUNTIME/pids/server.pid"
PILOTDECK_DISABLE_LOCAL_AUTH=1 SERVER_PORT=3101 nohup node ui/node_modules/vite/bin/vite.js ui --config ui/vite.config.js --host 127.0.0.1 --port 5273 --strictPort > "$RUNTIME/web-vite-noauth.log" 2>&1 &
echo $! > "$RUNTIME/pids/vite.pid"
echo 'http://127.0.0.1:5273/'
