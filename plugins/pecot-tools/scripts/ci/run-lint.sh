#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-tools/)
PLUGIN_ROOT="$PWD"

# --scope で実行範囲を絞る。
# nx の lint target（pecot-tools:lint）から呼び分けるためのパラメータ化。
# install は scope に依らず常時実行。
#   --scope=cli : cli の lint
#   引数なし    : 全部（手動実行用のデフォルト）。
# lock / manifest / 本 CI スクリプトを追加・改名した際は、nx.json の pecotToolsPluginLintGlobals にも追記すること。
# JSON はコメント不可のため、本ファイルに保守の注意を残す。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|all)" >&2
            exit 1
            ;;
    esac
done

RUN_CLI=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    all) RUN_CLI=true ;;
esac

# pnpm 起動コマンドの解決は bin/_lib.sh (resolve_pnpm) を使う（bin/pecot-tools と共通）。
# shellcheck source=../../bin/_lib.sh
. "$PLUGIN_ROOT/bin/_lib.sh"

PNPM="$(resolve_pnpm "$PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pecot-tools plugin が自己完結 pnpm workspace ルート。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
echo "==> $PNPM install --frozen-lockfile (cwd=$PLUGIN_ROOT)"
# shellcheck disable=SC2086
( cd "$PLUGIN_ROOT" && $PNPM install --frozen-lockfile )

if [ "$RUN_CLI" = true ]; then
    # cli (TS lane) の lint dispatch（tsc --noEmit → eslint → knip）
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run lint )
fi
