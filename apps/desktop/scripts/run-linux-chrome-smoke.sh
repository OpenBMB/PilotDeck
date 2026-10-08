#!/usr/bin/env bash
set -euo pipefail
node_binary="${PILOTDECK_CHROME_NODE_BINARY:-node}"

mode="${1:?Specify x11 or wayland}"
if [[ "$mode" != x11 && "$mode" != wayland ]]; then
  echo "Unsupported display mode: $mode" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo_root"
export PILOTDECK_CHROME_OZONE="$mode"
export PILOTDECK_CHROME_DISABLE_SANDBOX=1
export PILOTDECK_CHROME_ARTIFACTS="$repo_root/outputs/desktop-chrome-review/linux-$mode"
mkdir -p "$PILOTDECK_CHROME_ARTIFACTS"
if ! "$node_binary" -e "require('./apps/desktop/node_modules/electron')" >/dev/null 2>&1; then
  "$node_binary" apps/desktop/node_modules/electron/install.js
fi

(cd ui && exec "$node_binary" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5187 --strictPort) \
  >"${TMPDIR:-/tmp}/pilotdeck-chrome-vite-$mode.log" 2>&1 &
vite_pid=$!
runtime_dir=""
weston_pid=""
cleanup() {
  if [[ -n "$weston_pid" ]]; then
    kill "$weston_pid" 2>/dev/null || true
    wait "$weston_pid" 2>/dev/null || true
  fi
  kill "$vite_pid" 2>/dev/null || true
  wait "$vite_pid" 2>/dev/null || true
  if [[ -n "$runtime_dir" ]]; then rm -rf -- "$runtime_dir"; fi
}
trap cleanup EXIT

for ((attempt = 0; attempt < 200; attempt++)); do
  if curl --silent --fail http://127.0.0.1:5187/ >/dev/null; then break; fi
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    cat "${TMPDIR:-/tmp}/pilotdeck-chrome-vite-$mode.log" >&2
    exit 1
  fi
  sleep 0.1
done
curl --silent --fail http://127.0.0.1:5187/ >/dev/null

if [[ "$mode" == x11 ]]; then
  exec_mode=(dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24')
else
  runtime_dir="$(mktemp -d)"
  chmod 700 "$runtime_dir"
  export XDG_RUNTIME_DIR="$runtime_dir"
  export WAYLAND_DISPLAY=wayland-pilotdeck-chrome
  unset DISPLAY
  weston --backend=headless-backend.so --socket="$WAYLAND_DISPLAY" \
    --no-config --idle-time=0 --width=1440 --height=900 >"$runtime_dir/weston.log" 2>&1 &
  weston_pid=$!
  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ -S "$runtime_dir/$WAYLAND_DISPLAY" ]]; then break; fi
    if ! kill -0 "$weston_pid" 2>/dev/null; then
      cat "$runtime_dir/weston.log" >&2
      exit 1
    fi
    sleep 0.1
  done
  test -S "$runtime_dir/$WAYLAND_DISPLAY"
  exec_mode=(dbus-run-session --)
fi

"${exec_mode[@]}" "$node_binary" ui/e2e/desktop-chrome.smoke.mjs
