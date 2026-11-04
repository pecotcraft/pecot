#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # プラグインルート (= plugins/pecot-workflow/)
PLUGIN_ROOT="$PWD"

# scripts が package manager を自己呼び出ししていないことを確認する (#1217)。
# pnpm 12 が packageManager の版を @pnpm/exe で起動すると、$npm_execpath が ELF を指して失敗する。
# 検証関数の定義は pecot-visual 側の pm-guard-lib.sh にある（複製しない）。
# 違反は fail() で数えて、最後に失敗で終える。
PM_GUARD_LIB="$PLUGIN_ROOT/../pecot-visual/scripts/ci/pm-guard-lib.sh"
if [ ! -f "$PM_GUARD_LIB" ]; then
    echo "ERROR: 共有の検証関数がありません: $PM_GUARD_LIB" >&2
    exit 1
fi
# shellcheck source=../../../pecot-visual/scripts/ci/pm-guard-lib.sh
. "$PM_GUARD_LIB"

SCRIPTS_FAIL=0
fail() {
    echo "  NG: $1" >&2
    SCRIPTS_FAIL=$((SCRIPTS_FAIL + 1))
}

echo "==> pm-guard: scripts が package manager を呼んでいないこと (pecot-workflow)"
check_plugin_scripts_pm_free "$PLUGIN_ROOT" pecot-workflow
if [ "$SCRIPTS_FAIL" -ne 0 ]; then
    echo "pm-guard: pecot-workflow の scripts の検証 FAILED ($SCRIPTS_FAIL 件)" >&2
    exit 1
fi
echo "  OK: pecot-workflow の scripts は package manager を呼ばない"
