#!/bin/bash
# compare-pages.mjs の検証 (#1341)。
#
# make-fixture.mjs が合成する小さな PNG で、画素の一致・相違・寸法違い・片側欠けの判定を固定する。
# assert は exit code と出力 Markdown の該当行の両方に対して行う。
#
# `set -e` は使わない: 負例で非ゼロ終了を意図的に発生させ、その exit code を assert するため。
set -u

# git hook 経由で起動されると、git が GIT_DIR などを export している。
# 作業ツリー汚染チェックの `git status` に影響するため、冒頭で捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPARE_DIR/../../../.." && pwd)"
COMPARE="$COMPARE_DIR/compare-pages.mjs"
MAKE_FIXTURE="$SCRIPT_DIR/make-fixture.mjs"

# 開発中の未コミット変更を汚染と誤検知しないよう、実行前後の `git status --porcelain` を比べる。
GIT_STATUS_BEFORE="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"

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
assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label (expected='$expected' actual='$actual')"
    fi
}
# 出力に該当行があることを assert する。
assert_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        pass "$label"
    else
        fail "$label (出力に無い行: '$line')"
        echo "--- $file ---"
        cat "$file"
    fi
}
# 出力に該当行が無いことを assert する。
assert_no_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        fail "$label (出力に余分な行: '$line')"
    else
        pass "$label"
    fi
}
# stderr にスタックトレース（Node の未捕捉例外）が無いことを assert する。
assert_no_stacktrace() {
    local label="$1" file="$2"
    if grep -qE '^\s+at ' "$file"; then
        fail "$label (stderr にスタックトレースがある)"
        cat "$file"
    else
        pass "$label"
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# variant の PNG を <dir>/<N>.png として合成する。合成の失敗は前提崩れなので即座に落とす。
put() {
    local variant="$1" path="$2"
    mkdir -p "$(dirname "$path")"
    if ! node "$MAKE_FIXTURE" "$variant" "$path"; then
        fail "fixture 合成に失敗: $variant -> $path"
        echo
        echo "PASS: $PASS / FAIL: $FAIL"
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
assert_eq "同一: exit 0" "0" "$RC"
assert_line "同一: 判定行" "$TMP/same.md" "結果: PASS（差のあるページはありません）"
assert_line "同一: 集計行" "$TMP/same.md" "- 対応ページ: 2 / before 固有: 0 / after 固有: 0"

# --- 2. バイト列は違うが画素は同一（tEXt 追加）。sha256 は不一致で、画素比較で一致する ---
put base "$TMP/meta/a/1.png"
put same "$TMP/meta/b/1.png"
RC="$(run_compare meta "$TMP/meta/a" "$TMP/meta/b")"
assert_eq "付加情報だけの違い: exit 0" "0" "$RC"
assert_line "付加情報だけの違い: 判定行" "$TMP/meta.md" "結果: PASS（差のあるページはありません）"

# --- 3. 1 画素差 ---
put base "$TMP/px/a/1.png"
put one-pixel "$TMP/px/b/1.png"
RC="$(run_compare px "$TMP/px/a" "$TMP/px/b")"
assert_eq "1 画素差: exit 1" "1" "$RC"
assert_line "1 画素差: 判定行" "$TMP/px.md" "結果: FAIL（差のあるページ 1 件）"
assert_line "1 画素差: 表の見出し" "$TMP/px.md" "| ページ | 差分画素 | 最初の座標 | 外接矩形 |"
assert_line "1 画素差: 表の行" "$TMP/px.md" "| 1 | 1 | (2,1) | (2,1)-(2,1) |"

# --- 4. 寸法違い ---
put base "$TMP/dim/a/1.png"
put size "$TMP/dim/b/1.png"
RC="$(run_compare dim "$TMP/dim/a" "$TMP/dim/b")"
assert_eq "寸法違い: exit 1" "1" "$RC"
assert_line "寸法違い: 判定行" "$TMP/dim.md" "結果: FAIL（差のあるページ 1 件）"
assert_line "寸法違い: 表の行" "$TMP/dim.md" "| 1 | 寸法 4x3 → 5x3 | - | - |"

# --- 5. 片側にしか無いページ ---
put base "$TMP/miss/a/1.png"
put base "$TMP/miss/a/3.png"
put base "$TMP/miss/a/5.png"
put base "$TMP/miss/b/1.png"
put base "$TMP/miss/b/7.png"
RC="$(run_compare miss "$TMP/miss/a" "$TMP/miss/b")"
assert_eq "片側欠け: exit 1" "1" "$RC"
assert_line "片側欠け: 集計行" "$TMP/miss.md" "- 対応ページ: 1 / before 固有: 2 / after 固有: 1"
assert_line "片側欠け: before だけ" "$TMP/miss.md" "- before だけのページ: 3, 5"
assert_line "片側欠け: after だけ" "$TMP/miss.md" "- after だけのページ: 7"
assert_no_line "欠け無し: 別掲行を出さない" "$TMP/same.md" "- before だけのページ:"

# --- 6. RGBA と RGB を比べる（alpha は比べる対象にしない） ---
put base "$TMP/rgba/a/1.png"
put rgba "$TMP/rgba/b/1.png"
RC="$(run_compare rgba "$TMP/rgba/a" "$TMP/rgba/b")"
assert_eq "rgba 対 rgb: exit 0" "0" "$RC"
assert_line "rgba 対 rgb: 判定行" "$TMP/rgba.md" "結果: PASS（差のあるページはありません）"

# --- 7. 対応外の PNG は exit 2 で、スタックトレースを出さない ---
for variant in interlace bit16; do
    put base "$TMP/$variant/a/1.png"
    put "$variant" "$TMP/$variant/b/1.png"
    RC="$(run_compare "$variant" "$TMP/$variant/a" "$TMP/$variant/b")"
    assert_eq "$variant: exit 2" "2" "$RC"
    assert_no_stacktrace "$variant: stderr にスタックトレース無し" "$TMP/$variant.stderr"
    if [ -s "$TMP/$variant.stderr" ]; then
        pass "$variant: stderr に理由を出す"
    else
        fail "$variant: stderr に理由を出す"
    fi
done

# --- 8. 読めない PNG ---
mkdir -p "$TMP/broken/a" "$TMP/broken/b"
echo "not a png" > "$TMP/broken/a/1.png"
put base "$TMP/broken/b/1.png"
RC="$(run_compare broken "$TMP/broken/a" "$TMP/broken/b")"
assert_eq "読めない PNG: exit 2" "2" "$RC"
assert_no_stacktrace "読めない PNG: stderr にスタックトレース無し" "$TMP/broken.stderr"

# --- 9. 引数不正・ディレクトリ不在 ---
ARG_ERR="$(node "$COMPARE" "$TMP/same/a" 2>&1 > /dev/null)"
assert_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-pages.mjs"*) pass "引数 1 個: usage を stderr に出す" ;;
    *) fail "引数 1 個: usage を stderr に出す (actual='$ARG_ERR')" ;;
esac
NODIR_ERR="$(node "$COMPARE" "$TMP/no-such-dir" "$TMP/same/b" 2>&1 > /dev/null)"
assert_eq "ディレクトリ不在: exit 2" "2" "$?"
assert_no_stacktrace "ディレクトリ不在: スタックトレース無し" <(echo "$NODIR_ERR")

# --- 10. --out 無しは stdout へ出す ---
STDOUT="$(node "$COMPARE" "$TMP/same/a" "$TMP/same/b" 2> /dev/null)"
assert_eq "stdout 出力: exit 0" "0" "$?"
case "$STDOUT" in
    *"結果: PASS（差のあるページはありません）"*) pass "stdout 出力: 判定行がある" ;;
    *) fail "stdout 出力: 判定行がある" ;;
esac

# --- 11. 作業ツリーへ出力を残さない ---
GIT_STATUS_AFTER="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"
assert_eq "作業ツリーに新たな変更を残さない (実行前後の差分無し)" \
    "$GIT_STATUS_BEFORE" "$GIT_STATUS_AFTER"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
