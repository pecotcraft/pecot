#!/bin/bash
# pptx-compare の先頭スクリプトの冒頭コメント（先頭の /** */）に、使い方の見出しが残っていることを確かめる (#1073 / #1139)。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1=スクリプト名（COMPARE_DIR 直下） $2...=必要な見出し（`# ` 付き）
expect_headings() {
    local name="$1"
    shift
    local header="$TMP/$name.header.txt"
    # 先頭の /** ... */ ブロックだけを取り出す（本体のコメントや文字列を拾わないため）。
    awk '/^\/\*\*/ { inblock = 1 } inblock { print } /\*\// && inblock { exit }' \
        "$COMPARE_DIR/$name" > "$header"

    if [ -s "$header" ]; then
        bt_pass "$name の先頭にコメントブロックがある"
    else
        bt_fail "$name の先頭にコメントブロックがある" "/** で始まるブロックが無い"
    fi

    local heading
    for heading in "$@"; do
        if grep -qF -- "$heading" "$header"; then
            bt_pass "$name の冒頭コメントに見出し「${heading#\# }」がある"
        else
            bt_fail "$name の冒頭コメントに見出し「${heading#\# }」がある" "見つからない"
        fi
    done
}

expect_headings compare-pptx.mjs "# before の取り方" "# after の取り方" "# 判定基準" "# exit code"
expect_headings inspect-pptx.mjs "# 集計の定義" "# 出力" "# exit code"

bt_finish
