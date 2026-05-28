#!/usr/bin/env bash
# Download Bun runtime for arm64 macOS.
# Bun is needed for Bun-native dependencies that use bun-only APIs,
# .tsx imports without compilation, etc.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.3.10}"
ARCHIVE="bun-darwin-aarch64.zip"
BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
OUT_DIR="${ROOT}/resources/bun-bin"
OUT_BIN="${OUT_DIR}/bun"
EXPECTED_VER="${BUN_VERSION}"

if [[ -x "${OUT_BIN}" ]]; then
  ver="$("${OUT_BIN}" --version 2>/dev/null || true)"
  if [[ "${ver}" == "${EXPECTED_VER}" ]]; then
    echo "Bun ${EXPECTED_VER} already present at ${OUT_BIN}; skipping download."
    exit 0
  fi
  echo "Existing binary reports '${ver}', expected '${EXPECTED_VER}'; re-downloading."
fi

mkdir -p "${OUT_DIR}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${BASE_URL}/${ARCHIVE} ..."
curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP}/${ARCHIVE}"

unzip -q "${TMP}/${ARCHIVE}" -d "${TMP}"

# Inside the zip is `bun-darwin-aarch64/bun`
SRC="${TMP}/bun-darwin-aarch64/bun"
[[ -x "${SRC}" ]] || { echo "error: bun binary not found in archive at ${SRC}" >&2; exit 1; }

install -m 0755 "${SRC}" "${OUT_BIN}"

VERIFY="$("${OUT_BIN}" --version)"
if [[ "${VERIFY}" != "${EXPECTED_VER}" ]]; then
  echo "error: ${OUT_BIN} --version returned '${VERIFY}', expected '${EXPECTED_VER}'" >&2
  exit 1
fi

echo "Installed Bun ${VERIFY} -> ${OUT_BIN}"
