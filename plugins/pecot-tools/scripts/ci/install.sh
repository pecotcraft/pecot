#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-tools/)
PLUGIN_ROOT="$PWD"

# 依存の導入と scripts の package manager 自己呼び出しガード (#1217)。run-tests.sh を env 無しで打ったときと同じ処理・ログを保つ。

# corepack の `packageManager` 初回 fetch 時の Y/n プロンプトを抑止する（自動取得）。
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# nx run-commands が注入する FORCE_COLOR は、nx 経由と直接実行で挙動を割る。
unset FORCE_COLOR

# shellcheck source=pnpm-lib.sh
. "$PLUGIN_ROOT/scripts/ci/pnpm-lib.sh"

PNPM="$(resolve_pnpm "$PLUGIN_ROOT")"
if [ -z "$PNPM" ]; then
    echo "ERROR: pnpm / corepack / npx not found. Install Node.js 24.22.1+ in the 24.x line or 26.12.1+ (npm and npx are bundled) and retry." >&2
    HINT="$(pnpm_resolution_hint "$PLUGIN_ROOT")"
    [ -n "$HINT" ] && echo "  $HINT" >&2
    exit 1
fi

# リポジトリは root の 1 つの pnpm workspace。依存の導入は repo root での frozen の install 1 回で済む。
# nx の install target では、root の project の install が導入を担う。本スクリプトは手動実行用で、同じ処理を行う。
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
# `$PNPM` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
echo "==> $PNPM install --frozen-lockfile (cwd=$REPO_ROOT)"
# shellcheck disable=SC2086
( cd "$REPO_ROOT" && $PNPM install --frozen-lockfile )

# scripts の package manager 自己呼び出しガード (#1217)。手動実行（run-tests.sh）と同じ検証を呼ぶ。
echo "==> bash $PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
bash "$PLUGIN_ROOT/scripts/ci/check-pm-scripts.sh"
