#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REQUIREMENTS="$SKILL_DIR/requirements.txt"
CACHE_ROOT="${DOCX_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-docx}"
VENV_DIR="$CACHE_ROOT/venv"

venv_python() {
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    printf '%s\n' "$VENV_DIR/bin/python"
    return 0
  fi
  if [[ -x "$VENV_DIR/Scripts/python.exe" ]]; then
    printf '%s\n' "$VENV_DIR/Scripts/python.exe"
    return 0
  fi
  return 1
}

find_python() {
  local cached=""
  if cached="$(venv_python)"; then
    printf '%s\n' "$cached"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi
  return 1
}

find_soffice() {
  if command -v soffice >/dev/null 2>&1; then
    command -v soffice
    return 0
  fi
  local mac_path="/Applications/LibreOffice.app/Contents/MacOS/soffice"
  if [[ -x "$mac_path" ]]; then
    printf '%s\n' "$mac_path"
    return 0
  fi
  local windows_path="/c/Program Files/LibreOffice/program/soffice.exe"
  if [[ -x "$windows_path" ]]; then
    printf '%s\n' "$windows_path"
    return 0
  fi
  return 1
}

cmd_check() {
  local py=""
  local py_ok=false
  local deps_ok=false
  local soffice_path=""
  if py="$(find_python)"; then
    py_ok=true
    if "$py" -c 'import docx, lxml, PIL, fitz' >/dev/null 2>&1; then
      deps_ok=true
    fi
  fi
  if ! soffice_path="$(find_soffice)"; then
    soffice_path=""
  fi
  printf '{"status":"%s","python":%s,"python_path":"%s","dependencies":%s,"venv":"%s","libreoffice":%s,"libreoffice_path":"%s","render_available":%s}\n' \
    "$([[ "$py_ok" == true && "$deps_ok" == true ]] && printf ok || printf missing_dependencies)" \
    "$py_ok" "$py" "$deps_ok" "$VENV_DIR" \
    "$([[ -n "$soffice_path" ]] && printf true || printf false)" "$soffice_path" \
    "$([[ -n "$soffice_path" && "$deps_ok" == true ]] && printf true || printf false)"
  [[ "$py_ok" == true && "$deps_ok" == true ]]
}

cmd_fix() {
  local bootstrap=""
  if command -v python3 >/dev/null 2>&1; then
    bootstrap="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    bootstrap="$(command -v python)"
  else
    printf '{"status":"error","error":"Python 3 was not found"}\n' >&2
    exit 2
  fi
  mkdir -p "$CACHE_ROOT"
  "$bootstrap" -m venv "$VENV_DIR"
  local venv_py=""
  if ! venv_py="$(venv_python)"; then
    printf '{"status":"error","error":"Virtual environment was created without a usable Python executable"}\n' >&2
    exit 2
  fi
  "$venv_py" -m pip install --disable-pip-version-check --upgrade pip
  "$venv_py" -m pip install --disable-pip-version-check -r "$REQUIREMENTS"
  cmd_check
}

case "${1:-}" in
  check)
    shift
    cmd_check "$@"
    ;;
  fix)
    shift
    cmd_fix "$@"
    ;;
  ""|-h|--help|help)
    py="$(find_python || true)"
    if [[ -n "$py" ]]; then
      exec "$py" "$SCRIPT_DIR/docx_cli.py" --help
    fi
    printf 'Usage: docx.sh <check|fix|inspect|create|edit|review|finalize|compare|sanitize|render|validate|audit|self-test> [options]\n'
    ;;
  *)
    py="$(find_python || true)"
    if [[ -z "$py" ]] || ! "$py" -c 'import docx, lxml, PIL, fitz' >/dev/null 2>&1; then
      printf '{"status":"error","error":"DOCX dependencies are missing","hint":"Run: bash %s fix"}\n' "$0" >&2
      exit 2
    fi
    export DOCX_SKILL_SOFFICE="$(find_soffice || true)"
    exec "$py" "$SCRIPT_DIR/docx_cli.py" "$@"
    ;;
esac
