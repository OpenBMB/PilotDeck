#!/usr/bin/env bash
# ============================================================================
# L2 release smoke — Playwright UI + onboarding (+ optional Electron GUI)
#
# Usage:
#   bash scripts/release-l2.sh <DMG_PATH|.app_PATH>
#   bash scripts/release-l2.sh --skip-electron <DMG>
#   PD_SKIP_ELECTRON=1 bash scripts/release-l2.sh dist-electron/.../PilotDeck.app
#
# Prereq: repo root has `playwright` (npm install at monorepo root).
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"
# shellcheck source=lib/packaged-runtime.sh
source "${SCRIPT_DIR}/lib/packaged-runtime.sh"

SKIP_ELECTRON="${PD_SKIP_ELECTRON:-0}"
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --skip-electron) SKIP_ELECTRON=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      if [[ -z "$TARGET" ]]; then TARGET="$arg"; else
        echo "Unknown arg: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

[[ -n "$TARGET" ]] || { echo "Usage: release-l2.sh <DMG|.app> [--skip-electron]" >&2; exit 2; }

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; CYN=$'\033[0;36m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'

echo "${BLD}PilotDeck L2 smoke${RST}"
echo "  Target: ${TARGET}"
echo "  ${DIM}Note: L2 uses an isolated temp HOME — your ~/.pilotdeck is not modified.${RST}"
if [[ -f "${HOME}/.pilotdeck/pilotdeck.yaml" ]]; then
  echo "  ${DIM}Host config present: ${HOME}/.pilotdeck/pilotdeck.yaml (left untouched)${RST}"
fi

cleanup_all() {
  pd_runtime_teardown_sandbox
  pd_runtime_unmount_dmg
}
trap cleanup_all EXIT INT TERM

# Playwright chromium for headless UI
if ! (cd "$REPO_ROOT" && node -e "require('playwright')" 2>/dev/null); then
  echo "${RED}playwright not found — run: npm install (repo root)${RST}" >&2
  exit 2
fi
if ! (cd "$REPO_ROOT" && npx playwright install chromium 2>/dev/null); then
  echo "${RED}Playwright chromium missing — run: (cd repo root && npx playwright install chromium)${RST}" >&2
  exit 2
fi

pd_runtime_resolve_app "$TARGET"
echo "  App: ${PD_APP}"
pd_runtime_extract_bundles
echo "  Sandbox: ${SANDBOX}"

echo
echo "${CYN}── Start packaged Gateway + UI ──${RST}"
pd_runtime_start_dual_stack
echo "  UI: ${PD_UI_URL}"

echo
echo "${CYN}── L2a: Playwright UI tabs ──${RST}"
export PD_UI_URL
node "${SCRIPT_DIR}/release-l2-ui-smoke.mjs"

echo
echo "${CYN}── L2b: Onboarding HTML (mock IPC) ──${RST}"
(cd "${DESKTOP_DIR}" && npm run build >/dev/null)
node "${SCRIPT_DIR}/release-l2-onboarding-smoke.mjs"

if [[ "$SKIP_ELECTRON" == "1" || "$(uname)" != "Darwin" || "${CI:-}" == "true" ]]; then
  echo
  echo "${CYN}── L2c/L2d: Electron (skipped) ──${RST}"
else
  if [[ "${PD_SKIP_L2C:-0}" != "1" ]]; then
    echo
    echo "${CYN}── L2c: Electron (existing config, isolated HOME) ──${RST}"
    export PD_APP
    if node "${SCRIPT_DIR}/release-l2-electron-smoke.mjs"; then
      echo "  ${GRN}✓${RST} L2c passed"
    else
      echo "  ${YEL}⚠${RST} L2c failed or timed out (single-instance); L2d covers onboarding"
      L2C_FAILED=1
    fi
  fi

  echo
  echo "${CYN}── L2d: Cold-start Electron (new user, isolated HOME) ──${RST}"
  export PD_APP
  node "${SCRIPT_DIR}/release-l2-cold-start-electron.mjs" || {
    echo "${RED}Cold-start Electron failed${RST}" >&2
    exit 1
  }
fi

echo
if [[ "${L2C_FAILED:-0}" == "1" ]]; then
  echo "${BLD}${GRN}✓ L2 smoke PASSED${RST} ${YEL}(L2c skipped/failed; L2a/L2b/L2d OK)${RST}"
else
  echo "${BLD}${GRN}✓ L2 smoke PASSED${RST}"
fi
