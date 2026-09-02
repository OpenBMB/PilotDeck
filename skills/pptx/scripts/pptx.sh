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
    const h = crypto.createHash("sha256");
    for (const file of process.argv.slice(1)) h.update(fs.readFileSync(file));
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
    for (const name of ["jszip", "@xmldom/xmldom"]) req.resolve(name);
  ' "$RUNTIME_CACHE" >/dev/null 2>&1
}

ensure_runtime() {
  local npm_path="" expected=""
  runtime_ready && return 0
  find_node >/dev/null || {
    printf '{"status":"error","error":"Node.js was not found"}\n' >&2
    exit 2
  }
  npm_path="$(find_npm)" || {
    printf '{"status":"error","error":"The pinned PPTX runtime is unavailable and npm was not found"}\n' >&2
    exit 2
  }
  [[ -f "$RUNTIME_SOURCE/package-lock.json" ]] || {
    printf '{"status":"error","error":"runtime/package-lock.json is missing"}\n' >&2
    exit 2
  }
  mkdir -p "$RUNTIME_CACHE"
  cp "$RUNTIME_SOURCE/package.json" "$RUNTIME_CACHE/package.json"
  cp "$RUNTIME_SOURCE/package-lock.json" "$RUNTIME_CACHE/package-lock.json"
  if ! "$npm_path" ci --prefix "$RUNTIME_CACHE" --no-audit --no-fund --silent; then
    printf '{"status":"error","error":"The pinned PPTX runtime could not be prepared"}\n' >&2
    exit 2
  fi
  expected="$(runtime_hash)"
  printf '%s\n' "$expected" > "$STAMP_FILE"
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

case "${1:-}" in
  ""|-h|--help|help)
    printf 'Usage: pptx.sh <validate|render|compare|deliver|convert-legacy> [options]\n'
    exit 0
    ;;
  validate|render|compare|deliver|convert-legacy)
    ensure_runtime
    export PPTX_RUNTIME_ROOT="$RUNTIME_CACHE"
    export PPTX_SKILL_SOFFICE="$(find_soffice || true)"
    export PPTX_SKILL_PDF_RENDERER="$(find_pdf_renderer || true)"
    exec "$(find_node)" "$SCRIPT_DIR/pptx_cli.mjs" "$@"
    ;;
  *)
    printf '{"status":"error","error":"Unknown PPTX command: %s"}\n' "$1" >&2
    exit 2
    ;;
esac
