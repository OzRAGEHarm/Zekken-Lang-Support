#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to build the VSIX."
  exit 1
fi

mkdir -p dist

EXT_NAME="$(node -p "require('./package.json').name")"
EXT_VERSION="$(node -p "require('./package.json').version")"
OUT_FILE="dist/${EXT_NAME}-${EXT_VERSION}.vsix"

echo "[VSIX] Packaging extension..."
echo "[VSIX] Output: ${OUT_FILE}"

# Use npx so users do not need a global vsce install.
npx --yes @vscode/vsce package --out "$OUT_FILE"

echo "[VSIX] Done."

