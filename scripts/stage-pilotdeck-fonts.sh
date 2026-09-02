#!/usr/bin/env bash
# Upload PilotDeck font assets from this Mac to the configured Beijing server.
#
# This script intentionally uploads only to the SSH user's private staging
# directory.  It never needs root access and never touches /data directly.
# Run the companion install-pilotdeck-fonts.sh from the server as root after
# this command succeeds.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR=""
SSH_TARGET="${PILOTDECK_SSH_TARGET:-bj-pilotdeck}"
REMOTE_STAGE_DIR=".pilotdeck-font-upload"
INSTALLER_SCRIPT="$PROJECT_ROOT/scripts/install-pilotdeck-fonts.sh"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/stage-pilotdeck-fonts.sh --source DIR [--target SSH_ALIAS]

Options:
  --source DIR       Required. Directory containing the authorized .ttf font
                       files outside this Git repository.
  --target SSH_ALIAS SSH host alias from ~/.ssh/config.
                       Default: bj-pilotdeck (or $PILOTDECK_SSH_TARGET).
  -h, --help         Show this help.

The script uploads fonts to ~/.pilotdeck-font-upload/ on the remote SSH
account. It does not change the running PilotDeck service.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || { echo "ERROR: --source needs a directory." >&2; exit 2; }
      SOURCE_DIR="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || { echo "ERROR: --target needs an SSH alias." >&2; exit 2; }
      SSH_TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in ssh scp shasum; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: required command is unavailable: $command_name" >&2
    exit 1
  }
done

[ -d "$SOURCE_DIR" ] || {
  if [ -z "$SOURCE_DIR" ]; then
    echo "ERROR: --source is required; fonts must remain outside this Git repository." >&2
  else
    echo "ERROR: font source directory does not exist: $SOURCE_DIR" >&2
  fi
  exit 1
}
[ -r "$INSTALLER_SCRIPT" ] || {
  echo "ERROR: server installer script is unreadable: $INSTALLER_SCRIPT" >&2
  exit 1
}

shopt -s nullglob
font_files=("$SOURCE_DIR"/*.ttf "$SOURCE_DIR"/*.TTF)
shopt -u nullglob

[ "${#font_files[@]}" -gt 0 ] || {
  echo "ERROR: no .ttf files found in: $SOURCE_DIR" >&2
  exit 1
}

echo "[fonts] Source directory: $SOURCE_DIR"
echo "[fonts] Files to upload:"
for font_file in "${font_files[@]}"; do
  [ -s "$font_file" ] || {
    echo "ERROR: font file is empty or unreadable: $font_file" >&2
    exit 1
  }
  printf '  - %s\n' "$(basename "$font_file")"
done

echo "[fonts] Source SHA-256:"
for font_file in "${font_files[@]}"; do
  shasum -a 256 "$font_file"
done | sort

echo "[fonts] Creating a private staging directory on $SSH_TARGET ..."
remote_stage_path="$(ssh "$SSH_TARGET" '
  set -eu
  stage="$HOME/.pilotdeck-font-upload"
  mkdir -p "$stage"
  chmod 700 "$stage"
  printf "%s" "$stage"
')"

echo "[fonts] Uploading over SSH ..."
scp -p "${font_files[@]}" "$INSTALLER_SCRIPT" "${SSH_TARGET}:~/${REMOTE_STAGE_DIR}/"

echo "[fonts] Upload complete. Server staging directory: $remote_stage_path"
echo "[fonts] Next, in the server root terminal run:"
echo "  bash '$remote_stage_path/install-pilotdeck-fonts.sh' --source '$remote_stage_path'"
