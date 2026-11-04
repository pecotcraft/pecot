#!/usr/bin/env bash
# pecot setup script
# Sets up pre-commit hooks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== pecot setup ==="

cd "$SCRIPT_DIR"

# 1. Install pre-commit hooks via uvx
# 初回は uvx が pre-commit を取得するため時間がかかる。
echo "[1/3] Installing pre-commit hooks..."
# 旧 setup.sh の残骸（自作 pre-push と chain file）を掃除してから pre-commit install。
# テスト実行は .pre-commit-config.yaml の githooks-tests / nx-affected-tests local hook に移った。
if [ -f "$SCRIPT_DIR/.git/hooks/pre-push.pre-commit" ]; then
    rm -f "$SCRIPT_DIR/.git/hooks/pre-push.pre-commit"
fi
if [ -f "$SCRIPT_DIR/.git/hooks/pre-push" ] && \
   grep -q "bats テスト" "$SCRIPT_DIR/.git/hooks/pre-push" 2>/dev/null; then
    rm -f "$SCRIPT_DIR/.git/hooks/pre-push"
fi
# pre-commit は core.hooksPath が設定されていると "Cowardly refusing" で失敗する。
# 値の妥当性は問わないため、既設定なら install をスキップして冪等に保つ。
# worktree は .git/hooks を共有するので、main で 1 度入れれば全 WT に伝播する。
if git config --get core.hooksPath > /dev/null 2>&1; then
    echo "  [skip] core.hooksPath 設定済みのため pre-commit install をスキップ" >&2
else
    if ! command -v uvx >/dev/null 2>&1; then
        echo "  [error] uvx not found. Install uv (devcontainer feature: ghcr.io/va-h/devcontainers-features/uv:1) and retry." >&2
        exit 1
    fi
    uvx pre-commit install --install-hooks
    uvx pre-commit install --hook-type commit-msg
    uvx pre-commit install --hook-type pre-push
    echo "  pre-commit hooks installed."
fi

# 2. Install Node dependencies (for Nx workspace)
echo "[2/3] Installing Node dependencies..."
if [ -f "$SCRIPT_DIR/package.json" ]; then
    if ! command -v npm >/dev/null 2>&1; then
        echo "  [error] npm not found. Install Node.js (devcontainer feature: ghcr.io/devcontainers/features/node:2) and retry." >&2
        exit 1
    fi
    # root の prepare が libs/text-rules の npm ci と build を実行する（root フックが使う dist を作る）。
    npm install --loglevel=error
    echo "  npm install complete."
else
    echo "  package.json not found, skipping npm install."
fi

# 3. Install per-plugin dependencies for development (per-plugin pnpm install).
# nx の install target と同じ plugins/*/scripts/ci/install.sh を呼ぶ（開発ツリーの node_modules に入る）。
# プラグインの setup.sh は利用者のデータ置き場（実行用ミラー）向けなので、開発の準備には使わない。
# install.sh を持たないプラグイン（pecot-workflow）は飛ばす。
echo "[3/3] Installing per-plugin dependencies..."
for plugin_install in "$SCRIPT_DIR"/plugins/*/scripts/ci/install.sh; do
    [ -f "$plugin_install" ] || continue
    echo "  -> $plugin_install"
    bash "$plugin_install"
done

echo "=== Setup complete ==="
