#!/usr/bin/env bash
# pecot setup script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== pecot setup ==="

cd "$SCRIPT_DIR"

# 1. Install Node dependencies (for Nx workspace)
echo "[1/2] Installing Node dependencies..."
if ! command -v npm >/dev/null 2>&1; then
    echo "  [error] npm not found. Install Node.js (devcontainer feature: ghcr.io/devcontainers/features/node:2) and retry." >&2
    exit 1
fi
# root の prepare が libs/text-rules の npm ci と build を実行する（root フックが使う dist を作る）。
npm install --loglevel=error
echo "  npm install complete."

# 2. Install per-plugin dependencies for development (per-plugin pnpm install).
# nx の install target と同じ plugins/*/scripts/ci/install.sh を呼ぶ（開発ツリーの node_modules に入る）。
# プラグインの setup.sh は利用者のデータ置き場（実行用ミラー）向けなので、開発の準備には使わない。
echo "[2/2] Installing per-plugin dependencies..."
for plugin_install in "$SCRIPT_DIR"/plugins/*/scripts/ci/install.sh; do
    [ -f "$plugin_install" ] || continue
    echo "  -> $plugin_install"
    bash "$plugin_install"
done

echo "=== Setup complete ==="
