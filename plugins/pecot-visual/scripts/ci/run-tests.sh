#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"
cd "$PECOTV_PLUGIN_ROOT"

# --scope で実行範囲を絞る。nx のレーン（pecot-visual:test-<scope>）から呼び分けるためのパラメータ。
# scope ごとの内容は次のとおり。
#   --scope=slidev    : v-slidev の build、build:test、test:coverage。
#   --scope=cli       : cli の build / test / test:e2e。
#   --scope=bootstrap : bin/pecotv と登録ファイルの bash テスト。
#                       対象は cli/tests/bootstrap/ 配下の次のテスト。
#                       host-deps-marker、install-record、data-dir、mirror-real-pnpm、manifest、lib-consistency、text-rules-link。
#                       重い CUJ 一式の run.sh は、従来どおり手動実行とし、含めない。
#                       cli/src だけを変えた push で動かさないよう、cli から分けた (#1235)。
#   --scope=hooks     : pecotv hooks の *.test.sh。hooks/tests/ 配下を find | sort で再帰列挙し、順次実行する。
#   --scope=release   : MCP 単体配布の publish スクリプトのテスト。scripts/release/tests/ 配下の *.test.sh。
#   --scope=compare   : 前後比較スクリプトのテスト。pptx-compare と page-compare の tests/ 配下の *.test.sh。
#   --scope=skills    : スキル配布ドキュメントの静的確認。scripts/ci/tests/ 配下の *.test.sh。
#   引数なし          : 全部。手動実行用の既定。
#
# env PECOTV_SKIP_INSTALL=1 のとき、install / check-pm-guard / 各 lane 先頭の依存 build を飛ばす。
# nx 経由（test-* target）専用のスイッチ。
# これらは nx の別 target が dependsOn 経由で 1 push 1 回だけ実行する (#1080)。
# 別 target は次の 4 つ。
# pecot-visual:install、pecot-visual:check-pm-guard、pecot-visual:build-cli、pecot-visual:build-slidev。
# lane 内でしか使わない build は飛ばさない。対象は slidev の build:test。
# env 無しの手動実行では、従来どおり全部を本スクリプトが実行する。
# lock / manifest / 本 CI スクリプトを追加・改名したときは、nx.json の pecotvPluginTestGlobals にも追記すること。
# JSON はコメントを書けないため、この注意を本ファイルに残す。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=bootstrap | --scope=slidev | --scope=hooks | --scope=release | --scope=compare | --scope=skills | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|bootstrap|slidev|hooks|release|compare|skills|all)" >&2
            exit 1
            ;;
    esac
done

# nx 経由では共有ステップ（install / pm-guard / 依存 build）を nx の別 target が担う。
SKIP_SHARED=false
if [ "${PECOTV_SKIP_INSTALL:-0}" = "1" ]; then
    SKIP_SHARED=true
fi

RUN_CLI=false
RUN_BOOTSTRAP=false
RUN_SLIDEV=false
RUN_HOOKS=false
RUN_RELEASE=false
RUN_COMPARE=false
RUN_SKILLS=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    bootstrap) RUN_BOOTSTRAP=true ;;
    slidev) RUN_SLIDEV=true ;;
    hooks) RUN_HOOKS=true ;;
    release) RUN_RELEASE=true ;;
    compare) RUN_COMPARE=true ;;
    skills) RUN_SKILLS=true ;;
    all) RUN_CLI=true; RUN_BOOTSTRAP=true; RUN_SLIDEV=true; RUN_HOOKS=true; RUN_RELEASE=true; RUN_COMPARE=true; RUN_SKILLS=true ;;
esac

# pnpm 起動コマンドの解決は bin/_lib.sh の resolve_pnpm に一本化している。
# run-lint.sh と publish-mcp-dist.sh も同じ関数を使う。
# shellcheck source=../../bin/_lib.sh
. "$PECOTV_PLUGIN_ROOT/bin/_lib.sh"
# shellcheck source=parallel-lib.sh
. "$SCRIPT_DIR/parallel-lib.sh"

PNPM="$(resolve_pnpm "$PECOTV_PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PECOTV_PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# playwright postinstall のブラウザ DL（~180MB）抑止。
# 実 Chromium は pptx-postprocess の `npx playwright install chromium` がオンデマンド取得する。
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。
# 現状 pecotv に色へ依存した出力の assert は無い。
# ただし、nx 経由の実行と直接の実行で挙動が割れる罠を予防的に塞ぐため、除去する。
# pecot-workflow の run-tests.sh にある pytest pass 1 と対称の処理。
unset FORCE_COLOR
# 開発者の Claude セッションの子として動くと、次の変数を受け継ぐ。
# クライアントが渡したデータ置き場（CLAUDE_PLUGIN_DATA）と、導入済みバージョンの実行用ミラーの変数（PECOTV_RUNTIME_DIR など）。
# 確認の結果を、開発者の導入済み環境に依存させたくない。
# worktree のテストが、bin/pecotv の準備先を導入済みバージョンの置き場に向けることも避けたい。
# そのため、ミラーの変数は unset し、CLAUDE_PLUGIN_DATA は一時ディレクトリに固定する。
# 空にするだけだと、隔離を忘れたテストが wrapper を呼んだとき、実ホームの既定の場所に install してしまう。
# データ置き場を使うテスト（cli/tests/bootstrap/）は、自分で作る一時のデータ置き場を CLAUDE_PLUGIN_DATA に渡す。
# 既定の場所を確かめるテストは、自分で CLAUDE_PLUGIN_DATA を空にして起動する。
# vitest では、setupFiles が CLAUDE_PLUGIN_DATA を一時ディレクトリへ向ける。
# 該当のファイルは cli/tests/_helpers/unset-plugin-data-environment.ts。
# XDG_DATA_HOME は付け替えない（pnpm の store の置き場まで動くため）。
unset PLUGIN_DATA PECOTV_DEPENDENCY_ROOT PECOTV_RUNTIME_DIR PECOT_TOOLS_RUNTIME_DIR
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"

cleanup() {
    rc=$?
    rm -rf "$GATE_PLUGIN_DATA"
    # coverage/tmp は slidev lane（test:coverage の c8）だけが生成する。
    # そのため、その lane を実行したときだけ掃除する。
    # RUN_SLIDEV は trap の定義より前（SCOPE の解決時）に確定していて、trap の EXIT 発火時点では必ず参照できる。
    if [ "$RUN_SLIDEV" = true ]; then
        rm -rf assets/slidev/coverage/tmp
    fi
    if [ "$rc" -ne 0 ]; then
        echo
        echo "Error: pecot-visual plugin の CI チェックに失敗しました (exit ${rc})." 1>&2
        echo "  上記の tsc / vitest 出力を確認し、エラー箇所を修正してください。" 1>&2
        echo "  キャッシュが原因なら、dist/*.tsbuildinfo を削除して再実行する。" 1>&2
        echo "  例: rm -rf plugins/pecot-visual/assets/slidev/scripts/eslint/*/dist" 1>&2
        echo "  node_modules が原因なら、plugins/pecot-visual で bash scripts/ci/install.sh を実行する。" 1>&2
        echo "  coverage の閾値割れなら、assets/slidev/.c8rc.json の閾値を確認する。" 1>&2
        echo "  未カバーの行は、次のコマンドで特定する。" 1>&2
        echo "  (pnpm || corepack pnpm) --filter @pecot/slidev-assets-dev run test:coverage -- --reporter=text-missing" 1>&2
        echo "  coverage を一時 off にする: NODE_V8_COVERAGE='' bash plugins/pecot-visual/scripts/ci/run-tests.sh" 1>&2
    fi
}
trap cleanup EXIT

# pecot-visual plugin は、自己完結した pnpm workspace のルート。
# 1 回の install で、cli / v-slidev / runtime を全て解決する。
# nx 経由では、install・text-rules:build・check-pm-guard の target が担う。
if [ "$SKIP_SHARED" = false ]; then
    # 導入の手順は dev-install-lib.sh を参照。
    # shellcheck source=dev-install-lib.sh
    . "$SCRIPT_DIR/dev-install-lib.sh"
    pecotv_dev_install "$PECOTV_PLUGIN_ROOT" "$PNPM"

    # cli の tsc は libs/text-rules/dist の型を読むので、cli より先に build する。nx 経由では text-rules:build が先に動く。
    echo "==> $PNPM --filter @pecot/text-rules-src run build"
    # shellcheck disable=SC2086
    ( cd "$REPO_ROOT" && $PNPM --filter @pecot/text-rules-src run build )

    # パッケージマネージャガード (#806)。devEngines.packageManager が、違うパッケージマネージャの混入を止めているか、オフラインで確認する。
    echo "==> bash $SCRIPT_DIR/check-pm-guard.sh"
    bash "$SCRIPT_DIR/check-pm-guard.sh"

    # Chromium を使う lane の前提を、本実行の前に確かめる (#1217)。
    # nx 経由では、pecot-visual:chromium-preflight target が dependsOn で先に 1 回だけ実行する。
    if [ "$RUN_CLI" = true ]; then
        echo "==> bash $SCRIPT_DIR/chromium-preflight.sh"
        bash "$SCRIPT_DIR/chromium-preflight.sh"
    fi
fi

if [ "$RUN_SLIDEV" = true ]; then
    # v-slidev (skill) の build と test を実行する。
    # nx 経由では、pecot-visual:build-slidev target が同じ build を 1 push 1 回だけ実行する。
    if [ "$SKIP_SHARED" = false ]; then
        echo "==> $PNPM --filter @pecot/slidev-assets-dev run build"
        echo "    tsc -b で全 sub-project を build する。text-rules は build 済みなので PECOTV_SKIP_LIB_BUILD=1 で省く。"
        # shellcheck disable=SC2086
        ( cd "$PECOTV_PLUGIN_ROOT" && PECOTV_SKIP_LIB_BUILD=1 $PNPM --filter @pecot/slidev-assets-dev run build )
    fi

    echo "==> $PNPM --filter @pecot/slidev-assets-dev run build:test"
    echo "    .test.ts の型チェック。tsc -b --force で実行する。"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/slidev-assets-dev run build:test )

    echo "==> $PNPM --filter @pecot/slidev-assets-dev run test:coverage (lint 規則と補助スクリプト。c8 の閾値を満たすこと)"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/slidev-assets-dev run test:coverage )
fi

if [ "$RUN_CLI" = true ]; then
    # cli (TS lane) の build / test / test:e2e を実行する。
    # nx 経由では、pecot-visual:build-cli target が同じ build を 1 push 1 回だけ実行する。
    # ここで build を重ねると、prebuild の `rm -rf dist` が、並行する lane の読む dist を消す。
    if [ "$SKIP_SHARED" = false ]; then
        echo "==> $PNPM --filter @pecot/pecotv-cli run build (cli: tsc -p tsconfig.build.json)"
        # shellcheck disable=SC2086
        ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
    fi

    echo "==> $PNPM --filter @pecot/pecotv-cli run test (cli: vitest run --coverage。閾値を満たすこと)"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run test )

    echo "==> $PNPM --filter @pecot/pecotv-cli run test:e2e (cli: vitest run --config vitest.e2e.config.ts)"
    # shellcheck disable=SC2086
    ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run test:e2e )
fi

if [ "$RUN_BOOTSTRAP" = true ]; then
    # bin/pecotv の bootstrap にある、OS ライブラリ確認の分岐 (#1217)。
    # 実 Chromium や apt を使わない stub の plugin root で動かすため、2 秒弱で終わる。
    # 重い CUJ 一式の cli/tests/bootstrap/run.sh は、従来どおり手動実行のままとし、本レーンに含めない。
    echo "==> bash cli/tests/bootstrap/host-deps-marker.sh (bootstrap の OS ライブラリ確認)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/host-deps-marker.sh"

    # bin/pecotv が、実行用ミラー（データ置き場の runtime/<deps-hash>-<src-hash>/）をいつ作り直すかを確かめる。
    # 同じ stub の plugin root で、pnpm を記録だけの stub に差し替える。
    # そして、wrapper の固定行（installing dependencies / building）の数を数える。
    # 確かめるケースは次のとおり。同一なら 0/0、バージョンだけなら 0/0、ソースだけなら 0/1、依存の変更なら 1/1、2 回目は 0/0。
    # 失敗からの復帰、同時起動、世代の削除も確かめる。
    echo "==> bash cli/tests/bootstrap/install-record.sh (ミラーの install / build の回数)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/install-record.sh"

    # データ置き場の解決の順序を確かめる。順序は CLAUDE_PLUGIN_DATA、PLUGIN_DATA、既定の場所の順。
    # HOME と XDG_DATA_HOME がどちらも有効でないときに止まることも確かめる。
    echo "==> bash cli/tests/bootstrap/data-dir.sh (データ置き場の解決の順序と既定の場所)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/data-dir.sh"

    # 実 pnpm と実 build で「複製してから build」の流れを実行する。
    # 複製したミラーで pnpm が install を始めないこと（Packages: 行が出ず、.modules.yaml が変わらないこと）を確かめる。
    echo "==> bash cli/tests/bootstrap/mirror-real-pnpm.sh (ハードリンクで複製してから build)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/mirror-real-pnpm.sh"

    # Agent Plugins 1.0 形式（ルートの plugin.json / mcp.json）と従来形式の整合。
    echo "==> bash cli/tests/bootstrap/manifest.sh (Agent Plugins 1.0 形式と従来形式の整合)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/manifest.sh"

    # 3 プラグインの bin/_lib.sh で逐語一致させるブロックが、一致していること。
    echo "==> bash cli/tests/bootstrap/lib-consistency.sh (bin/_lib.sh の逐語一致)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/lib-consistency.sh"

    # libs/text-rules のリンクと、ミラーの入力に node_modules・dist・coverage が入らないこと。
    echo "==> bash cli/tests/bootstrap/text-rules-link.sh (text-rules のリンクとミラーの入力)"
    bash "$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/text-rules-link.sh"
fi

if [ "$RUN_HOOKS" = true ]; then
    # pecotv hooks の *.test.sh を、find で再帰列挙して順次実行する。project.json との二重管理は無い。
    # post-tool-use/ のネストがあるため find で再帰列挙し、LC_ALL=C sort で順序を固定する。
    # *.test.sh には、単体で bash 実行できるテスト本体だけを置く規約。
    # source されるヘルパーは別の名前（例: *.helper.sh）にして、テストの実行対象に混ぜない。
    # 各テストは SCRIPT_DIR を基準にして cwd に依存せず、別プロセス（bash <file>）で起動する set -u の設計。
    # 実行順は sort の辞書順に依存する。ただし、各テストは独立していて、テスト間に実行順の依存を持たせない前提。
    # find の起点が $PECOTV_PLUGIN_ROOT から始まるため、$test_file は絶対パスで返る。
    echo "==> pecotv hooks 単体テスト (hooks/tests/ 配下の *.test.sh を、find | sort の順に実行)"
    mapfile -t test_files < <(find "$PECOTV_PLUGIN_ROOT/hooks/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#test_files[@]}" -eq 0 ]; then
        echo "ERROR: hooks/tests/ 配下に *.test.sh が見つかりません (hooks/tests の消失か、find の失敗)。" >&2
        exit 1
    fi
    for test_file in "${test_files[@]}"; do
        echo "==> bash $test_file"
        bash "$test_file"
    done
fi

if [ "$RUN_RELEASE" = true ]; then
    # publish を全て --skip-build で呼ぶため、cli と eslint プラグインの dist はここで用意する。
    # cli・slidev レーンが持たない scope のときだけ補う。nx 経由では build-cli・build-slidev が先に動く。
    if [ "$SKIP_SHARED" = false ]; then
        if [ "$RUN_CLI" = false ]; then
            echo "==> $PNPM --filter @pecot/pecotv-cli run build (配布ツリー用の cli/dist)"
            # shellcheck disable=SC2086
            ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
        fi
        if [ "$RUN_SLIDEV" = false ]; then
            echo "==> $PNPM --filter @pecot/slidev-assets-dev run build (配布ツリー用の eslint プラグイン dist)"
            # shellcheck disable=SC2086
            ( cd "$PECOTV_PLUGIN_ROOT" && PECOTV_SKIP_LIB_BUILD=1 $PNPM --filter @pecot/slidev-assets-dev run build )
        fi
    fi

    # MCP 単体配布 (#982) の publish スクリプトのテスト。hooks lane と同じく find | sort で再帰列挙する。
    # 各テストは bash 単体で実行でき、cwd に依存しない。
    # 一時ディレクトリ、モックレジストリのポート、監査記録をテスト内に閉じている。
    # そのため並行で実行し、lane の所要を最長の 1 本に縮める (#1225)。
    # ログは並べ替えず、引数の順に 1 本ずつ出る（parallel-lib.sh）。
    echo "==> pecotv release 単体テスト (scripts/release/tests/ 配下の *.test.sh を、find | sort の順に並行して実行)"
    mapfile -t release_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/release/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    # publish が共通で呼ぶ attach-mcp-tgz.sh（pack から gh まで）のテストも、このレーンで実行する。
    release_test_files+=("$REPO_ROOT/.githooks/scripts/tests/attach-mcp-tgz.test.sh")
    run_tests_parallel "${release_test_files[@]}"
fi

if [ "$RUN_COMPARE" = true ]; then
    # pptx 前後比較スクリプト (#1073) のテスト。
    # 被テストスクリプトと fixture の合成が cli/dist を使う。cli レーンを持たない scope のときだけ補う。
    # nx 経由で重ねて build すると、prebuild の dist 削除が並行する test-cli レーンの E2E から CLI を奪う。
    if [ "$SKIP_SHARED" = false ] && [ "$RUN_CLI" = false ]; then
        echo "==> $PNPM --filter @pecot/pecotv-cli run build (pptx 比較スクリプト用の cli/dist)"
        # shellcheck disable=SC2086
        ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
    fi

    # hooks / release lane と同じく、find | sort で再帰列挙して順次実行する。
    # 各テストは bash 単体で実行でき、cwd に依存しない。生成物は mktemp -d 配下に閉じる。
    # page-compare (#1341) は cli/dist を使わない。同じレーンで一緒に実行する。
    echo "==> pecotv pptx-compare / page-compare 単体テスト (各 tests/ 配下の *.test.sh を、find | sort の順に実行)"
    for compare_tests_dir in pptx-compare page-compare; do
        if [ -z "$(find "$PECOTV_PLUGIN_ROOT/scripts/$compare_tests_dir/tests" -name '*.test.sh' 2> /dev/null)" ]; then
            echo "ERROR: scripts/$compare_tests_dir/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
            exit 1
        fi
    done
    mapfile -t compare_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/pptx-compare/tests" "$PECOTV_PLUGIN_ROOT/scripts/page-compare/tests" -name '*.test.sh' | LC_ALL=C sort)
    for test_file in "${compare_test_files[@]}"; do
        echo "==> bash $test_file"
        bash "$test_file"
    done
fi

if [ "$RUN_SKILLS" = true ]; then
    # スキル配布ドキュメント（SKILL.md / agents / references の DESIGN.md）の静的確認。
    # hooks / release lane と同じく、find | sort で再帰列挙して順次実行する。
    # 各テストは bash 単体で実行でき、cwd に依存しない。pnpm install の成果物にも依存しない。
    echo "==> pecotv skills 静的確認 (scripts/ci/tests/ 配下の *.test.sh を、find | sort の順に実行)"
    mapfile -t skills_test_files < <(find "$SCRIPT_DIR/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#skills_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/ci/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    for test_file in "${skills_test_files[@]}"; do
        echo "==> bash $test_file"
        bash "$test_file"
    done
fi

echo "pecotv all checks passed"
