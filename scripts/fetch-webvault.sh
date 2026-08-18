#!/usr/bin/env bash
set -euo pipefail

# Pinned Web Vault prebuilt from vaultwarden's bw_web_builds releases.
# Bump PINNED_VERSION by running `curl -s https://api.github.com/repos/dani-garcia/bw_web_builds/releases/latest`.
PINNED_VERSION="v2026.6.4"
URL="https://github.com/dani-garcia/bw_web_builds/releases/download/${PINNED_VERSION}"
ARCHIVE="bw_web_${PINNED_VERSION}.tar.gz"
TARGET="static/webvault"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "${URL}/${ARCHIVE}" -o "${TMP}/${ARCHIVE}"
curl -fsSL "${URL}/sha256sums.txt" -o "${TMP}/sha256sums.txt"

CHECKSUM=$(rg "${PINNED_VERSION}.tar.gz" "${TMP}/sha256sums.txt" | awk '{print $1}' | head -1)
if [[ -n "${CHECKSUM}" ]]; then
  echo "$CHECKSUM  ${TMP}/${ARCHIVE}" | shasum -a 256 -c - >/dev/null
  echo "sha256 verified: ${CHECKSUM}"
else
  echo "WARNING: no published sha256 for ${ARCHIVE}; computed:"
  shasum -a 256 "${TMP}/${ARCHIVE}"
fi

rm -rf "${TARGET}"
mkdir -p "${TARGET}"
tar -xzf "${TMP}/${ARCHIVE}" -C "${TARGET}" --strip-components=1

echo "Web Vault ${PINNED_VERSION} deployed to ${TARGET}/"