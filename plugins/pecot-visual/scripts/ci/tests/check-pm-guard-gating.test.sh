#!/bin/bash
# check-pm-guard.sh の挙動確認切り替え（env PECOTV_PM_GUARD_BEHAVIOR）を検証する (#1080)。
#
# 挙動確認は隔離 install を最大 5 回起動し、8〜26s かかる。
# ガードが守る対象は、package.json、.npmrc、pnpm-workspace.yaml、確認スクリプト自体。
# これらが push range で変わらない push では、pre-push フックが PECOTV_PM_GUARD_BEHAVIOR=0 を渡す。
# その場合は静的確認だけに絞る。
# 未設定のとき（手動実行とフォールバック）は両方を実行する。安全側に倒した既定とする。
#
# 本テスト自体が 8〜26s かかっては本末転倒なので、npm / yarn / pnpm を含まない最小 PATH で
# check-pm-guard.sh を起動する。
# run_behavior_check は見出しを出した直後に、`command -v npm` などで全て SKIP になる。
# そのため、見出しの有無だけを 1 秒未満で判定できる。
#
# `set -e` は使わない: 各ケースの exit code を握って評価を続けるため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GUARD="$CI_DIR/check-pm-guard.sh"

# 挙動確認の見出し。check-pm-guard.sh が出す文字列と同一にする。
BEHAVIOR_HEADING="check-pm-guard: 挙動確認"
STATIC_HEADING="check-pm-guard: 静的確認"

PASS=0
FAIL=0
fail() {
    echo "FAIL: $1"
    FAIL=$((FAIL + 1))
}
pass() {
    echo "PASS: $1"
    PASS=$((PASS + 1))
}

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
    echo "FAIL: node が PATH に無いため check-pm-guard.sh の静的確認を起動できない"
    exit 1
fi

# $1 = PECOTV_PM_GUARD_BEHAVIOR の値（空文字なら未設定で起動）。出力を stdout へ、
# 終了コードを関数の rc としてそのまま返す（呼び出し側は `$(...)` の直後に直前の終了ステータスを読む）。
run_guard() {
    local behavior="$1"
    if [ -z "$behavior" ]; then
        env -u PECOTV_PM_GUARD_BEHAVIOR PATH="$TOOLS_BIN" bash "$GUARD" 2>&1
    else
        env PECOTV_PM_GUARD_BEHAVIOR="$behavior" PATH="$TOOLS_BIN" bash "$GUARD" 2>&1
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) pass "$label" ;;
        *) fail "$label (出力に '$needle' が無い)" ;;
    esac
}

assert_not_contains() {
    local label="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*) fail "$label (出力に '$needle' が出ている)" ;;
        *) pass "$label" ;;
    esac
}

# --- ケース 1: 未設定 → 静的確認 + 挙動確認の両方 -----------------------------

out="$(run_guard "")"
rc=$?
[ "$rc" -eq 0 ] || fail "未設定: exit 0 で終わる (actual rc=$rc)"
assert_contains "未設定: 静的確認をする" "$STATIC_HEADING" "$out"
assert_contains "未設定: 挙動確認をする" "$BEHAVIOR_HEADING" "$out"

# --- ケース 2: =1 → 両方（明示指定でも未設定と同じ） --------------------------

out="$(run_guard 1)"
rc=$?
[ "$rc" -eq 0 ] || fail "=1: exit 0 で終わる (actual rc=$rc)"
assert_contains "=1: 静的確認をする" "$STATIC_HEADING" "$out"
assert_contains "=1: 挙動確認をする" "$BEHAVIOR_HEADING" "$out"

# --- ケース 3: =0 → 静的確認のみ ---------------------------------------------

out="$(run_guard 0)"
rc=$?
[ "$rc" -eq 0 ] || fail "=0: exit 0 で終わる (actual rc=$rc)"
assert_contains "=0: 静的確認をする" "$STATIC_HEADING" "$out"
assert_not_contains "=0: 挙動確認の見出しが出ない" "$BEHAVIOR_HEADING" "$out"
assert_contains "=0: skip の理由をログに出す" "PECOTV_PM_GUARD_BEHAVIOR=0" "$out"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
