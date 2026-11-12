#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PLUGIN_ROOT}/cli"

# --scope で実行範囲を絞る。
# nx のレーン（pecot-workflow:test-<scope>）から呼び分けるためのパラメータ化。
#   --scope=py     : cli の pytest 2パス + compare のみ（pecot-workflow:test-py）。
#   --scope=cli    : cli-node の vitest（pecot-workflow:test-cli）。
#   --scope=hooks  : hooks の pytest 2パス + compare（pecot-workflow:test-hooks）。
#                    cli-node の vitest の hooks project も 2パス + compare で実行する。
#                    vitest の 2 回目も、pytest の pass 2 と同じ hermetic な環境で流す。
#   --scope=skills : skills のスクリプトテスト pytest 単発（pecot-workflow:test-skills）。
#   引数なし       : 全部（手動実行用の既定）。
# env PECOT_WORKFLOW_SKIP_INSTALL=1: Node 側の install を飛ばす。
# nx 経由（test-* target）専用のスイッチ。install は nx の別 target（pecot-workflow:install）が、dependsOn 経由で 1 push 1 回だけ実行する (#1080)。
# env 無しの手動実行は、本スクリプトが install を行う。
# lock / manifest / 本 CI スクリプト・python-version.sh を追加・改名した際は、nx.json の pecotPluginTestGlobals に追記すること。
# Node 側（cli-node/）の lock / manifest / スクリプトは pecotPluginNodeInputs に追記すること。
# plugins 外からテストが実行するスクリプト（.githooks 配下のガード等）は、消費するレーンの inputs（project.json の test-*）に追記すること。
# nx.json はルート共通設定のため、変更が全 project（pecotv 含む）を affected にする。
# JSON はコメントを書けないため、この保守注意は本ファイルに残す。
# 開発者の Claude セッションの子として動くと、クライアントが渡したデータ置き場を受け継ぐ。
# bin/pecot 経由のテストが導入先のデータ置き場を読み書きしないよう、CLAUDE_PLUGIN_DATA を一時ディレクトリに固定する。
# 空にするだけだと、隔離を忘れたテストが wrapper を呼んだとき実ホームの既定の場所に install してしまう。
# 既定の場所を確かめるテストは、自分で CLAUDE_PLUGIN_DATA を空にして起動する。
# pytest は conftest.py が CLAUDE_PLUGIN_DATA を別の一時ディレクトリへ向ける。
# XDG_DATA_HOME は付け替えない（uv の Python の置き場まで動くため）。
unset PLUGIN_DATA
GATE_PLUGIN_DATA="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$GATE_PLUGIN_DATA"

SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=py | --scope=cli | --scope=hooks | --scope=skills | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=py|cli|hooks|skills|all)" >&2
            exit 1
            ;;
    esac
done

RUN_PY=false
RUN_CLI=false
RUN_HOOKS=false
RUN_SKILLS=false
case "$SCOPE" in
    py) RUN_PY=true ;;
    cli) RUN_CLI=true ;;
    hooks) RUN_HOOKS=true ;;
    skills) RUN_SKILLS=true ;;
    all) RUN_PY=true; RUN_CLI=true; RUN_HOOKS=true; RUN_SKILLS=true ;;
esac

SKIP_INSTALL=false
if [ "${PECOT_WORKFLOW_SKIP_INSTALL:-0}" = "1" ]; then
    SKIP_INSTALL=true
fi

if [ "$RUN_PY" = true ] || [ "$RUN_HOOKS" = true ] || [ "$RUN_SKILLS" = true ]; then
    if ! command -v uv &>/dev/null; then
        echo "ERROR: plugins/pecot-workflow/ tests 実行に uv が必要です (nx test target / pre-push フック nx-affected-tests)。" >&2
        echo "  インストール: https://docs.astral.sh/uv/getting-started/installation/" >&2
        exit 1
    fi
fi

# テストは cli/uv.lock どおりの venv（cli/.venv）で動かす。
# lock と pyproject.toml が食い違うと `uv sync --locked` が落ちる（--frozen は食い違いを検出できない）。
# 各 pytest は `uv run --no-sync` で、この venv をそのまま使う。
# pass2 は空の UV_CACHE_DIR / XDG_* / HOME の env -i 配下でも、venv の python が絶対 symlink のため動く。
# PY は venv の interpreter で、pass1/pass2 の interpreter 非対称を排除するため 1 つに固定する。
# 値は run-lint.sh と共有の python-version.sh にある。
# pass2 は XDG_DATA_HOME を隔離するため managed Python が見えないが、venv は sync 時に作られているので影響しない。
# nx は lint と test の各レーンを並行させ、同じ cli/.venv へ同時に sync が動く。
# uv が排他する（venv 作成は lock_project_environment、導入は <venv>/.lock）ので安全。
# shellcheck source=python-version.sh
source "${SCRIPT_DIR}/python-version.sh"
# cli は Node 側だけを使うので、Python の venv は py / hooks / skills のときだけ用意する。
if [ "$RUN_PY" = true ] || [ "$RUN_HOOKS" = true ] || [ "$RUN_SKILLS" = true ]; then
    uv sync --locked --python "$PY" || {
        echo "ERROR: cli/uv.lock が pyproject.toml と食い違うか、sync に失敗しました。修正手順: cd plugins/pecot-workflow/cli && uv lock (個別の版だけ上げるなら uv lock --upgrade-package <pkg>)" >&2
        exit 1
    }
fi

# py / hooks 双方で一時ディレクトリ（pass1/pass2 junit・hermetic HOME）を使う。
# 各 scope の開始時に mktemp し、EXIT trap でまとめて掃除する。
TMPDIRS=()
cleanup() {
    rm -rf "$GATE_PLUGIN_DATA"
    if [ "${#TMPDIRS[@]}" -gt 0 ]; then
        rm -rf "${TMPDIRS[@]}"
    fi
}
trap cleanup EXIT

# pass2 用の hermetic env を構築して pytest を実行する共通ヘルパ。
# GIT_DIR を空リポへ export した pre-push 相当環境でも、汚染なく pass することを毎回確かめる（py / hooks で同一構成）。
# 第3引数 extra_opts は scope ごとの追加 pytest オプション（空文字可）。
# hooks scope は importlib（test_config_dispatcher のモジュール名衝突回避）を渡す。
# py scope は pythonpath=["cli"] の通常 import 構成のため空文字を渡す。
# usage: _run_pytest_pass2 <empty_dir> <junit_path> <extra_opts> <pytest_targets...>
_run_pytest_pass2() {
    local empty="$1" junit="$2" extra_opts="$3"
    shift 3
    mkdir -p "$empty/.git" "$empty/tmp" "$empty/uv-cache" \
        "$empty/xdg-config" "$empty/xdg-data" "$empty/xdg-cache"
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
        UV_CACHE_DIR="$empty/uv-cache" \
        uv run --no-sync pytest "$@" -q \
            --no-cov -p no:cacheprovider \
            -n auto \
            --tb=short \
            ${extra_opts:+$extra_opts} \
            --junitxml="$junit"
}

# vitest の pass 2。pnpm は hoisted のため、vitest はリポジトリのルートの node_modules にある。
# usage: _run_vitest_pass2 <empty_dir> <junit_path>
_run_vitest_pass2() {
    local empty="$1" junit="$2"
    mkdir -p "$empty/.git" "$empty/tmp" "$empty/uv-cache" \
        "$empty/xdg-config" "$empty/xdg-data" "$empty/xdg-cache"
    (
        cd "$PLUGIN_ROOT/cli-node" &&
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
            UV_CACHE_DIR="$empty/uv-cache" \
            node "$PLUGIN_ROOT/../../node_modules/vitest/vitest.mjs" run --project hooks \
                --outputFile.junit="$junit"
    )
}

# Node 側（cli-node/）は repo root の 1 つの pnpm workspace に属する。
# pnpm 起動コマンドの解決は bin/_lib.sh (resolve_pnpm) を使う。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）。
# nx 経由では scripts/ci/install.sh（pecot-workflow:install target）が実行済み。
if [ "$RUN_CLI" = true ] || [ "$RUN_HOOKS" = true ]; then
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

if [ "$RUN_PY" = true ]; then
    TMP1=$(mktemp -d); TMPDIRS+=("$TMP1")
    TMP2=$(mktemp -d); TMPDIRS+=("$TMP2")
    EMPTY=$(mktemp -d); TMPDIRS+=("$EMPTY")

    PASS1_RC=0
    PASS2_RC=0
    CMP_RC=0

    # pass 1 と pass 2 は独立した pytest 実行なので並行させる (#1080)。
    # `&` で起動して pid を保持し、wait で pass ごとの rc を個別に取る。
    #
    # nx run-commands 経由の実行では、nx が FORCE_COLOR を子プロセスへ注入する。
    # すると typer の help 出力が rich の色付きレンダリングに変わり、出力 assert のテストが落ちる。
    # FORCE_COLOR=true 単独で決定論的に再現する。
    # pass 2 は host env / cache 遮断目的の env -i により、結果的に FORCE_COLOR も除去される。
    # pass 1 は env -i を使わないため、色変数 (FORCE_COLOR) だけを選択的に除去する。
    # 実行方法が変わっても、結果は変わらない。
    #
    # COVERAGE_FILE: coverage のデータファイルは、何も指定しなければ cwd の `.coverage` になる。
    # 同じ cwd で別の pytest が動くと取り合いになり、`total of 0 is less than fail-under=80` で落ちる。
    # pass 1 専用の一時 dir へ隔離して、並行・並列 lane から独立させる。
    echo "==> pytest pass 1 (normal, parallel, with coverage) + pass 2 (empty config + GIT_DIR export, parallel)"
    env -u FORCE_COLOR COVERAGE_FILE="$TMP1/.coverage" uv run --no-sync pytest tests/ -q \
        -n auto \
        --cov=cli \
        --cov-report=term-missing \
        --cov-fail-under=80 \
        --junitxml="$TMP1/junit.xml" &
    PASS1_PID=$!

    # host env / cache を遮断した状態で同一テスト結果になるか検証 (test の hidden host dep を炙り出す)
    _run_pytest_pass2 "$EMPTY" "$TMP2/junit.xml" "" tests/ &
    PASS2_PID=$!

    wait "$PASS1_PID" || PASS1_RC=$?
    wait "$PASS2_PID" || PASS2_RC=$?

    # pass 1 の JUnit を、失敗した回も含めてリポに残す（nx の outputs と表示の入力）。
    # JUnit が無い回（pytest が JUnit を書く前に止まった等）は、古い「合格」を残さないよう消す。
    JUNIT_KEEP="$PLUGIN_ROOT/cli/test-results/junit.xml"
    mkdir -p "$(dirname "$JUNIT_KEEP")"
    if [ -f "$TMP1/junit.xml" ]; then
        cp "$TMP1/junit.xml" "$JUNIT_KEEP"
    else
        rm -f "$JUNIT_KEEP"
    fi

    echo "==> compare JUnit XML (pass1 vs pass2)"
    uv run --no-project --python "$PY" "$PLUGIN_ROOT/scripts/ci/compare_junit.py" "$TMP1/junit.xml" "$TMP2/junit.xml" || CMP_RC=$?

    if [ "$PASS1_RC" -ne 0 ] || [ "$PASS2_RC" -ne 0 ] || [ "$CMP_RC" -ne 0 ]; then
        echo "ERROR: pytest failed (pass1=$PASS1_RC pass2=$PASS2_RC compare=$CMP_RC)" >&2
        exit 1
    fi
fi

if [ "$RUN_CLI" = true ]; then
    # nx 経由では pecot-workflow:build-cli target が build を 1 push 1 回だけ実行する。
    # vitest は src を直接読むため、build は要らない。
    echo "==> $PNPM --filter @pecot/pecot-workflow-cli run test (cli: vitest run --coverage、閾値判定)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run test )
fi

if [ "$RUN_HOOKS" = true ]; then
    H_TMP1=$(mktemp -d); TMPDIRS+=("$H_TMP1")
    H_TMP2=$(mktemp -d); TMPDIRS+=("$H_TMP2")
    H_EMPTY=$(mktemp -d); TMPDIRS+=("$H_EMPTY")
    V_TMP2=$(mktemp -d); TMPDIRS+=("$V_TMP2")
    V_EMPTY=$(mktemp -d); TMPDIRS+=("$V_EMPTY")

    H_PASS1_RC=0
    H_PASS2_RC=0
    H_CMP_RC=0
    V_PASS1_RC=0
    V_PASS2_RC=0
    V_CMP_RC=0

    # --import-mode=importlib: test_config_dispatcher が hooks/tests と hooks/lib/tests に同名で存在するため必須。
    # pass 1 / pass 2 は並行させる (#1080)。
    echo "==> hooks pytest pass 1 (normal, parallel) + pass 2 (empty config + GIT_DIR export, parallel)"
    uv run --no-sync pytest "$PLUGIN_ROOT/hooks/" -q \
        --no-cov -p no:cacheprovider \
        -n auto \
        --import-mode=importlib \
        --junitxml="$H_TMP1/junit.xml" &
    H_PASS1_PID=$!

    _run_pytest_pass2 "$H_EMPTY" "$H_TMP2/junit.xml" --import-mode=importlib "$PLUGIN_ROOT/hooks/" &
    H_PASS2_PID=$!

    wait "$H_PASS1_PID" || H_PASS1_RC=$?
    wait "$H_PASS2_PID" || H_PASS2_RC=$?

    echo "==> compare JUnit XML (hooks pass1 vs pass2)"
    uv run --no-project --python "$PY" "$PLUGIN_ROOT/scripts/ci/compare_junit.py" "$H_TMP1/junit.xml" "$H_TMP2/junit.xml" || H_CMP_RC=$?

    # vitest も 2 回流す。1 回目の JUnit は、古い合格を残さないよう先に消す。
    V_JUNIT1="$PLUGIN_ROOT/cli-node/test-results/junit-hooks.xml"
    rm -f "$V_JUNIT1"
    echo "==> hooks vitest pass 1 (project hooks)"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run test:hooks ) || V_PASS1_RC=$?

    echo "==> hooks vitest pass 2 (empty config + GIT_DIR export)"
    _run_vitest_pass2 "$V_EMPTY" "$V_TMP2/junit.xml" || V_PASS2_RC=$?

    echo "==> compare JUnit XML (hooks vitest pass1 vs pass2)"
    uv run --no-project --python "$PY" "$PLUGIN_ROOT/scripts/ci/compare_junit.py" "$V_JUNIT1" "$V_TMP2/junit.xml" || V_CMP_RC=$?

    if [ "$H_PASS1_RC" -ne 0 ] || [ "$H_PASS2_RC" -ne 0 ] || [ "$H_CMP_RC" -ne 0 ] \
        || [ "$V_PASS1_RC" -ne 0 ] || [ "$V_PASS2_RC" -ne 0 ] || [ "$V_CMP_RC" -ne 0 ]; then
        echo "ERROR: hooks tests failed (pytest pass1=$H_PASS1_RC pass2=$H_PASS2_RC compare=$H_CMP_RC / vitest pass1=$V_PASS1_RC pass2=$V_PASS2_RC compare=$V_CMP_RC)" >&2
        exit 1
    fi
fi

if [ "$RUN_SKILLS" = true ]; then
    # skills のテスト。scripts/ci/tests/ の SKILL.md 構造テストと、skills/ 配下のスクリプトテストを実行する。
    # w-onboarding のスクリプトテストは OS 判定で WSL/macOS ケースが skip される環境依存系。
    # cli/hooks の pass1/pass2 2 パス + compare の host 非対称検証は適用せず、単発で実行する。
    echo "==> skills pytest (scripts/ci/tests/ と skills/)"
    uv run --no-sync pytest "$PLUGIN_ROOT/scripts/ci/tests/" "$PLUGIN_ROOT/skills/" -q \
        --no-cov -p no:cacheprovider \
        --import-mode=importlib
fi

echo "all checks passed"
