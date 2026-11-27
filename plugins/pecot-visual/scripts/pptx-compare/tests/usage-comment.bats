# pptx-compare の先頭スクリプトの冒頭コメント（先頭の /** */）に、使い方の見出しが残っていることを確かめる (#1073 / #1139)。

COMPARE_DIR="$BATS_TEST_DIRNAME/.."

setup() {
    bats_load_library pecot-bats
}

# $1=スクリプト名（COMPARE_DIR 直下）。先頭の /** ... */ ブロックだけを取り出す（本体のコメントや文字列を拾わないため）。
header_of() {
    awk '/^\/\*\*/ { inblock = 1 } inblock { print } /\*\// && inblock { exit }' "$COMPARE_DIR/$1"
}

# $1=スクリプト名 $2...=必要な見出し（`# ` 付き）
assert_headings() {
    local name="$1"
    shift
    local header heading
    header="$(header_of "$name")"
    [ -n "$header" ] || fail "$name の先頭に、/** で始まるコメントブロックが無い"
    for heading in "$@"; do
        run grep -F -- "$heading" <<< "$header"
        assert_success
    done
}

@test "compare-pptx.mjs の冒頭コメントに、使い方の見出しが残っている" {
    explains "\`compare-pptx.mjs\` の先頭のコメントブロックを読むテストです。コメントがあり、before と after の取り方・判定基準・終了コードの見出しが存在することを確認します。"
    assert_headings compare-pptx.mjs "# before の取り方" "# after の取り方" "# 判定基準" "# exit code"
}

@test "inspect-pptx.mjs の冒頭コメントに、使い方の見出しが残っている" {
    explains "\`inspect-pptx.mjs\` の先頭のコメントブロックを読むテストです。コメントがあり、集計の定義・出力・終了コードの見出しが存在することを確認します。"
    assert_headings inspect-pptx.mjs "# 集計の定義" "# 出力" "# exit code"
}
