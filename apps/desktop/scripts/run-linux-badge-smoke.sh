#!/usr/bin/env bash
set -euo pipefail

# A window manager is needed to exercise native focus, not just X11 rendering.
script_dir="$(cd "$(dirname "$0")" && pwd)"
dbus-run-session -- xvfb-run -a bash -c '
  openbox > /tmp/pilotdeck-notification-window-manager.log 2>&1 &
  notification_wm_pid=$!
  trap "kill $notification_wm_pid 2>/dev/null || true" EXIT
  node "$1/verify-desktop-lifecycle.cjs" notification-badge
' _ "$script_dir"
