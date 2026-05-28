#!/usr/bin/env bash
# ============================================================================
# Full release verification: L1 (verify-dmg) + L2 (Playwright) + optional L3
#
# Usage:
#   bash scripts/release-verify-all.sh <DMG_PATH> [signed|adhoc]
#   bash scripts/release-verify-all.sh --skip-l3 <DMG>
#   bash scripts/release-verify-all.sh --l3-only   # no DMG; L3 only
#
# Typical after release.sh produces a DMG, or standalone on a built artifact.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKIP_L3=0
L3_ONLY=0
SKIP_L2=0
MODE="auto"
DMG=""

for arg in "$@"; do
  case "$arg" in
    --skip-l3)   SKIP_L3=1 ;;
    --skip-l2)   SKIP_L2=1 ;;
    --l3-only)   L3_ONLY=1 ;;
    signed|adhoc) MODE="$arg" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *)
      if [[ -z "$DMG" ]]; then DMG="$arg"; else
        echo "Unknown arg: $arg" >&2; exit 2
      fi
      ;;
  esac
done

BLD=$'\033[1m'; GRN=$'\033[0;32m'; DIM=$'\033[2m'; RST=$'\033[0m'

if [[ "$L3_ONLY" == "1" ]]; then
  bash "${SCRIPT_DIR}/release-l3.sh" "$@"
  exit $?
fi

[[ -n "$DMG" ]] || { echo "Usage: release-verify-all.sh <DMG> [signed|adhoc]" >&2; exit 2; }

echo "${DIM}Host ~/.pilotdeck is not modified by L1/L2 (isolated sandboxes).${RST}"
echo "${DIM}Set PD_USE_REAL_PILOT_HOME=1 only with pilotdeck-user-config.sh backup (not used by default).${RST}"
echo

echo "${BLD}══ L1: verify-dmg ══${RST}"
bash "${SCRIPT_DIR}/verify-dmg.sh" "$DMG" "$MODE"

if [[ "$SKIP_L2" == "0" ]]; then
  echo
  echo "${BLD}══ L2: Playwright + onboarding (+ Electron) ══${RST}"
  bash "${SCRIPT_DIR}/release-l2.sh" "$DMG"
fi

if [[ "$SKIP_L3" == "0" ]]; then
  echo
  echo "${BLD}══ L3: real-model E2E (opt-in) ══${RST}"
  # release-l3 exits 0 when keys are absent, so non-zero here means a real
  # L3 failure that must fail full verification.
  bash "${SCRIPT_DIR}/release-l3.sh"
fi

echo
echo "${BLD}${GRN}✓ Full release verification complete${RST}"
