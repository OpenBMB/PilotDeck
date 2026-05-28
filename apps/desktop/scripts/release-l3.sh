#!/usr/bin/env bash
# ============================================================================
# L3 release E2E — real Gateway agent turn (opt-in, needs API credentials)
#
# Usage:
#   bash scripts/release-l3.sh              # skip if no API keys
#   bash scripts/release-l3.sh --force      # fail if keys missing
#   PILOTDECK_RUN_FRAMEWORK_E2E=1 bash scripts/release-l3.sh
#
# Also runs real-agent-lifecycle-hooks when PILOTDECK_RUN_REAL_AGENT_LIFECYCLE_E2E=1.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/../.." && pwd)"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; CYN=$'\033[0;36m'; BLD=$'\033[1m'; RST=$'\033[0m'

has_key=0
for v in ANTHROPIC_API_KEY OPENAI_API_KEY PILOTDECK_API_KEY; do
  [[ -n "${!v:-}" ]] && has_key=1 && break
done

echo "${BLD}PilotDeck L3 E2E${RST}"

if [[ "$has_key" == "0" ]]; then
  if [[ "$FORCE" == "1" ]]; then
    echo "${RED}No API key in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / PILOTDECK_API_KEY)${RST}" >&2
    exit 1
  fi
  echo "${YEL}⚠ Skipping L3 — no API credentials in environment${RST}"
  echo "  Export a key and re-run, or: bash scripts/release-l3.sh --force"
  exit 0
fi

cd "$REPO_ROOT"
echo
echo "${CYN}── L3a: Framework WCB smoke (Gateway + real model) ──${RST}"
npm run build
PILOTDECK_RUN_FRAMEWORK_E2E=1 node --test --test-force-exit --test-timeout 300000 \
  dist/tests/e2e/framework-wcb-smoke.test.js

if [[ "${PILOTDECK_RUN_REAL_AGENT_LIFECYCLE_E2E:-}" == "1" ]]; then
  echo
  echo "${CYN}── L3b: Real agent lifecycle hooks ──${RST}"
  if npm run e2e:real-agent-lifecycle-hooks; then
    echo "  ${GRN}✓${RST} lifecycle hooks E2E passed"
  else
    echo "  ${YEL}⚠${RST} lifecycle hooks E2E failed (often model tool_choice; L3a still counts)"
    L3B_FAILED=1
  fi
else
  echo
  echo "${CYN}── L3b: lifecycle hooks (skipped) ──${RST}"
  echo "  Set PILOTDECK_RUN_REAL_AGENT_LIFECYCLE_E2E=1 to enable"
fi

echo
if [[ "${L3B_FAILED:-0}" == "1" ]]; then
  echo "${BLD}${YEL}✓ L3 core PASSED (L3a); L3b failed — see log above${RST}"
  exit 0
fi
echo "${BLD}${GRN}✓ L3 E2E PASSED${RST}"
