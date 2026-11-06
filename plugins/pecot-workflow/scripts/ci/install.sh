#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-workflow/)
PLUGIN_ROOT="$PWD"

# pecot-workflow plugin の Node 側（cli-node/）の依存を導入する。
# 1 push につき 1 回だけ実行するための nx target `pecot-workflow:install` の実体 (#1080)。
#
# nx の task graph は同一 `project:target` を 1 run につき 1 タスクへ dedupe する。
# 各 lane の target が本 target を dependsOn すれば、並列実行でも 1 回に収束する。
#
# 手動実行（run-tests.sh / run-lint.sh を env 無しで直接叩く場合）は、各スクリプトが install を行う。
# 本スクリプトは、その場合と同じ処理・同じログ文言を保つ。
# パッケージマネージャガード (#806 / #52) は、全 package.json の宣言を pecot-visual:check-pm-guard で確かめる。
# 宣言は devEngines・engines・packageManager・.npmrc を指す。本 plugin でも、同じ検証関数で宣言を確かめる。
# scripts の package manager 自己呼び出しは、pnpm 12 で同じ失敗をする (#1217)。
# そのため install 直後に、pecot-visual と共有の検証関数で確かめる。

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。
# nx 経由実行と直接実行で挙動が割れる問題を予防的に塞ぐため、除去する。
unset FORCE_COLOR

# pnpm 起動コマンドの解決は bin/_lib.sh (resolve_pnpm) を使う。
# shellcheck source=../../bin/_lib.sh
. "$PLUGIN_ROOT/bin/_lib.sh"

PNPM="$(resolve_pnpm "$PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# リポジトリは root の 1 つの pnpm workspace。依存の導入は repo root での frozen の install 1 回で済む。
# nx の install target では、root の project の install が導入を担う。本スクリプトは手動実行用で、同じ処理を行う。
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
echo "==> $PNPM install --frozen-lockfile (cwd=$REPO_ROOT)"
# shellcheck disable=SC2086
( cd "$REPO_ROOT" && $PNPM install --frozen-lockfile )

# scripts の package manager 自己呼び出しガード (#1217)。手動実行（run-tests.sh）と同じ検証を呼ぶ。
echo "==> bash $PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
bash "$PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
