#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PLUGIN_ROOT}/cli"

# --scope で実行範囲を絞る。
# nx のレーン（pecot-workflow:lint-py / lint-cli）から呼び分けるためのパラメータ化。
#   --scope=py  : cli の ruff + pyright（pecot-workflow:lint-py）。
#   --scope=cli : cli-node の tsc / eslint / knip（pecot-workflow:lint-cli）。
#   --scope=all : 両方。
#   引数なし    : 全部（手動実行用の既定）。
# lint scope を増やす際は project.json の lint-* target と本ファイルの case 文を両方更新すること。
# lock / manifest / 本 CI スクリプト・python-version.sh を追加・改名した際は、nx.json にも追記すること。
# 追記先は pecotPluginLintGlobals。Node 側は pecotPluginNodeInputs に追記する。
# JSON はコメントを書けないため、この保守注意は本ファイルに残す。
#
# env PECOT_WORKFLOW_SKIP_INSTALL=1: Node 側の install を飛ばす。
# nx 経由（lint-cli target）専用のスイッチ。install は nx の別 target（pecot-workflow:install）が、dependsOn 経由で 1 push 1 回だけ実行する (#1080)。
# env 無しの手動実行は、本スクリプトが install を行う。
SCOPE="all"
for arg in "$@"; do
    case "$arg" in
        --scope=py | --scope=cli | --scope=all)
            SCOPE="${arg#--scope=}"
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=py|cli|all)" >&2
            exit 1
            ;;
    esac
done

RUN_PY=false
RUN_CLI=false
case "$SCOPE" in
    py) RUN_PY=true ;;
    cli) RUN_CLI=true ;;
    all) RUN_PY=true; RUN_CLI=true ;;
esac

SCRIPT_SKIP_INSTALL=false
if [ "${PECOT_WORKFLOW_SKIP_INSTALL:-0}" = "1" ]; then
    SCRIPT_SKIP_INSTALL=true
fi

# --python には、run-tests.sh と共有の python-version.sh の PY を使う。
# 異なると、片方が venv を作り直す間に他方が実行中の venv を壊す。
# 同時 sync は uv が排他する（venv 作成は lock_project_environment、導入は <venv>/.lock）ので安全。
# shellcheck source=python-version.sh
source "${SCRIPT_DIR}/python-version.sh"

if [ "$RUN_PY" = true ]; then
    if ! command -v uv &>/dev/null; then
        echo "ERROR: plugins/pecot-workflow/ lint 実行に uv が必要です (nx lint target / pre-commit フック nx-affected-lint)。" >&2
        echo "  インストール: https://docs.astral.sh/uv/getting-started/installation/" >&2
        exit 1
    fi

    if ! command -v npx &>/dev/null; then
        echo "ERROR: pyright の実行に Node/npx が必要です (plugins/pecot-workflow/ の nx lint target / pre-commit フック)。" >&2
        echo "  インストール: https://nodejs.org/ または nvm 等で Node.js を導入してください。" >&2
        exit 1
    fi

    # run-tests.sh と同じ venv（cli/.venv）を使う。PY は上で source した python-version.sh の値。
    uv sync --locked --quiet --python "$PY" || {
        echo "ERROR: cli/uv.lock が pyproject.toml と食い違うか、sync に失敗しました。修正手順: cd plugins/pecot-workflow/cli && uv lock (個別の版だけ上げるなら uv lock --upgrade-package <pkg>)" >&2
        exit 1
    }
    # ruff は uv.lock の版で実行する。版未固定の uvx だと pre-commit の rev と判定がずれる (#1220)
    uv run --no-sync ruff check commands core templates tests __init__.py __main__.py --config pyproject.toml
    uv run --no-sync ruff format --check commands core templates tests __init__.py __main__.py --config pyproject.toml || {
        echo "ERROR: format ずれを検出。修正コマンド: cd plugins/pecot-workflow/cli && uv run ruff format ." >&2
        exit 1
    }
    # 明示 path を渡すため pyproject の [tool.pyright] include は上書きされる（exclude は有効）。
    # テスト・.venv 等を巻き込まないよう、ソースサブツリーと compare_junit を明示列挙する。
    # npm 11 は、cwd から上へたどって見つけた package.json が pnpm を宣言していると npx も止める（plugin ルートが該当する）。
    # そのため cwd を / にして呼ぶ。設定は --project で cli/ を指し、パスと --pythonpath は絶対パスで渡す。
    CLI_DIR="$PWD"
    ( cd / && npx --yes pyright@1.1.410 --project "$CLI_DIR" --pythonpath "$CLI_DIR/.venv/bin/python" \
        "$CLI_DIR/commands" "$CLI_DIR/core" "$CLI_DIR/templates" "$CLI_DIR/__init__.py" "$CLI_DIR/__main__.py" "$PLUGIN_ROOT/scripts/ci/compare_junit.py" )
fi

# Node 側（cli-node/）は repo root の 1 つの pnpm workspace に属する。
# pnpm 起動コマンドの解決は bin/_lib.sh (resolve_pnpm) を使う。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）。
if [ "$RUN_CLI" = true ]; then
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
    # nx run-commands は子プロセスへ FORCE_COLOR=true を注入する。除去して、直接実行と挙動をそろえる。
    unset FORCE_COLOR
    if [ "$SCRIPT_SKIP_INSTALL" = false ]; then
        echo "==> $PNPM install --frozen-lockfile (cwd=$PLUGIN_ROOT/../..)"
        # shellcheck disable=SC2086
        ( cd "$PLUGIN_ROOT/../.." && $PNPM install --frozen-lockfile )
        echo "==> bash $PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
        bash "$PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
    fi
    # tsc --noEmit → eslint → knip
    echo "==> $PNPM --filter @pecot/pecot-workflow-cli run lint"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run lint )
fi
