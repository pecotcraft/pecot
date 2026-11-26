#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"
cd "$PECOTV_PLUGIN_ROOT"

# --scope=slidev|cli|bootstrap|hooks|release|compare|skills でレーン（pecot-visual:test-<scope>）の範囲に絞る。引数なしは全部。
# PECOTV_SKIP_INSTALL=1 は nx 専用で、install・check-pm-guard・build を飛ばす。本ファイルや lock を足したら nx.json の pecotvPluginTestGlobals に足す。
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
# bash のテストは bt_run_file で動かし、nx のレーンなら確かめを Allure の結果に残す（parallel-lib.sh が bash-test.sh を読む）。
PECOT_REPORT_RESULTS="$(bt_results_dir "$PECOTV_PLUGIN_ROOT")"

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
# 開発者の導入済みのデータ置き場とミラーに依存しないよう、ミラーの変数を外し、CLAUDE_PLUGIN_DATA を一時ディレクトリに固定する。
# 空にするだけだと、隔離を忘れたテストが実ホームの既定の場所へ install する。XDG_DATA_HOME は pnpm の store が動くので変えない。
unset PLUGIN_DATA PECOTV_DEPENDENCY_ROOT PECOTV_RUNTIME_DIR
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"

cleanup() {
    rc=$?
    rm -rf "$GATE_PLUGIN_DATA"
    if [ "$rc" -ne 0 ]; then
        echo
        echo "Error: pecot-visual plugin の CI チェックに失敗しました (exit ${rc})." 1>&2
        echo "  上記の tsc / vitest 出力を確認し、エラー箇所を修正してください。" 1>&2
        echo "  キャッシュが原因なら、dist/*.tsbuildinfo を削除して再実行する。" 1>&2
        echo "  例: rm -rf plugins/pecot-visual/assets/slidev/scripts/eslint/*/dist" 1>&2
        echo "  node_modules が原因なら、plugins/pecot-visual で bash scripts/ci/install.sh を実行する。" 1>&2
        echo "  coverage の閾値割れなら、cli/vitest.config.ts と assets/slidev/vitest.config.ts の thresholds を確認する。" 1>&2
        echo "  未カバーの行は、上の coverage の表の Uncovered Line #s で読む。" 1>&2
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

    echo "==> $PNPM --filter @pecot/slidev-assets-dev run test:coverage (lint 規則と補助スクリプト。coverage の閾値を満たすこと)"
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
    # 重い CUJ 一式の cli/tests/bootstrap/run.sh は手で流すので、このレーンに入れない。
    bootstrap_test_files=()
    for script in host-deps-marker.sh install-record.sh data-dir.sh mirror-real-pnpm.sh manifest.sh lib-consistency.sh text-rules-link.sh; do
        bootstrap_test_files+=("$PECOTV_PLUGIN_ROOT/cli/tests/bootstrap/$script")
    done
    bt_run_files "${bootstrap_test_files[@]}"
fi

if [ "$RUN_HOOKS" = true ]; then
    # hooks/tests/ の *.test.sh を再帰で列挙して順に動かす。source される補助は *.test.sh にしない。
    echo "==> pecotv hooks 単体テスト (hooks/tests/ 配下の *.test.sh を、find | sort の順に実行)"
    mapfile -t test_files < <(find "$PECOTV_PLUGIN_ROOT/hooks/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#test_files[@]}" -eq 0 ]; then
        echo "ERROR: hooks/tests/ 配下に *.test.sh が見つかりません (hooks/tests の消失か、find の失敗)。" >&2
        exit 1
    fi
    bt_run_files "${test_files[@]}"
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

    # publish のテストは一時ディレクトリ・ポート・監査記録をテスト内に閉じているので、並行で動かす (#1225)。
    echo "==> pecotv release 単体テスト (scripts/release/tests/ 配下の *.test.sh を、find | sort の順に並行して実行)"
    mapfile -t release_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/release/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    # publish が共通で使う attach-mcp-tgz.sh と mcp-publish-common.sh のテストも、このレーンで実行する。
    release_test_files+=("$REPO_ROOT/.githooks/scripts/tests/attach-mcp-tgz.test.sh")
    release_test_files+=("$REPO_ROOT/.githooks/scripts/tests/mcp-publish-common.test.sh")
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

    # page-compare (#1341) は cli/dist を使わないが、同じレーンで一緒に動かす。
    echo "==> pecotv pptx-compare / page-compare 単体テスト (各 tests/ 配下の *.test.sh を、find | sort の順に実行)"
    for compare_tests_dir in pptx-compare page-compare; do
        if [ -z "$(find "$PECOTV_PLUGIN_ROOT/scripts/$compare_tests_dir/tests" -name '*.test.sh' 2> /dev/null)" ]; then
            echo "ERROR: scripts/$compare_tests_dir/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
            exit 1
        fi
    done
    mapfile -t compare_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/pptx-compare/tests" "$PECOTV_PLUGIN_ROOT/scripts/page-compare/tests" -name '*.test.sh' | LC_ALL=C sort)
    bt_run_files "${compare_test_files[@]}"
fi

if [ "$RUN_SKILLS" = true ]; then
    # スキル配布ドキュメント（SKILL.md / agents / references の DESIGN.md）の静的確認。
    echo "==> pecotv skills 静的確認 (scripts/ci/tests/ 配下の *.test.sh を、find | sort の順に実行)"
    mapfile -t skills_test_files < <(find "$SCRIPT_DIR/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#skills_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/ci/tests/ 配下に *.test.sh が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    bt_run_files "${skills_test_files[@]}"
fi

echo "pecotv all checks passed"
