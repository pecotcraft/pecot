#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PLUGIN_ROOT}"

# --scope で実行範囲を絞る（nx のレーン pecot-workflow:test-<scope> から呼ぶ）。引数なしは全部。
#   cli / bootstrap / hooks / skills / release。hooks は vitest の hooks project を、通常の環境と空の設定の環境で 2 回流して比べる。
# env PECOT_WORKFLOW_SKIP_INSTALL=1: install を飛ばす（nx 経由では pecot-workflow:install が 1 回だけ流す）。
# 本ファイルや lock を足したら、nx.json の pecotPluginTestGlobals か pecotPluginNodeInputs に足す。
# CLAUDE_PLUGIN_DATA は一時ディレクトリに固定し、bin/pecot 経由のテストが導入先のデータ置き場を触らないようにする。
unset PLUGIN_DATA PECOT_BOOTSTRAP_SKIP PECOT_BOOTSTRAP_FORCE
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"

SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=bootstrap | --scope=hooks | --scope=skills | --scope=release | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|bootstrap|hooks|skills|release|all)" >&2
            exit 1
            ;;
    esac
done

RUN_CLI=false
RUN_BOOTSTRAP=false
RUN_HOOKS=false
RUN_SKILLS=false
RUN_RELEASE=false
case "$SCOPE" in
    cli) RUN_CLI=true ;;
    bootstrap) RUN_BOOTSTRAP=true ;;
    hooks) RUN_HOOKS=true ;;
    skills) RUN_SKILLS=true ;;
    release) RUN_RELEASE=true ;;
    all) RUN_CLI=true; RUN_BOOTSTRAP=true; RUN_HOOKS=true; RUN_SKILLS=true; RUN_RELEASE=true ;;
esac

SKIP_INSTALL=false
if [ "${PECOT_WORKFLOW_SKIP_INSTALL:-0}" = "1" ]; then
    SKIP_INSTALL=true
fi

TMPDIRS=()
cleanup() {
    rm -rf "$GATE_PLUGIN_DATA"
    if [ "${#TMPDIRS[@]}" -gt 0 ]; then
        rm -rf "${TMPDIRS[@]}"
    fi
}
trap cleanup EXIT

# vitest の pass 2。pnpm は hoisted のため、vitest はリポジトリのルートの node_modules にある。
# usage: _run_vitest_pass2 <empty_dir> <junit_path>
_run_vitest_pass2() {
    local empty="$1" junit="$2"
    mkdir -p "$empty/.git" "$empty/tmp" \
        "$empty/xdg-config" "$empty/xdg-data" "$empty/xdg-cache"
    (
        cd "$PLUGIN_ROOT/cli" &&
        env -i \
            PATH="$PATH" \
            LANG=C.UTF-8 \
            TMPDIR="$empty/tmp" \
            HOME="$empty" \
            XDG_CONFIG_HOME="$empty/xdg-config" \
            XDG_DATA_HOME="$empty/xdg-data" \
            XDG_CACHE_HOME="$empty/xdg-cache" \
            CLAUDE_PROJECT_DIR="$empty" \
            GIT_DIR="$empty/.git" \
            GIT_CONFIG_GLOBAL=/dev/null \
            GIT_CONFIG_SYSTEM=/dev/null \
            node "$PLUGIN_ROOT/../../node_modules/vitest/vitest.mjs" run --project hooks \
                --outputFile.junit="$junit"
    )
}

# Node 側（cli/）は repo root の 1 つの pnpm workspace に属する。
# pnpm 起動コマンドの解決は bin/_lib.sh (resolve_pnpm) を使う。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）。
# nx 経由では scripts/ci/install.sh（pecot-workflow:install target）が実行済み。
if [ "$RUN_CLI" = true ] || [ "$RUN_HOOKS" = true ] || [ "$RUN_SKILLS" = true ]; then
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
    if [ "$SKIP_INSTALL" = false ]; then
        echo "==> $PNPM install --frozen-lockfile (cwd=$PLUGIN_ROOT/../..)"
        # shellcheck disable=SC2086
        ( cd "$PLUGIN_ROOT/../.." && $PNPM install --frozen-lockfile )
        echo "==> bash $PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
        bash "$PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
    fi
fi

if [ "$RUN_CLI" = true ]; then
    # nx 経由では pecot-workflow:build-cli target が build を 1 push 1 回だけ実行する。
    # vitest は src を直接読むため、build は要らない。
    echo "==> $PNPM --filter @pecot/pecot-workflow-cli run test (cli: vitest run --coverage、閾値判定)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run test )
fi

if [ "$RUN_BOOTSTRAP" = true ]; then
    # run.sh は、実 pnpm でミラーを build する CUJ。
    # data-dir.sh は、データ置き場の解決順。manifest.sh は、登録ファイルの整合。
    # install-record.sh は、stub pnpm でミラーを作り直す条件と世代削除を確かめる。
    for script in run.sh data-dir.sh manifest.sh install-record.sh; do
        echo "==> bash cli/tests/bootstrap/$script"
        bash "$PLUGIN_ROOT/cli/tests/bootstrap/$script"
    done
fi

if [ "$RUN_HOOKS" = true ]; then
    V_TMP2=$(mktemp -d); TMPDIRS+=("$V_TMP2")
    V_EMPTY=$(mktemp -d); TMPDIRS+=("$V_EMPTY")

    V_PASS1_RC=0
    V_PASS2_RC=0
    V_CMP_RC=0

    # vitest も 2 回流す。1 回目の JUnit は、古い合格を残さないよう先に消す。
    V_JUNIT1="$PLUGIN_ROOT/cli/test-results/junit-hooks.xml"
    rm -f "$V_JUNIT1"
    echo "==> hooks vitest pass 1 (project hooks)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run test:hooks ) || V_PASS1_RC=$?

    echo "==> hooks vitest pass 2 (empty config + GIT_DIR export)"
    _run_vitest_pass2 "$V_EMPTY" "$V_TMP2/junit.xml" || V_PASS2_RC=$?

    echo "==> compare JUnit XML (hooks vitest pass1 vs pass2)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT/cli" && $PNPM exec tsx scripts/compare-junit.ts "$V_JUNIT1" "$V_TMP2/junit.xml" ) || V_CMP_RC=$?

    if [ "$V_PASS1_RC" -ne 0 ] || [ "$V_PASS2_RC" -ne 0 ] || [ "$V_CMP_RC" -ne 0 ]; then
        echo "ERROR: hooks tests failed (vitest pass1=$V_PASS1_RC pass2=$V_PASS2_RC compare=$V_CMP_RC)" >&2
        exit 1
    fi
fi

if [ "$RUN_SKILLS" = true ]; then
    # skills のテスト。本文のツール名・入力名の確認と、w-onboarding のスクリプトのテストを vitest で流す。
    # w-onboarding のスクリプトのテストは OS 判定で WSL/macOS のケースが skip される、環境依存系。
    # 単発で実行する（hooks のような 2 パス + compare は適用しない）。
    V_JUNIT_SKILLS="$PLUGIN_ROOT/cli/test-results/junit-skills.xml"
    rm -f "$V_JUNIT_SKILLS"
    echo "==> skills vitest (project skills)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run test:skills )
fi

if [ "$RUN_RELEASE" = true ]; then
    # テストは publish を --skip-build で流すので、cli/dist が要る。
    if [ ! -d "$PLUGIN_ROOT/cli/dist" ]; then
        echo "ERROR: $PLUGIN_ROOT/cli/dist がありません。先に build してください（nx では pecot-workflow:build-cli）。" >&2
        exit 1
    fi
    mapfile -t release_test_files < <(find "$PLUGIN_ROOT/scripts/release/tests" -name '*.test.sh' | LC_ALL=C sort)
    if [ "${#release_test_files[@]}" -eq 0 ]; then
        echo "ERROR: scripts/release/tests/ 配下に *.test.sh が見つかりません (消失 or find 失敗の疑い)。" >&2
        exit 1
    fi
    for test_file in "${release_test_files[@]}"; do
        echo "==> bash $test_file"
        bash "$test_file"
    done
fi

echo "all checks passed"
