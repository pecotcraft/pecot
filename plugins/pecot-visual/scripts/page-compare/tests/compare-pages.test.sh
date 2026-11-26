#!/bin/bash
# compare-pages.mjs を確かめる (#1341)。make-fixture.mjs の小さな PNG で、画素の一致・相違・寸法違い・片側欠けの判定を固定する。
# exit code と出力 Markdown の該当行の両方を見る。
set -u

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPARE_DIR/../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
COMPARE="$COMPARE_DIR/compare-pages.mjs"
MAKE_FIXTURE="$SCRIPT_DIR/make-fixture.mjs"

# 開発中の未コミット変更を汚染と誤検知しないよう、実行前後の `git status --porcelain` を比べる。
GIT_STATUS_BEFORE="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"

# 出力に該当行があることを確かめる。
expect_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        bt_pass "$label"
    else
        bt_fail "$label" "出力に無い行: '$line'"$'\n'"$(cat "$file")"
    fi
}
# 出力に該当行が無いことを確かめる。
expect_no_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        bt_fail "$label" "出力に余分な行: '$line'"
    else
        bt_pass "$label"
    fi
}
# stderr にスタックトレース（Node の未捕捉例外）が無いことを確かめる。
expect_no_stacktrace() {
    local label="$1" file="$2"
    if grep -qE '^\s+at ' "$file"; then
        bt_fail "$label" "stderr にスタックトレースがある:"$'\n'"$(cat "$file")"
    else
        bt_pass "$label"
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# variant の PNG を <dir>/<N>.png として合成する。合成の失敗は前提崩れなので即座に落とす。
put() {
    local variant="$1" path="$2"
    mkdir -p "$(dirname "$path")"
    if ! node "$MAKE_FIXTURE" "$variant" "$path"; then
        echo "ERROR: fixture 合成に失敗: $variant -> $path" >&2
        exit 1
    fi
}

# 比較して exit code を返し、Markdown を $TMP/<label>.md、stderr を $TMP/<label>.stderr に残す。
run_compare() {
    local label="$1" before="$2" after="$3"
    node "$COMPARE" "$before" "$after" --out "$TMP/$label.md" > /dev/null 2> "$TMP/$label.stderr"
    echo "$?"
}

# --- 1. 同一（2 ページ） ---
put base "$TMP/same/a/1.png"
put base "$TMP/same/a/2.png"
put base "$TMP/same/b/1.png"
put base "$TMP/same/b/2.png"
RC="$(run_compare same "$TMP/same/a" "$TMP/same/b")"
bt_eq "同一: exit 0" "0" "$RC"
expect_line "同一: 判定行" "$TMP/same.md" "結果: PASS（差のあるページはありません）"
expect_line "同一: 集計行" "$TMP/same.md" "- 対応ページ: 2 / before 固有: 0 / after 固有: 0"

# --- 2. バイト列は違うが画素は同一（tEXt 追加）。sha256 は不一致で、画素比較で一致する ---
put base "$TMP/meta/a/1.png"
put same "$TMP/meta/b/1.png"
RC="$(run_compare meta "$TMP/meta/a" "$TMP/meta/b")"
bt_eq "付加情報だけの違い: exit 0" "0" "$RC"
expect_line "付加情報だけの違い: 判定行" "$TMP/meta.md" "結果: PASS（差のあるページはありません）"

# --- 3. 1 画素差 ---
put base "$TMP/px/a/1.png"
put one-pixel "$TMP/px/b/1.png"
RC="$(run_compare px "$TMP/px/a" "$TMP/px/b")"
bt_eq "1 画素差: exit 1" "1" "$RC"
expect_line "1 画素差: 判定行" "$TMP/px.md" "結果: FAIL（差のあるページ 1 件）"
expect_line "1 画素差: 表の見出し" "$TMP/px.md" "| ページ | 差分画素 | 最初の座標 | 外接矩形 |"
expect_line "1 画素差: 表の行" "$TMP/px.md" "| 1 | 1 | (2,1) | (2,1)-(2,1) |"

# --- 4. 寸法違い ---
put base "$TMP/dim/a/1.png"
put size "$TMP/dim/b/1.png"
RC="$(run_compare dim "$TMP/dim/a" "$TMP/dim/b")"
bt_eq "寸法違い: exit 1" "1" "$RC"
expect_line "寸法違い: 判定行" "$TMP/dim.md" "結果: FAIL（差のあるページ 1 件）"
expect_line "寸法違い: 表の行" "$TMP/dim.md" "| 1 | 寸法 4x3 → 5x3 | - | - |"

# --- 5. 片側にしか無いページ ---
put base "$TMP/miss/a/1.png"
put base "$TMP/miss/a/3.png"
put base "$TMP/miss/a/5.png"
put base "$TMP/miss/b/1.png"
put base "$TMP/miss/b/7.png"
RC="$(run_compare miss "$TMP/miss/a" "$TMP/miss/b")"
bt_eq "片側欠け: exit 1" "1" "$RC"
expect_line "片側欠け: 集計行" "$TMP/miss.md" "- 対応ページ: 1 / before 固有: 2 / after 固有: 1"
expect_line "片側欠け: before だけ" "$TMP/miss.md" "- before だけのページ: 3, 5"
expect_line "片側欠け: after だけ" "$TMP/miss.md" "- after だけのページ: 7"
expect_no_line "欠け無し: 別掲行を出さない" "$TMP/same.md" "- before だけのページ:"

# --- 6. RGBA と RGB を比べる（alpha は比べる対象にしない） ---
put base "$TMP/rgba/a/1.png"
put rgba "$TMP/rgba/b/1.png"
RC="$(run_compare rgba "$TMP/rgba/a" "$TMP/rgba/b")"
bt_eq "rgba 対 rgb: exit 0" "0" "$RC"
expect_line "rgba 対 rgb: 判定行" "$TMP/rgba.md" "結果: PASS（差のあるページはありません）"

# --- 7. 対応外の PNG は exit 2 で、スタックトレースを出さない ---
for variant in interlace bit16; do
    put base "$TMP/$variant/a/1.png"
    put "$variant" "$TMP/$variant/b/1.png"
    RC="$(run_compare "$variant" "$TMP/$variant/a" "$TMP/$variant/b")"
    bt_eq "$variant: exit 2" "2" "$RC"
    expect_no_stacktrace "$variant: stderr にスタックトレース無し" "$TMP/$variant.stderr"
    if [ -s "$TMP/$variant.stderr" ]; then
        bt_pass "$variant: stderr に理由を出す"
    else
        bt_fail "$variant: stderr に理由を出す" "stderr が空"
    fi
done

# --- 8. 読めない PNG ---
mkdir -p "$TMP/broken/a" "$TMP/broken/b"
echo "not a png" > "$TMP/broken/a/1.png"
put base "$TMP/broken/b/1.png"
RC="$(run_compare broken "$TMP/broken/a" "$TMP/broken/b")"
bt_eq "読めない PNG: exit 2" "2" "$RC"
expect_no_stacktrace "読めない PNG: stderr にスタックトレース無し" "$TMP/broken.stderr"

# --- 9. 引数不正・ディレクトリ不在 ---
ARG_ERR="$(node "$COMPARE" "$TMP/same/a" 2>&1 > /dev/null)"
bt_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-pages.mjs"*) bt_pass "引数 1 個: usage を stderr に出す" ;;
    *) bt_fail "引数 1 個: usage を stderr に出す" "actual='$ARG_ERR'" ;;
esac
NODIR_ERR="$(node "$COMPARE" "$TMP/no-such-dir" "$TMP/same/b" 2>&1 > /dev/null)"
bt_eq "ディレクトリ不在: exit 2" "2" "$?"
expect_no_stacktrace "ディレクトリ不在: スタックトレース無し" <(echo "$NODIR_ERR")

# --- 10. --out 無しは stdout へ出す ---
STDOUT="$(node "$COMPARE" "$TMP/same/a" "$TMP/same/b" 2> /dev/null)"
bt_eq "stdout 出力: exit 0" "0" "$?"
case "$STDOUT" in
    *"結果: PASS（差のあるページはありません）"*) bt_pass "stdout 出力: 判定行がある" ;;
    *) bt_fail "stdout 出力: 判定行がある" "stdout に判定行が無い" ;;
esac

# --- 11. 作業ツリーへ出力を残さない ---
GIT_STATUS_AFTER="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"
bt_eq "作業ツリーに新たな変更を残さない (実行前後の差分無し)" \
    "$GIT_STATUS_BEFORE" "$GIT_STATUS_AFTER"

bt_finish
