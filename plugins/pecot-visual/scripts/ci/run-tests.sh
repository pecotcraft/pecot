#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PECOTV_PLUGIN_ROOT="$REPO_ROOT/plugins/pecot-visual"
cd "$PECOTV_PLUGIN_ROOT"

# --scope=slidev|cli|hooks|release|compare|skills でレーン（pecot-visual:test-<scope>）の範囲に絞る。引数なしは全部。
# PECOTV_SKIP_INSTALL=1 は nx 専用で、install・check-pm-guard・build を飛ばす。本ファイルや lock を足したら nx.json の pecotvPluginTestGlobals に足す。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=slidev | --scope=hooks | --scope=release | --scope=compare | --scope=skills | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|slidev|hooks|release|compare|skills|all)" >&2
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
RUN_SLIDEV=false
RUN_HOOKS=false
RUN_RELEASE=false
RUN_COMPARE=false
RUN_SKILLS=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    slidev) RUN_SLIDEV=true ;;
    hooks) RUN_HOOKS=true ;;
    release) RUN_RELEASE=true ;;
    compare) RUN_COMPARE=true ;;
    skills) RUN_SKILLS=true ;;
    all) RUN_CLI=true; RUN_SLIDEV=true; RUN_HOOKS=true; RUN_RELEASE=true; RUN_COMPARE=true; RUN_SKILLS=true ;;
esac

# shellcheck source=pnpm-lib.sh
. "$PECOTV_PLUGIN_ROOT/scripts/ci/pnpm-lib.sh"
# shellcheck source=../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
# bash のテストは bt_run_file か bats/run.sh で動かし、nx のレーンなら結果を Allure の結果に残す。
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
# nx run-commands が子プロセスへ注入する FORCE_COLOR=true を除き、nx 経由と直接の実行を揃える。
unset FORCE_COLOR
# 開発者の Claude セッションから受け継いだデータ置き場を使わないよう、PLUGIN_DATA を落とし、CLAUDE_PLUGIN_DATA を一時ディレクトリに固定する。
# vitest では cli/tests/_helpers/unset-plugin-data-environment.ts が同じことをする。
unset PLUGIN_DATA
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"

cleanup() {
    rc=$?
    if [ -n "${publish_pid:-}" ]; then
        kill -TERM -- "-$publish_pid" 2> /dev/null || true
    fi
    rm -f "${publish_log:-}"
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

if [ "$RUN_HOOKS" = true ]; then
    echo "==> pecotv hooks 単体テスト (hooks/tests/ 配下の *.bats を、find | sort の順に bats で実行)"
    mapfile -t test_files < <(find "$PECOTV_PLUGIN_ROOT/hooks/tests" -name '*.bats' | LC_ALL=C sort)
    if [ "${#test_files[@]}" -eq 0 ]; then
        echo "ERROR: hooks/tests/ 配下に *.bats が見つかりません (hooks/tests の消失か、find の失敗)。" >&2
        exit 1
    fi
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$REPO_ROOT/.githooks/scripts/test_report/bats/run.sh" "${test_files[@]}"
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

    # 各ファイルは一時ディレクトリ・ポート・監査記録を @test の中に閉じているので、bats の --jobs で並べて動かす (#1225)。
    echo "==> pecotv release 単体テスト (scripts/release/tests/ 配下の *.bats を、find | sort の順に bats で実行)"
    PUBLISH_TEST="$PECOTV_PLUGIN_ROOT/scripts/release/tests/publish-mcp-dist.bats"
    mapfile -t release_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/release/tests" -name '*.bats' ! -path "$PUBLISH_TEST" | LC_ALL=C sort)
    if [ ! -f "$PUBLISH_TEST" ] || [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に publish-mcp-dist.bats とほかの *.bats が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    # publish が共通で使う attach-mcp-tgz.sh と mcp-publish-common.sh のテストも、このレーンで実行する。
    release_test_files+=("$REPO_ROOT/.githooks/scripts/tests/attach-mcp-tgz.bats")
    release_test_files+=("$REPO_ROOT/.githooks/scripts/tests/mcp-publish-common.bats")
    # publish の setup_file は CPU を使い切らないので、ほかのファイルと同時に動かす。ログは publish を後に出す。
    publish_log="$(mktemp)"
    # 止められたときに publish の子を残さないよう、別のプロセスグループで起こし、cleanup がグループごと止める。
    set -m
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$REPO_ROOT/.githooks/scripts/test_report/bats/run.sh" "$PUBLISH_TEST" > "$publish_log" 2>&1 &
    publish_pid=$!
    set +m
    trap 'exit 130' INT
    trap 'exit 143' TERM
    release_rc=0
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$REPO_ROOT/.githooks/scripts/test_report/bats/run.sh" "${release_test_files[@]}" || release_rc=$?
    wait "$publish_pid" || release_rc=$?
    publish_pid=""
    trap - INT TERM
    cat "$publish_log"
    rm -f "$publish_log"
    [ "$release_rc" -eq 0 ] || exit "$release_rc"
fi

if [ "$RUN_COMPARE" = true ]; then
    # pptx 前後比較 (#1073) は cli/dist を使う。nx 経由で重ねて build すると、並行する test-cli の dist を消す。
    if [ "$SKIP_SHARED" = false ] && [ "$RUN_CLI" = false ]; then
        echo "==> $PNPM --filter @pecot/pecotv-cli run build (pptx 比較スクリプト用の cli/dist)"
        # shellcheck disable=SC2086
        ( cd "$PECOTV_PLUGIN_ROOT" && $PNPM --filter @pecot/pecotv-cli run build )
    fi

    # page-compare (#1341) は cli/dist を使わないが、同じレーンで一緒に動かす。
    echo "==> pecotv pptx-compare / page-compare 単体テスト (各 tests/ 配下の *.bats を、find | sort の順に bats で実行)"
    for compare_tests_dir in pptx-compare page-compare; do
        if [ -z "$(find "$PECOTV_PLUGIN_ROOT/scripts/$compare_tests_dir/tests" -name '*.bats' 2> /dev/null)" ]; then
            echo "ERROR: scripts/$compare_tests_dir/tests/ 配下に *.bats が見つかりません (消失か、find の失敗)。" >&2
            exit 1
        fi
    done
    mapfile -t compare_test_files < <(find "$PECOTV_PLUGIN_ROOT/scripts/pptx-compare/tests" "$PECOTV_PLUGIN_ROOT/scripts/page-compare/tests" -name '*.bats' | LC_ALL=C sort)
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$REPO_ROOT/.githooks/scripts/test_report/bats/run.sh" "${compare_test_files[@]}"
fi

if [ "$RUN_SKILLS" = true ]; then
    # スキル配布ドキュメント（SKILL.md / agents / references の DESIGN.md）の静的確認。
    echo "==> pecotv skills 静的確認 (scripts/ci/tests/ 配下の *.bats を、find | sort の順に bats で実行)"
    mapfile -t skills_test_files < <(find "$SCRIPT_DIR/tests" -name '*.bats' | LC_ALL=C sort)
    if [ "${#skills_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/ci/tests/ 配下に *.bats が見つかりません (消失か、find の失敗)。" >&2
        exit 1
    fi
    PECOT_REPORT_RESULTS="$PECOT_REPORT_RESULTS" bash "$REPO_ROOT/.githooks/scripts/test_report/bats/run.sh" "${skills_test_files[@]}"
fi

echo "pecotv all checks passed"
