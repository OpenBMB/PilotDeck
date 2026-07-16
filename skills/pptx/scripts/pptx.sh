#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_SOURCE="$SKILL_DIR/runtime"
CACHE_ROOT="${PPTX_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-pptx}"
RUNTIME_CACHE="$CACHE_ROOT/runtime"
STAMP_FILE="$RUNTIME_CACHE/.pilotdeck-lock-hash"

find_node() {
  command -v node 2>/dev/null || return 1
}

find_npm() {
  command -v npm 2>/dev/null || return 1
}

runtime_hash() {
  local node_path=""
  node_path="$(find_node)" || return 1
  "$node_path" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const files = process.argv.slice(1);
    const h = crypto.createHash("sha256");
    for (const file of files) h.update(fs.readFileSync(file));
    process.stdout.write(h.digest("hex"));
  ' "$RUNTIME_SOURCE/package.json" "$RUNTIME_SOURCE/package-lock.json"
}

runtime_ready() {
  local node_path="" expected="" actual=""
  node_path="$(find_node)" || return 1
  [[ -f "$RUNTIME_SOURCE/package-lock.json" ]] || return 1
  [[ -f "$STAMP_FILE" && -f "$RUNTIME_CACHE/package.json" ]] || return 1
  expected="$(runtime_hash)" || return 1
  actual="$(<"$STAMP_FILE")"
  [[ "$expected" == "$actual" ]] || return 1
  "$node_path" -e '
    const { createRequire } = require("node:module");
    const path = require("node:path");
    const req = createRequire(path.resolve(process.argv[1], "package.json"));
    for (const name of ["pptxgenjs", "pptx-automizer", "jszip", "@xmldom/xmldom", "sharp"]) req.resolve(name);
  ' "$RUNTIME_CACHE" >/dev/null 2>&1
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

find_pdf_renderer() {
  for candidate in pdftoppm mutool magick; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

cmd_check() {
  local node_path="" npm_path="" soffice_path="" renderer_path=""
  local node_ok=false deps_ok=false render_available=false
  if node_path="$(find_node)"; then
    node_ok=true
  fi
  npm_path="$(find_npm || true)"
  if runtime_ready; then
    deps_ok=true
  fi
  soffice_path="$(find_soffice || true)"
  renderer_path="$(find_pdf_renderer || true)"
  if [[ -n "$soffice_path" && -n "$renderer_path" ]]; then
    render_available=true
  fi
  printf '{"status":"%s","node":%s,"node_path":"%s","npm_path":"%s","dependencies":%s,"runtime":"%s","libreoffice_path":"%s","pdf_renderer_path":"%s","render_available":%s}\n' \
    "$([[ "$node_ok" == true && "$deps_ok" == true ]] && printf ok || printf missing_dependencies)" \
    "$node_ok" "$node_path" "$npm_path" "$deps_ok" "$RUNTIME_CACHE" \
    "$soffice_path" "$renderer_path" "$render_available"
  [[ "$node_ok" == true && "$deps_ok" == true ]]
}

cmd_fix() {
  local npm_path="" expected=""
  find_node >/dev/null || {
    printf '{"status":"error","error":"Node.js was not found"}\n' >&2
    exit 2
  }
  npm_path="$(find_npm)" || {
    printf '{"status":"error","error":"npm was not found"}\n' >&2
    exit 2
  }
  [[ -f "$RUNTIME_SOURCE/package-lock.json" ]] || {
    printf '{"status":"error","error":"runtime/package-lock.json is missing"}\n' >&2
    exit 2
  }
  mkdir -p "$RUNTIME_CACHE"
  cp "$RUNTIME_SOURCE/package.json" "$RUNTIME_CACHE/package.json"
  cp "$RUNTIME_SOURCE/package-lock.json" "$RUNTIME_CACHE/package-lock.json"
  "$npm_path" ci --prefix "$RUNTIME_CACHE" --no-audit --no-fund
  expected="$(runtime_hash)"
  printf '%s\n' "$expected" > "$STAMP_FILE"
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
    printf 'Usage: pptx.sh <check|fix|scaffold|build|inspect|render|audit|validate-map|prepare-starter|apply-template|fidelity|self-test> [options]\n'
    ;;
  *)
    if ! runtime_ready; then
      printf '{"status":"error","error":"PPTX dependencies are missing or stale","hint":"Run: bash %s fix"}\n' "$0" >&2
      exit 2
    fi
    export PPTX_SKILL_ROOT="$SKILL_DIR"
    export PPTX_RUNTIME_ROOT="$RUNTIME_CACHE"
    export PPTX_SKILL_SOFFICE="$(find_soffice || true)"
    export PPTX_SKILL_PDF_RENDERER="$(find_pdf_renderer || true)"
    exec "$(find_node)" "$SCRIPT_DIR/pptx_cli.mjs" "$@"
    ;;
esac
