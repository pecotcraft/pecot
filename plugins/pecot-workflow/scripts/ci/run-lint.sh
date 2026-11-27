#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PLUGIN_ROOT}"

# --scope で実行範囲を絞る（nx のレーン pecot-workflow:lint-cli から呼ぶ）。cli は tsc / eslint / knip と、スキルの scripts/*.cjs の eslint。引数なしは全部。
# env PECOT_WORKFLOW_SKIP_INSTALL=1: install と lib の build を飛ばす。
#   nx 経由では、pecot-workflow:install と workflow-core:build が 1 回だけ流す。
# 本ファイルや lock を足したら、nx.json の pecotPluginNodeInputs に足す。
for arg in "$@"; do
    case "$arg" in
        --scope=cli | --scope=all)
            ;;
        *)
            echo "ERROR: 未対応の引数: $arg (使用可能: --scope=cli|all)" >&2
            exit 1
            ;;
    esac
done

SCRIPT_SKIP_INSTALL=false
if [ "${PECOT_WORKFLOW_SKIP_INSTALL:-0}" = "1" ]; then
    SCRIPT_SKIP_INSTALL=true
fi

# Node 側（cli/）は repo root の 1 つの pnpm workspace に属する。
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）。
# shellcheck source=pnpm-lib.sh
. "$PLUGIN_ROOT/scripts/ci/pnpm-lib.sh"
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
    # cli の tsc は @pecot/workflow-core の型を libs/workflow-core/dist から読むので、先に build する。
    echo "==> $PNPM --filter @pecot/workflow-core-src run build"
    # shellcheck disable=SC2086
    ( cd "$PLUGIN_ROOT/../.." && $PNPM --filter @pecot/workflow-core-src run build )
fi
# tsc --noEmit → eslint → knip
echo "==> $PNPM --filter @pecot/pecot-workflow-cli run lint"
# shellcheck disable=SC2086
( cd "$PLUGIN_ROOT" && $PNPM --filter @pecot/pecot-workflow-cli run lint )
# スキルの scripts/*.cjs。ESLint は設定のディレクトリの外を見ないので、プラグインのルートから別の設定で打つ
echo "==> $PNPM exec eslint --max-warnings=0 --config eslint.skills.config.mjs skills/*/scripts/*.cjs"
# shellcheck disable=SC2086
( cd "$PLUGIN_ROOT" && $PNPM exec eslint --max-warnings=0 --config eslint.skills.config.mjs 'skills/*/scripts/*.cjs' )
