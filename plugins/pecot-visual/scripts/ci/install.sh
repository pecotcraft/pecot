#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-visual/)
PECOTV_PLUGIN_ROOT="$PWD"
SCRIPT_DIR="$PECOTV_PLUGIN_ROOT/scripts/ci"

# pecot-visual plugin の依存導入を、1 回の nx 実行につき 1 回だけ行うための nx target。
# 本スクリプトは `pecot-visual:install` の実体 (#1080)。test / lint の各レーンが dependsOn で参照する。
# パッケージマネージャガードの確認は test のレーンだけが要る。
# そのため、別 target の `pecot-visual:check-pm-guard` に分けた。この target は check-pm-guard.sh を直接起動する。
#
# 従来は run-tests.sh の先頭で、scope に関係なく実行していた。
# その結果、affected な lane の数だけ install と check-pm-guard（隔離 install 5 回）が繰り返されていた。
# nx の task graph は、同一の `project:target` を 1 run につき 1 タスクにまとめる。
# そのため、各 lane の test target が本 target を dependsOn すれば、並列で実行しても 1 回に収束する。
#
# 手動実行（run-tests.sh を env 無しで直接実行する場合）は、従来どおり run-tests.sh 側が install する。
# 本スクリプトは、その場合と同じ処理、同じログ文言を保つ。

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# playwright postinstall のブラウザ DL（~180MB）抑止。
# 実 Chromium は pptx-postprocess の `npx playwright install chromium` がオンデマンド取得する。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。
# nx 経由の実行と直接の実行で挙動が割れる罠を予防的に塞ぐため、除去する。run-tests.sh と対称の処理。
unset FORCE_COLOR

# pnpm 起動コマンドの解決は bin/_lib.sh の resolve_pnpm に一本化している。
# run-tests.sh、run-lint.sh、publish-mcp-dist.sh も同じ関数を使う。
# shellcheck source=../../bin/_lib.sh
. "$PECOTV_PLUGIN_ROOT/bin/_lib.sh"

PNPM="$(resolve_pnpm "$PECOTV_PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PECOTV_PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# リポジトリは root の 1 つの pnpm workspace。repo root での 1 回の frozen の install で、全メンバーを解決する。
# 手順は dev-install-lib.sh を参照。
# shellcheck source=dev-install-lib.sh
. "$SCRIPT_DIR/dev-install-lib.sh"
pecotv_dev_install "$PECOTV_PLUGIN_ROOT" "$PNPM"
