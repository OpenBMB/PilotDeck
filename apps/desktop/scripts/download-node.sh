#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="22.14.0"
ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
OUT_DIR="${ROOT}/resources/node-bin"
OUT_BIN="${OUT_DIR}/node"
EXPECTED_VER="v${NODE_VERSION}"

if [[ -x "${OUT_BIN}" ]]; then
  ver="$("${OUT_BIN}" --version 2>/dev/null || true)"
  if [[ "${ver}" == "${EXPECTED_VER}" ]]; then
    echo "Node ${EXPECTED_VER} already present at ${OUT_BIN}; skipping download."
    exit 0
  fi
  echo "Existing binary reports '${ver}', expected '${EXPECTED_VER}'; re-downloading."
fi

mkdir -p "${OUT_DIR}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${BASE_URL}/${ARCHIVE} ..."
curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP}/${ARCHIVE}"

echo "Downloading SHASUMS256.txt for checksum verification ..."
curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "${TMP}/SHASUMS256.txt"

LINE="$(grep -F "${ARCHIVE}" "${TMP}/SHASUMS256.txt" | head -n1)"
if [[ -z "${LINE}" ]]; then
  echo "error: could not find SHA256 line for ${ARCHIVE} in SHASUMS256.txt" >&2
  exit 1
fi
EXPECTED_SHA256="$(awk '{print $1}' <<< "${LINE}")"

ACTUAL_SHA256="$(shasum -a 256 "${TMP}/${ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "error: SHA256 mismatch for ${ARCHIVE}" >&2
  echo "  expected: ${EXPECTED_SHA256}" >&2
  echo "    actual: ${ACTUAL_SHA256}" >&2
  exit 1
fi

echo "SHA256 OK (${ACTUAL_SHA256})"

TAR_PREFIX="node-v${NODE_VERSION}-darwin-arm64"
tar -xzf "${TMP}/${ARCHIVE}" -C "${TMP}" "${TAR_PREFIX}/bin/node"
install -m 0755 "${TMP}/${TAR_PREFIX}/bin/node" "${OUT_BIN}"

VERIFY="$("${OUT_BIN}" --version)"
if [[ "${VERIFY}" != "${EXPECTED_VER}" ]]; then
  echo "error: ${OUT_BIN} --version returned '${VERIFY}', expected '${EXPECTED_VER}'" >&2
  exit 1
fi

echo "Installed ${VERIFY} -> ${OUT_BIN}"
