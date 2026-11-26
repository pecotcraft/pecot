#!/bin/bash
# check-pm-guard.sh の PECOTV_PM_GUARD_BEHAVIOR による挙動確認の切り替えを確かめる (#1080)。
# npm / yarn / pnpm を含まない PATH で起動し、挙動確認を即 SKIP させて見出しの有無だけを見る。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$CI_DIR/check-pm-guard.sh"

# 挙動確認の見出し。check-pm-guard.sh が出す文字列と同一にする。
BEHAVIOR_HEADING="check-pm-guard: 挙動確認"
STATIC_HEADING="check-pm-guard: 静的確認"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 静的確認に必要な外部コマンドだけを集めた PATH を作る（npm / yarn / pnpm は入れない）。
TOOLS_BIN="$TMP/bin"
mkdir -p "$TOOLS_BIN"
for tool in bash dirname basename node awk grep sed cat mktemp rm cp find sort timeout git; do
    src="$(command -v "$tool" 2>/dev/null)"
    [ -n "$src" ] && ln -s "$src" "$TOOLS_BIN/$tool"
done
if [ ! -e "$TOOLS_BIN/node" ]; then
    echo "ERROR: node が PATH に無いため check-pm-guard.sh の静的確認を起動できない" >&2
    exit 1
fi

# $1 = PECOTV_PM_GUARD_BEHAVIOR の値（空文字なら未設定で起動）。出力を stdout へ、終了コードをそのまま返す。
run_guard() {
    local behavior="$1"
    if [ -z "$behavior" ]; then
        env -u PECOTV_PM_GUARD_BEHAVIOR PATH="$TOOLS_BIN" bash "$GUARD" 2>&1
    else
        env PECOTV_PM_GUARD_BEHAVIOR="$behavior" PATH="$TOOLS_BIN" bash "$GUARD" 2>&1
    fi
}

# --- ケース 1: 未設定 → 静的確認 + 挙動確認の両方 -----------------------------

out="$(run_guard "")"
rc=$?
bt_eq "未設定: exit 0 で終わる" 0 "$rc"
bt_contains "未設定: 静的確認をする" "$STATIC_HEADING" "$out"
bt_contains "未設定: 挙動確認をする" "$BEHAVIOR_HEADING" "$out"

# --- ケース 2: =1 → 両方（明示指定でも未設定と同じ） --------------------------

out="$(run_guard 1)"
rc=$?
bt_eq "=1: exit 0 で終わる" 0 "$rc"
bt_contains "=1: 静的確認をする" "$STATIC_HEADING" "$out"
bt_contains "=1: 挙動確認をする" "$BEHAVIOR_HEADING" "$out"

# --- ケース 3: =0 → 静的確認のみ ---------------------------------------------

out="$(run_guard 0)"
rc=$?
bt_eq "=0: exit 0 で終わる" 0 "$rc"
bt_contains "=0: 静的確認をする" "$STATIC_HEADING" "$out"
bt_not_contains "=0: 挙動確認の見出しが出ない" "$BEHAVIOR_HEADING" "$out"
bt_contains "=0: skip の理由をログに出す" "PECOTV_PM_GUARD_BEHAVIOR=0" "$out"

bt_finish
