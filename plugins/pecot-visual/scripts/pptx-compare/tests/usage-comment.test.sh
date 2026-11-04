#!/bin/bash
# pptx-compare の先頭スクリプトの冒頭コメントの静的チェック (#1073 / #1139)。
#
# 依存更新・変換手順の比較のたびに使うスクリプトなので、
# 使い方が本体と同じファイルに残っていることを固定する。
# チェック対象は、各スクリプトの先頭の 1 ブロック目のコメント。
# スクリプトごとに必要な見出しを持つこと。必要な見出しは次のとおり。
#   - compare-pptx.mjs: 「before の取り方」「after の取り方」「判定基準」「exit code」
#   - inspect-pptx.mjs: 「集計の定義」「出力」「exit code」
#
# `set -e` は使わない: チェック結果を握って PASS / FAIL を集計するため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# $1=スクリプト名（COMPARE_DIR 直下） $2...=必要な見出し（`# ` 付き）
check_headings() {
    local name="$1"
    shift
    local header="$TMP/$name.header.txt"
    # 先頭の /** ... */ ブロックだけを取り出す（本体のコメントや文字列を拾わないため）。
    awk '/^\/\*\*/ { inblock = 1 } inblock { print } /\*\// && inblock { exit }' \
        "$COMPARE_DIR/$name" > "$header"

    if [ -s "$header" ]; then
        pass "$name の先頭にコメントブロックがある"
    else
        fail "$name の先頭にコメントブロックがある"
    fi

    local heading
    for heading in "$@"; do
        if grep -qF -- "$heading" "$header"; then
            pass "$name の冒頭コメントに見出し「${heading#\# }」がある"
        else
            fail "$name の冒頭コメントに見出し「${heading#\# }」がある"
        fi
    done
}

check_headings compare-pptx.mjs "# before の取り方" "# after の取り方" "# 判定基準" "# exit code"
check_headings inspect-pptx.mjs "# 集計の定義" "# 出力" "# exit code"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
