#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"
cd "$PECOTV_PLUGIN_ROOT"

# --scope で実行範囲を絞る。nx のレーン（pecot-visual:lint-<scope>）から呼び分ける。
# PECOTV_SKIP_INSTALL=1 のとき、install と text-rules の build を飛ばす。nx の target が先に済ませている。
#   --scope=slidev : v-slidev の lint。
#   --scope=cli    : cli の lint。
#   --scope=skills : v-drawio の DESIGN.md を公式 linter に掛ける（lint:design）。
#   引数なし       : slidev と cli。slidev の lint が lint:design を含むため、skills は重ねない。
# lock / manifest / 本スクリプトを追加・改名したときは、nx.json の pecotvPluginLintGlobals にも追記すること。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=slidev | --scope=skills | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|slidev|skills|all)" >&2
            exit 1
            ;;
    esac
done

RUN_CLI=false
RUN_SLIDEV=false
RUN_SKILLS=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    slidev) RUN_SLIDEV=true ;;
    skills) RUN_SKILLS=true ;;
    # all は slidev の lint が lint:design を含むため、skills を重ねない。重ねると同じ確認が 2 回動く。
    all) RUN_CLI=true; RUN_SLIDEV=true ;;
esac

# pnpm 起動コマンドの解決は bin/_lib.sh の resolve_pnpm に一本化している。
# run-tests.sh と publish-mcp-dist.sh も同じ関数を使う。
# shellcheck source=../../bin/_lib.sh
. "$PECOTV_PLUGIN_ROOT/bin/_lib.sh"

PNPM="$(resolve_pnpm "$PECOTV_PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PECOTV_PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# playwright の postinstall でブラウザバイナリ DL（~180MB）を抑止する。
# 実 Chromium は pptx-postprocess の `npx playwright install chromium` がオンデマンド取得する。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# pecot-visual plugin が自己完結 pnpm workspace ルート。1 回の install で cli / v-slidev / runtime を全て解決
# 導入の手順は dev-install-lib.sh を参照。
if [ "${PECOTV_SKIP_INSTALL:-0}" != "1" ]; then
    # shellcheck source=dev-install-lib.sh
    . "$PECOTV_PLUGIN_ROOT/scripts/ci/dev-install-lib.sh"
    pecotv_dev_install "$PECOTV_PLUGIN_ROOT" "$PNPM"

    # cli の tsc は libs/text-rules/dist の型を読むので、先に build する。
    if [ "$RUN_CLI" = true ] || [ "$RUN_SLIDEV" = true ]; then
        echo "==> $PNPM --filter @pecot/text-rules-src run build"
        # shellcheck disable=SC2086
        ( cd "$REPO_ROOT" && $PNPM --filter @pecot/text-rules-src run build )
    fi
fi

if [ "$RUN_SLIDEV" = true ]; then
    # v-slidev (skill) の lint を dispatch。prelint の build.mjs が text-rules を消し直さないよう、build を飛ばす。
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && PECOTV_SKIP_LIB_BUILD=1 $PNPM --filter @pecot/slidev-assets-dev run lint )
fi

if [ "$RUN_SKILLS" = true ]; then
    # v-drawio (skill) の DESIGN.md を公式 linter に掛ける。lint:design を直接呼ぶため、prelint の build は動かない。
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/slidev-assets-dev run lint:design )
fi

if [ "$RUN_CLI" = true ]; then
    # cli (TS lane) の lint dispatch
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run lint )
fi
