#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PECOTV_PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Chromium を使う lane（cli の e2e、slidev の cx / geometry assertion）の前提を、本実行の前に
# 1 回だけ確かめる (#1217)。nx target `pecot-visual:chromium-preflight` の実体で、run-tests.sh の
# 手動実行も同じスクリプトを呼ぶ。
#
# 前提が欠けていても、確認が無いと気づけない。
# install・build・unit テスト・カバレッジを終えてから、各 e2e が 1 件ずつ起動に失敗するまで分からない。
# pnpm 12 移行時の pre-push では、160 秒を超えた。
# ここでは、headless Chromium の起動を 1 回試すだけで判定する。
# OS のライブラリが足りなければ、`pecotv chromium host-deps` を使う。
# sudo を使える環境では入れ、入れられなければ入れるコマンドを示して落とす。
# --require-launch を付けると、OS のライブラリ以外の原因 (実行ファイル未取得等) で起動できないときも落とす。
#
# cli/dist は nx では pecot-visual:build-cli (dependsOn) が用意する。手動実行で無いときだけここで作る。

# shellcheck source=../../bin/_lib.sh
. "$PECOTV_PLUGIN_ROOT/bin/_lib.sh"

CLI_DIST="$PECOTV_PLUGIN_ROOT/cli/dist/cli.js"
if [ ! -f "$CLI_DIST" ]; then
    PNPM="$(resolve_pnpm "$PECOTV_PLUGIN_ROOT")"
    if [ -z "$PNPM" ]; then
        echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
        HINT="$(pnpm_resolution_hint "$PECOTV_PLUGIN_ROOT")"
        [ -n "$HINT" ] && echo "  $HINT" >&2
        exit 1
    fi
    echo "==> $PNPM --filter @pecot/pecotv-cli run build (chromium-preflight 用)"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
fi

echo "==> pecotv chromium host-deps --require-launch"
if ! node "$CLI_DIST" chromium host-deps --require-launch; then
    echo "ERROR: Chromium を起動できないため、Chromium を使うテストを始めずに止めます (上の案内を参照)。" >&2
    exit 1
fi
echo "  OK: headless Chromium を起動できる"
