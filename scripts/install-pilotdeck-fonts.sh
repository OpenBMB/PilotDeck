#!/usr/bin/env bash
# Install staged PilotDeck font files on the deployment server.
#
# This script is designed for root on /data/PilotDeck. It copies only .ttf
# files, rejects accidental replacement of a different file by default, and
# writes PILOTDECK_FONTS_DIR to .env without exposing other .env values.

set -euo pipefail

PROJECT_DIR="/data/PilotDeck"
FONT_DIR="/data/pilotdeck-assets/fonts/founder"
SOURCE_DIR=""
REPLACE_EXISTING=0
DEPLOY_AFTER_INSTALL=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-pilotdeck-fonts.sh --source DIR [options]

Required:
  --source DIR        Remote staging directory containing .ttf font files.

Options:
  --project-dir DIR   PilotDeck deployment directory. Default: /data/PilotDeck
  --font-dir DIR      Persistent server font directory.
                       Default: /data/pilotdeck-assets/fonts/founder
  --replace           Allow replacing an existing target font only when its
                       SHA-256 differs. Without this flag, that situation
                       stops the script safely.
  --deploy            After installation, validate the Compose font mount,
                       rebuild and recreate only the pilotdeck service, then
                       verify the mount and fontconfig parsing. This interrupts
                       running PilotDeck tasks.
  -h, --help           Show this help.

The script never removes old fonts or the staging directory. Review and clean
those manually only after deployment verification succeeds.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "neither sha256sum nor shasum is available."
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || fail "--source needs a directory."
      SOURCE_DIR="$2"
      shift 2
      ;;
    --project-dir)
      [ "$#" -ge 2 ] || fail "--project-dir needs a directory."
      PROJECT_DIR="$2"
      shift 2
      ;;
    --font-dir)
      [ "$#" -ge 2 ] || fail "--font-dir needs a directory."
      FONT_DIR="$2"
      shift 2
      ;;
    --replace)
      REPLACE_EXISTING=1
      shift
      ;;
    --deploy)
      DEPLOY_AFTER_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run this script as root (for example: sudo bash ...)."
[ -n "$SOURCE_DIR" ] || fail "--source is required."
[ -d "$SOURCE_DIR" ] || fail "font source directory does not exist: $SOURCE_DIR"
[ -d "$PROJECT_DIR" ] || fail "PilotDeck deployment directory does not exist: $PROJECT_DIR"

shopt -s nullglob
font_files=("$SOURCE_DIR"/*.ttf "$SOURCE_DIR"/*.TTF)
shopt -u nullglob
[ "${#font_files[@]}" -gt 0 ] || fail "no .ttf files found in: $SOURCE_DIR"

install -d -o root -g root -m 0755 "$FONT_DIR"

echo "[fonts] Installing into: $FONT_DIR"
for source_file in "${font_files[@]}"; do
  [ -s "$source_file" ] || fail "font file is empty or unreadable: $source_file"
  target_file="$FONT_DIR/$(basename "$source_file")"

  if [ -f "$target_file" ]; then
    source_hash="$(sha256_of "$source_file")"
    target_hash="$(sha256_of "$target_file")"
    if [ "$source_hash" = "$target_hash" ]; then
      echo "[fonts] Unchanged: $(basename "$source_file")"
      continue
    fi
    [ "$REPLACE_EXISTING" -eq 1 ] || fail \
      "target differs and was not changed: $target_file (review it, then rerun with --replace if intended)"
  fi

  install -o root -g root -m 0644 "$source_file" "$target_file"
  echo "[fonts] Installed: $(basename "$source_file")"
done

echo "[fonts] Installed font checksums:"
for installed_file in "$FONT_DIR"/*.ttf "$FONT_DIR"/*.TTF; do
  [ -f "$installed_file" ] || continue
  printf '  %s  %s\n' "$(sha256_of "$installed_file")" "$(basename "$installed_file")"
done

ENV_FILE="$PROJECT_DIR/.env"
EXPECTED_ENV="PILOTDECK_FONTS_DIR=$FONT_DIR"
if [ ! -e "$ENV_FILE" ]; then
  install -o root -g root -m 0600 /dev/null "$ENV_FILE"
fi

existing_env="$(grep -E '^PILOTDECK_FONTS_DIR=' "$ENV_FILE" || true)"
if [ -z "$existing_env" ]; then
  printf '\n%s\n' "$EXPECTED_ENV" >> "$ENV_FILE"
  echo "[fonts] Added PILOTDECK_FONTS_DIR to $ENV_FILE"
elif [ "$existing_env" = "$EXPECTED_ENV" ]; then
  echo "[fonts] PILOTDECK_FONTS_DIR is already correct in $ENV_FILE"
else
  fail "existing PILOTDECK_FONTS_DIR differs: $existing_env (edit $ENV_FILE deliberately; the script will not overwrite it)"
fi

if [ "$DEPLOY_AFTER_INSTALL" -eq 0 ]; then
  cat <<EOF
[fonts] Server asset setup is complete. The service was not restarted.
[fonts] After the GitLab deployment code includes the read-only font mount, run:
  bash scripts/install-pilotdeck-fonts.sh --source '$SOURCE_DIR' --deploy
EOF
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker is unavailable."
cd "$PROJECT_DIR"

echo "[fonts] Validating Compose configuration ..."
docker compose config --quiet
rendered_compose="$(docker compose config)"
printf '%s' "$rendered_compose" | grep -Fq '/usr/local/share/fonts/founder' || fail \
  "Compose does not contain the font mount yet. Deploy the GitLab code change first."

echo "[fonts] Rebuilding and recreating PilotDeck. Running tasks will be interrupted."
docker compose up -d --build --force-recreate pilotdeck

container_id="$(docker compose ps -q pilotdeck)"
[ -n "$container_id" ] || fail "PilotDeck container was not created."
mount_report="$(docker inspect "$container_id" --format '{{range .Mounts}}{{println .Source "->" .Destination "rw=" .RW}}{{end}}')"
printf '%s\n' "$mount_report"
printf '%s' "$mount_report" | grep -Fq "$FONT_DIR -> /usr/local/share/fonts/founder rw=false" || fail \
  "font mount is missing or is not read-only."

echo "[fonts] Checking fontconfig parsing in the running container ..."
docker compose exec -T pilotdeck sh -lc '
  set -eu
  for font_file in /usr/local/share/fonts/founder/*.ttf /usr/local/share/fonts/founder/*.TTF; do
    test -r "$font_file"
    printf "%s: " "$(basename "$font_file")"
    fc-scan --format "%{family}\n" "$font_file"
  done
'

echo "[fonts] Deployment and font verification completed."
