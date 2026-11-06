#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-tools/)
PLUGIN_ROOT="$PWD"

# --scope で実行範囲を絞る。
# nx のレーン（pecot-tools:test-cli / test-bootstrap / test-release）から呼び分けるためのパラメータ化。
#   --scope=cli       : cli の build / test / test:e2e。
#   --scope=bootstrap : bin/pecot-tools・.mcp.json・登録ファイルの bash テスト（cli/tests/bootstrap/ 配下）。
#                       cli/src だけを変えた push で実行しないよう、cli から分けた (#1235)。
#   --scope=release   : MCP 単体配布の publish スクリプト検証（scripts/release/tests/ 配下の *.test.sh）。
#   引数なし          : 全部（手動実行用のデフォルト）。
#
# env PECOT_TOOLS_SKIP_INSTALL=1: install と各 lane 先頭の依存 build を飛ばす。
# nx 経由（test-* target）専用のスイッチ。
# これらは nx の別 target（pecot-tools:install / pecot-tools:build-cli）が実行する。
# nx は dependsOn 経由で、1 push 1 回だけ実行する (#1080)。
# env 無しの手動実行は、従来どおり全部を本スクリプトが実行する。
# lock / manifest / 本 CI スクリプトを追加・改名した際は、nx.json の pecotToolsPluginTestGlobals にも追記すること。
# JSON はコメント不可のため、本ファイルに保守の注意を残す。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=bootstrap | --scope=release | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|bootstrap|release|all)" >&2
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
RUN_BOOTSTRAP=false
RUN_RELEASE=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    bootstrap) RUN_BOOTSTRAP=true ;;
    release) RUN_RELEASE=true ;;
    all) RUN_CLI=true; RUN_BOOTSTRAP=true; RUN_RELEASE=true ;;
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
# nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。
# nx 経由実行と直接実行で挙動が割れる問題を予防的に塞ぐため、除去する（pecot-visual run-tests.sh と対称）。
unset FORCE_COLOR
# 開発者の Claude セッションの子として動くと、次の 2 つを受け継ぐ。
# クライアントが渡したデータ置き場（CLAUDE_PLUGIN_DATA）。
# 導入済みバージョンの実行用ミラーの変数（PECOT_TOOLS_RUNTIME_DIR）。
# チェックの結果を、開発者の導入済み環境に依存させたくない。
# worktree のテストが、bin/pecot-tools の準備先を導入済みバージョンの置き場に向けてもいけない。
# そのためミラーの変数は unset し、CLAUDE_PLUGIN_DATA は一時ディレクトリに固定する。
# 空にするだけだと、隔離を忘れたテストが wrapper を呼んだときに、実ホームの標準の場所へ install してしまう。
# データ置き場を使うテスト（cli/tests/bootstrap/）は、自分で作る一時のデータ置き場を CLAUDE_PLUGIN_DATA に渡す。
# 標準の場所を確かめるテストは、自分で CLAUDE_PLUGIN_DATA を空にして起動する。
# vitest は、setupFiles が CLAUDE_PLUGIN_DATA を一時ディレクトリへ向ける。
# setupFiles は cli/tests/_helpers/unset-plugin-data-environment.ts。
# XDG_DATA_HOME は付け替えない（pnpm の store の置き場まで動くため）。
unset PLUGIN_DATA PECOT_TOOLS_RUNTIME_DIR
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"
trap 'rm -rf "$GATE_PLUGIN_DATA"' EXIT

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
    # cli (TS lane) の build / test / test:e2e を呼び分ける。
    # nx 経由では pecot-tools:build-cli target が同じ build を 1 push 1 回だけ実行する。
    # ここで build を重ねると、prebuild の `rm -rf dist` が並行 lane の読む dist を消す。
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

if [ "$RUN_BOOTSTRAP" = true ]; then
    # bootstrap の bash テストは本体の cli/dist を使わない（stub か、ミラーを実 build する実 pnpm）。
    # そのため cli レーンを実行しない scope でも、build は要らない。
    # nx 経由で build-cli を dependsOn に置くのは、run.sh が本体の cli/dist を書き換えていないことを確かめる間、
    # build-cli を並行させないため。
    # run.sh は bin/pecot-tools / .mcp.json の CUJ（vitest は dist/cli.js を直接起動するため wrapper を通らない）。
    echo "==> bash cli/tests/bootstrap/run.sh (bin/pecot-tools / .mcp.json の CUJ)"
    bash "$PLUGIN_ROOT/cli/tests/bootstrap/run.sh"

    # bin/pecot-tools が実行用ミラー（データ置き場の runtime/<deps-hash>-<src-hash>/）をいつ作り直すか。
    # pnpm を記録だけの stub に差し替え、wrapper の固定行（installing dependencies / building）の数を数える。
    echo "==> bash cli/tests/bootstrap/install-record.sh (ミラーの install / build の回数)"
    bash "$PLUGIN_ROOT/cli/tests/bootstrap/install-record.sh"

    # データ置き場の解決順（CLAUDE_PLUGIN_DATA → PLUGIN_DATA → 標準の場所）。
    # HOME と有効な XDG_DATA_HOME のどちらも無いときの停止も見る。
    echo "==> bash cli/tests/bootstrap/data-dir.sh (データ置き場の解決順と既定の場所)"
    bash "$PLUGIN_ROOT/cli/tests/bootstrap/data-dir.sh"

    # Agent Plugins 1.0 形式（ルートの plugin.json / mcp.json）と従来形式の整合。
    echo "==> bash cli/tests/bootstrap/manifest.sh (Agent Plugins 1.0 形式と従来形式の整合)"
    bash "$PLUGIN_ROOT/cli/tests/bootstrap/manifest.sh"
fi

if [ "$RUN_RELEASE" = true ]; then
    # 配布ツリーの構築には cli/dist が要る。
    # テスト側は build を持たず、publish を全呼び出し --skip-build で実行する。
    # そのため cli レーンを実行しない scope のときだけ dist を用意する。
    # nx 経由では pecot-tools:build-cli target が dependsOn 経由で先に実行される。
    if [ "$SKIP_SHARED" = false ] && [ "$RUN_CLI" = false ]; then
        echo "==> $PNPM --filter @pecot/pecot-tools-cli run build (配布ツリー用の cli/dist)"
        # shellcheck disable=SC2086
        ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-tools-cli run build )
    fi

    # MCP 単体配布 (#1056) の publish スクリプト検証。scripts/release/tests/ 配下を find | sort で
    # 再帰列挙して順次実行する。各テストは bash 単体で実行可能・cwd 非依存。
    echo "==> pecot-tools release 単体テスト (scripts/release/tests/ 配下の *.test.sh を find | sort で順次実行)"
    mapfile -t release_test_files < <(find "$PLUGIN_ROOT/scripts/release/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に *.test.sh が見つかりません (消失 or find 失敗の疑い)。" >&2
        exit 1
    fi
    # publish が共通で呼ぶ attach-mcp-tgz.sh（pack から gh まで）のテストも、このレーンで実行する。
    release_test_files+=("$PLUGIN_ROOT/../../.githooks/scripts/tests/attach-mcp-tgz.test.sh")
    for test_file in "${release_test_files[@]}"; do
        echo "==> bash $test_file"
        bash "$test_file"
    done
fi

echo "pecot-tools all checks passed"
