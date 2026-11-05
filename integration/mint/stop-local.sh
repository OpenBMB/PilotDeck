#!/bin/sh
set -eu
RUNTIME=${PILOTDECK_TEST_RUNTIME:-/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime}
for service in server vite; do
 file="$RUNTIME/pids/$service.pid"
 if [ -f "$file" ]; then kill "$(cat "$file")" 2>/dev/null || true; rm "$file"; fi
done
