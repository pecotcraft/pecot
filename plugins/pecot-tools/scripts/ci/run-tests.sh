#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-tools/)
PLUGIN_ROOT="$PWD"

# --scope=cli|release|all（既定 all）。nx のレーン test-cli / test-release が呼び分ける。
# PECOT_TOOLS_SKIP_INSTALL=1 は nx 経由専用で、install と build を nx の別 target に任せる (#1080)。
# 本 CI スクリプトを追加・改名したら、nx.json の pecotToolsPluginTestGlobals にも足す。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=release | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|release|all)" >&2
            exit 1
            ;;
    esac
done

# nx 経由では共有ステップ（install / 依存 build）を nx の別 target が担う。
SKIP_SHARED=false
if [ "${PECOT_TOOLS_SKIP_INSTALL:-0}" = "1" ]; then
    SKIP_SHARED=true
fi

RUN_CLI=false
RUN_RELEASE=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    release) RUN_RELEASE=true ;;
    all) RUN_CLI=true; RUN_RELEASE=true ;;
esac

# shellcheck source=pnpm-lib.sh
. "$PLUGIN_ROOT/scripts/ci/pnpm-lib.sh"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$PLUGIN_ROOT/../../.githooks/scripts/test_report/bash-test.sh"
PECOT_REPORT_RESULTS="$(bt_results_dir "$PLUGIN_ROOT")"

PNPM="$(resolve_pnpm "$PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# nx run-commands が注入する FORCE_COLOR は、nx 経由と直接実行で挙動を割る。
unset FORCE_COLOR

# pecot-tools plugin が自己完結 pnpm workspace ルート。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）。
# nx 経由では scripts/ci/install.sh（pecot-tools:install target）が実行済み。
if [ "$SKIP_SHARED" = false ]; then
    echo "==> $PNPM install --frozen-lockfile (cwd=$PLUGIN_ROOT/../..)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT/../.." && $PNPM install --frozen-lockfile )
    # install と同じく nx 経由では pecot-tools:install target（install.sh）が実行済み。
    echo "==> bash $PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
    bash "$PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
fi

if [ "$RUN_CLI" = true ]; then
    # nx 経由では build-cli target が build する。ここで重ねると、prebuild の `rm -rf dist` が並行 lane の dist を消す。
    if [ "$SKIP_SHARED" = false ]; then
        echo "==> $PNPM --filter @pecot/pecot-tools-cli run build (cli: tsc -p tsconfig.build.json)"
        # shellcheck disable=SC2086
        ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run build )
    fi

    echo "==> $PNPM --filter @pecot/pecot-tools-cli run test (cli: vitest run --coverage、閾値判定)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run test )

    echo "==> $PNPM --filter @pecot/pecot-tools-cli run test:e2e (cli: vitest run --config vitest.e2e.config.ts)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run test:e2e )
fi

if [ "$RUN_RELEASE" = true ]; then
    # テストは publish を --skip-build で呼ぶので、cli レーンを動かさない scope のときだけ cli/dist を用意する。
    if [ "$SKIP_SHARED" = false ] && [ "$RUN_CLI" = false ]; then
        echo "==> $PNPM --filter @pecot/pecot-tools-cli run build (配布ツリー用の cli/dist)"
        # shellcheck disable=SC2086
        ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run build )
    fi

    # MCP 単体配布 (#1056) の publish スクリプト検証。scripts/release/tests/ 配下を find | sort で列挙し、1 本ずつ最後まで動かす。
    echo "==> pecot-tools release 単体テスト (scripts/release/tests/ 配下の *.test.sh を find | sort で順次実行)"
    mapfile -t release_test_files < <(find "$PLUGIN_ROOT/scripts/release/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に *.test.sh が見つかりません (消失 or find 失敗の疑い)。" >&2
        exit 1
    fi
    release_rc=0
    bt_run_files "${release_test_files[@]}" || release_rc=$?
    # publish が共通で使う attach-mcp-tgz.sh と mcp-publish-common.sh のテストも、このレーンで bats で実行する。
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$PLUGIN_ROOT/../../.githooks/scripts/test_report/bats/run.sh" \
        "$PLUGIN_ROOT/../../.githooks/scripts/tests/attach-mcp-tgz.bats" \
        "$PLUGIN_ROOT/../../.githooks/scripts/tests/mcp-publish-common.bats" || release_rc=$?
    [ "$release_rc" -eq 0 ] || exit "$release_rc"
fi

echo "pecot-tools all checks passed"
