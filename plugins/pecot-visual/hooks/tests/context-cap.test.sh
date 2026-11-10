#!/bin/bash
# lib/core/context-cap.sh の単体テスト（#225）。上限はバイト、行の途中では切らない。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib/core/context-cap.sh
. "$SCRIPT_DIR/../lib/core/context-cap.sh"

PASS=0
FAIL=0
check() {
    if [ "$2" = "$3" ]; then
        echo "PASS: $1"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $1 (expected='$2' actual='$3')"
        FAIL=$((FAIL + 1))
    fi
}

TEXT=$'aaaa\nbbbb\ncccc\ndddd'

cap_context 100 . lines <<<"$TEXT"
check "上限以下はそのまま返す" "$TEXT" "$CAPPED_BODY"
check "上限以下は CAP_NOTE が空" "" "$CAP_NOTE"

# 行間の改行も数える: 'aaaa\nbbbb' は 9 バイト
cap_context 9 . lines <<<"$TEXT"
check "行の途中で切らず、行間の改行も数える" $'aaaa\nbbbb' "$CAPPED_BODY"
check "残りの件数を書く" "Truncated at 9 bytes: 2 more lines not shown." "$CAP_NOTE"
cap_context 8 . lines <<<"$TEXT"
check "改行を数えると収まらない行は残さない" "aaaa" "$CAPPED_BODY"

# 末尾の改行は空の行として数えない
cap_context 19 . lines <<<"$TEXT"$'\n\n'
check "末尾の改行で切らない" "" "$CAP_NOTE"

# 件に合わない行は N に数えない
MIX=$'head\nV 1\nnoise\nV 2\nV 3'
cap_context 9 '^V' violations <<<"$MIX"
check "N は正規表現に合う行だけ数える" "Truncated at 9 bytes: 2 more violations not shown." "$CAP_NOTE"

# 日本語は 1 字 3 バイト
JA=$'あいう\nえおか'
cap_context 9 . lines <<<"$JA"
check "日本語の行を 3 バイトで数える" "あいう" "$CAPPED_BODY"
cap_context 19 . lines <<<"$JA"
check "日本語の 2 行が収まる上限なら切らない" "" "$CAP_NOTE"

# 1 行目だけで超えるときは、コードポイントの境目で上限まで切って残す
cap_context 7 . lines <<<$'あいうえお\nx'
check "1 行目だけで超えると上限まで切って残す" "あい" "$CAPPED_BODY"
check "1 行目を切ったときの N は残りの行" "Truncated at 7 bytes: 1 more lines not shown." "$CAP_NOTE"

# 同時に動く 2 組の本文の上限の和に、見出し・案内・字下げの余裕 1000 を足しても合計以下
check "layout と eslint の上限の和が合計以下" "yes" \
    "$([ $((PECOTV_CONTEXT_MAX_LAYOUT + PECOTV_CONTEXT_MAX_ESLINT + 1000)) -le "$PECOTV_CONTEXT_MAX_TOTAL" ] && echo yes || echo no)"
check "references と text-lint の上限の和が合計以下" "yes" \
    "$([ $((PECOTV_CONTEXT_MAX_REFERENCES + PECOTV_CONTEXT_MAX_TEXT_LINT + 1000)) -le "$PECOTV_CONTEXT_MAX_TOTAL" ] && echo yes || echo no)"

echo
echo "==================================="
echo "Passed: $PASS / Failed: $FAIL"
echo "==================================="
[ $FAIL -eq 0 ]
