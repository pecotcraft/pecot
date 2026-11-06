#!/usr/bin/env bash
# pecot setup script
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== pecot setup ==="

cd "$SCRIPT_DIR"

# 1. Node の依存を導入する。root の pnpm workspace 1 つに lock も 1 つ。
echo "Installing Node dependencies (pnpm workspace)..."
# pnpm が無ければ corepack、それも無ければ npx で、packageManager の版を起動する。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
    PNPM=(corepack pnpm)
elif command -v npx >/dev/null 2>&1; then
    PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^+"]*\).*/\1/p' package.json | head -n 1)"
    if [ -z "$PNPM_VERSION" ]; then
        echo "  [error] package.json の packageManager から pnpm の版を読めません。" >&2
        exit 1
    fi
    # npm 11 は pnpm 宣言の dir で npx を止めるため、cwd を / にして --dir で渡す。
    PNPM=(npx --yes "pnpm@$PNPM_VERSION" --dir "$SCRIPT_DIR")
    cd /
else
    echo "  [error] pnpm / corepack / npx not found. Install Node.js (devcontainer feature: ghcr.io/devcontainers/features/node:2) and retry." >&2
    exit 1
fi
"${PNPM[@]}" install --frozen-lockfile
echo "  pnpm install complete."

echo "=== Setup complete ==="
