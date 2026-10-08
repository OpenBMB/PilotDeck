#!/usr/bin/env bash
set -euo pipefail

mode="${1:?Specify x11 or wayland}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
node_binary="${PILOTDECK_NODE_BINARY:-/opt/PilotDeck/resources/node/bin/node}"

if [[ "$mode" == x11 ]]; then
  exec dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' \
    "$node_binary" "$script_dir/verify-linux-boot.cjs" x11
fi

if [[ "$mode" != wayland ]]; then
  echo "Unsupported display mode: $mode" >&2
  exit 1
fi

runtime_dir="$(mktemp -d)"
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"
export WAYLAND_DISPLAY=wayland-pilotdeck-smoke
unset DISPLAY
weston_log="$runtime_dir/weston.log"
weston --backend=headless-backend.so --socket="$WAYLAND_DISPLAY" \
  --no-config --idle-time=0 --width=1440 --height=900 >"$weston_log" 2>&1 &
weston_pid=$!
cleanup() {
  kill "$weston_pid" 2>/dev/null || true
  wait "$weston_pid" 2>/dev/null || true
  rm -rf -- "$runtime_dir"
}
trap cleanup EXIT

for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -S "$runtime_dir/$WAYLAND_DISPLAY" ]]; then break; fi
  if ! kill -0 "$weston_pid" 2>/dev/null; then
    cat "$weston_log" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ ! -S "$runtime_dir/$WAYLAND_DISPLAY" ]]; then
  cat "$weston_log" >&2
  echo 'Weston did not create a Wayland socket' >&2
  exit 1
fi
dbus-run-session -- "$node_binary" "$script_dir/verify-linux-boot.cjs" wayland
