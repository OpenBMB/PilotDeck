#!/usr/bin/env bash
set -euo pipefail

# PilotDeck self-update script.
# Pulls latest code, rebuilds, and signals the parent process to restart.
#
# Usage:
#   scripts/update.sh [--restart]
#
# Exit codes:
#   0 = update successful (caller should restart services)
#   1 = error during update
#   2 = already up-to-date (no changes pulled)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

log()  { printf "${GREEN}[update]${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}[update]${RESET} %s\n" "$1"; }
fail() { printf "${RED}[update]${RESET} %s\n" "$1" >&2; exit 1; }

DO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --restart) DO_RESTART=1 ;;
  esac
done

cd "$PROJECT_ROOT"

if [[ ! -d ".git" ]]; then
  fail "Not a git repository. Cannot update."
fi

CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo "unknown")"
log "Current branch: $CURRENT_BRANCH"

log "Fetching latest changes..."
git fetch origin "$CURRENT_BRANCH" 2>&1

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")"

if [[ -z "$REMOTE_HEAD" ]]; then
  fail "Cannot determine remote HEAD for branch $CURRENT_BRANCH"
fi

if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
  log "Already up-to-date (${LOCAL_HEAD:0:8})"
  exit 2
fi

log "Updating from ${LOCAL_HEAD:0:8} to ${REMOTE_HEAD:0:8}..."

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  warn "Working directory has uncommitted changes. Stashing..."
  git stash push -m "pilotdeck-auto-update-$(date +%Y%m%d-%H%M%S)" 2>&1
fi

git pull --ff-only origin "$CURRENT_BRANCH" 2>&1 || {
  warn "Fast-forward pull failed, attempting reset..."
  git reset --hard "origin/$CURRENT_BRANCH" 2>&1
}

log "Installing dependencies..."
if command -v pnpm >/dev/null 2>&1; then
  HUSKY=0 pnpm install --frozen-lockfile 2>&1 || HUSKY=0 pnpm install 2>&1
else
  HUSKY=0 npm install --no-audit --no-fund 2>&1
fi

log "Building gateway (TypeScript)..."
npm run build 2>&1

log "Building UI frontend..."
cd ui
npm run build 2>&1
cd "$PROJECT_ROOT"

NEW_HEAD="$(git rev-parse HEAD)"
log "Update complete: ${NEW_HEAD:0:8}"

COMMIT_MSG="$(git log --oneline -1 HEAD)"
log "Latest commit: $COMMIT_MSG"

if [[ "$DO_RESTART" -eq 1 ]]; then
  log "Restarting PilotDeck..."
  if [[ -n "${PILOTDECK_PID:-}" ]] && kill -0 "$PILOTDECK_PID" 2>/dev/null; then
    kill -SIGUSR2 "$PILOTDECK_PID" 2>/dev/null || true
  fi
fi

exit 0
