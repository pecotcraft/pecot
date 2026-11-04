#!/bin/bash
# compare-pptx.mjs の検証 (#1073)。
#
# make-fixture.mjs が合成する小さな pptx で、非決定差が正規化で吸収されること・
# 実差分が判定と表に出ることを固定する。assert は exit code と出力 Markdown の
# 該当行の両方に対して行う（パート差分は exit code に載らないため）。
#
# 前提: cli/dist が build 済みであること。build 自体は cli / compare レーンの責務で、
# run-tests.sh --scope=compare が事前に build する。
#
# `set -e` は使わない: 負例で非ゼロ終了を意図的に発生させ、その exit code を assert するため。
set -u

# git hook 経由 (pre-push の nx affected 等) で起動されると、git が GIT_DIR / GIT_INDEX_FILE を export している。
# これは作業ツリー汚染チェックの `git status` に影響しかねない。
# そのため、冒頭で捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPARE_DIR/../../../.." && pwd)"
COMPARE="$COMPARE_DIR/compare-pptx.mjs"
MAKE_FIXTURE="$SCRIPT_DIR/make-fixture.mjs"

# 開発中の未コミット変更（本テストの対象外）を汚染の誤検知にしないため、実行前後の
# `git status --porcelain` を比較する。fixture 合成・比較の実行が plugins/pecot-visual 配下に
# 新たな変更を増やしていないことだけを見る（作業ツリーが元から dirty でも良い）。
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
# 出力に該当行があることを assert する（行そのものを期待値として渡す）。
assert_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        pass "$label"
    else
        fail "$label (出力に無い行: '$line')"
        echo "--- $file の判定・集計行 ---"
        grep -E '^(結果|- \[[^]]*\]|- 生の sha256|- 正規化後|- ラスタ media|- 書体 part|- slide 数|- after だけ)' "$file"
    fi
}
# stderr にスタックトレース（Node の未捕捉例外）が無いことを assert する。
# `written: ...` 等の想定内メッセージは許容する。
assert_no_stacktrace() {
    local label="$1" file="$2"
    if grep -qE '^\s+at ' "$file"; then
        fail "$label (stderr にスタックトレースがある)"
        echo "--- $file ---"
        cat "$file"
    else
        pass "$label"
    fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# variant の pptx を合成する。合成自体の失敗はテストの前提崩れなので即座に落とす。
make_fixture() {
    local variant="$1"
    if ! node "$MAKE_FIXTURE" "$variant" "$TMP/$variant.pptx"; then
        fail "fixture 合成に失敗: $variant"
        echo
        echo "PASS: $PASS / FAIL: $FAIL"
        exit 1
    fi
}

# before / after を比較し、exit code を返しつつ Markdown を $TMP/<label>.md、
# stderr を $TMP/<label>.stderr に残す。
run_compare() {
    local label="$1" before="$2" after="$3"
    node "$COMPARE" "$before" "$after" --out "$TMP/$label.md" > /dev/null 2> "$TMP/$label.stderr"
    echo "$?"
}

make_fixture base
for variant in xmlns-order cnvpr-id clip-id core-dates font-swap font-rename \
    font-content cnvpr-hidden real-diff extra-slide pic-and-typeface-drop \
    clip-in-text-a clip-in-text-b; do
    make_fixture "$variant"
done

# --- 1. 同一（同じ変換を 2 回合成した pptx。zip のバイト列は mtime で変わる） ---
node "$MAKE_FIXTURE" base "$TMP/base-again.pptx"
RC="$(run_compare same "$TMP/base.pptx" "$TMP/base-again.pptx")"
assert_eq "同一: exit 0" "0" "$RC"
assert_line "同一: 機械判定が全て PASS" "$TMP/same.md" "結果: PASS（機械判定 5 項目すべて PASS）"
assert_line "同一: 差分のある slide なし" "$TMP/same.md" "差分のある slide はありません"
assert_line "同一: 生の相違 0" "$TMP/same.md" "- 生の sha256 相違: 0 件"
assert_line "同一: 正規化後の相違 0" "$TMP/same.md" "- 正規化後の相違: 0 件"
assert_line "同一: 消失 a:t 0" "$TMP/same.md" "- [PASS] before の \`a:t\` が after に全て残る: 消失 0 件"
assert_line "同一: 全体表に a:t 合計の行がある" "$TMP/same.md" "| \`a:t\` 合計 | 4 | 4 | 0 |"

# --- 2. 同一ファイル同士 ---
RC="$(run_compare self "$TMP/base.pptx" "$TMP/base.pptx")"
assert_eq "同一ファイル同士: exit 0" "0" "$RC"
assert_line "同一ファイル同士: 生の相違 0" "$TMP/self.md" "- 生の sha256 相違: 0 件"

# --- 3. 非決定差は生の相違として出て、正規化後は 0 になる ---
# $1=variant $2=期待する生の相違件数
assert_absorbed() {
    local variant="$1" raw="$2"
    local rc
    rc="$(run_compare "$variant" "$TMP/base.pptx" "$TMP/$variant.pptx")"
    assert_eq "非決定 $variant: exit 0" "0" "$rc"
    assert_line "非決定 $variant: 生の相違 $raw 件" "$TMP/$variant.md" "- 生の sha256 相違: $raw 件"
    assert_line "非決定 $variant: 正規化後の相違 0 件" "$TMP/$variant.md" "- 正規化後の相違: 0 件"
}
assert_absorbed xmlns-order 3
assert_absorbed cnvpr-id 2
assert_absorbed clip-id 1
assert_absorbed core-dates 1
assert_absorbed font-swap 3
assert_absorbed font-rename 2
assert_line "非決定 font-swap: 書体 part が両側同一" "$TMP/font-swap.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"
assert_line "非決定 font-rename: 改名は生の片側のみに出る" "$TMP/font-rename.md" \
    "- 生の sha256 相違: 2 件（一致 6 / before 固有 3 / after 固有 3）"
assert_line "非決定 font-rename: 書体 part が両側同一" "$TMP/font-rename.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"

# --- 4. 負例 g: フォント実体の取り違え（名前は同じで中身だけ違う） ---
RC="$(run_compare font-content "$TMP/base.pptx" "$TMP/font-content.pptx")"
assert_eq "負例 実体取り違え: exit 0（機械判定の対象外・要判断に出る）" "0" "$RC"
assert_line "負例 実体取り違え: 書体 part の多重集合が相違" "$TMP/font-content.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 2 / before 固有 1 / after 固有 1"
assert_line "負例 実体取り違え: 正規化後も presentation.xml と rels が相違" \
    "$TMP/font-content.md" "- 正規化後の相違: 2 件"

# --- 5. 負例 h: cNvPr の他属性（hidden）は正規化で消えない ---
RC="$(run_compare cnvpr-hidden "$TMP/base.pptx" "$TMP/cnvpr-hidden.pptx")"
assert_eq "負例 cNvPr hidden: exit 0（形状指標は動かない）" "0" "$RC"
assert_line "負例 cNvPr hidden: 正規化後の相違 1 件" "$TMP/cnvpr-hidden.md" "- 正規化後の相違: 1 件"
assert_line "負例 cNvPr hidden: 相違は slide xml" "$TMP/cnvpr-hidden.md" \
    "- \`ppt/slides/slide1.xml\`:"

# --- 6. 実差分 ---
RC="$(run_compare real-diff "$TMP/base.pptx" "$TMP/real-diff.pptx")"
assert_eq "実差分: exit 1" "1" "$RC"
assert_line "実差分: 消失 a:t 1 件" "$TMP/real-diff.md" \
    "- [FAIL] before の \`a:t\` が after に全て残る: 消失 1 件"
assert_line "実差分: 消失一覧に当該テキスト" "$TMP/real-diff.md" "セクション C"
assert_line "実差分: xfrm 差 1 件" "$TMP/real-diff.md" \
    "- [FAIL] テキスト一致 sp の \`xfrm\` 差が無い: xfrm 差 1 件"
assert_line "実差分: slide 2 の pic は 1 → 2" "$TMP/real-diff.md" "| 2 | 2 → 1 | 1 → 2 |"
assert_line "実差分: ラスタ media の相違 1 件" "$TMP/real-diff.md" "- ラスタ media の相違: 1 件"
assert_line "実差分: after だけの typeface" "$TMP/real-diff.md" "- after だけの typeface: Noto Sans JP"
assert_no_stacktrace "実差分: stderr にスタックトレース無し" "$TMP/real-diff.stderr"

# --- 6b. 負例 i: 対応する slide の p:pic 減少と、埋め込み typeface の消失 ---
RC="$(run_compare pic-typeface-drop "$TMP/base.pptx" "$TMP/pic-and-typeface-drop.pptx")"
assert_eq "pic/typeface 減少: exit 1" "1" "$RC"
assert_line "pic/typeface 減少: p:pic が減らない FAIL" "$TMP/pic-typeface-drop.md" \
    "- [FAIL] 対応する slide で \`p:pic\` が減らない: 減少した slide 1 件"
assert_line "pic/typeface 減少: 埋め込み typeface FAIL" "$TMP/pic-typeface-drop.md" \
    "- [FAIL] before の埋め込み typeface が after に全て残る: 消失 typeface 1 件"
assert_no_stacktrace "pic/typeface 減少: stderr にスタックトレース無し" "$TMP/pic-typeface-drop.stderr"

# --- 6c. 負例 j: normalizeClipIds は対象 3 文脈以外を正規化しない ---
# 対象 3 文脈は、id 属性・url 参照・clip-path 属性。
# clip-in-text-a / -b は、本文（a:t）に別々の `clip_` 文字列を持つ。
# テキスト自体が別内容のため、機械判定は FAIL になる。
# ここで見るのは、正規化後のパート差分が消えないこと。
# 過剰正規化が起きていれば、出現順の連番へ畳まれて両者が同一になり、相違が消える。
RC="$(run_compare clip-in-text "$TMP/clip-in-text-a.pptx" "$TMP/clip-in-text-b.pptx")"
assert_eq "本文の clip_ 文字列: exit 1（テキスト自体が別内容）" "1" "$RC"
assert_line "本文の clip_ 文字列: 過剰正規化されず正規化後も slide1.xml が相違" \
    "$TMP/clip-in-text.md" "- \`ppt/slides/slide1.xml\`:"

# --- 7. slide の増減（対応する slide だけで判定する） ---
RC="$(run_compare extra-slide "$TMP/base.pptx" "$TMP/extra-slide.pptx")"
assert_eq "slide 増減: exit 0" "0" "$RC"
assert_line "slide 増減: 対応 2 slide で判定" "$TMP/extra-slide.md" \
    "- slide 数: 2 → 3（対応 2 / before 固有 0 / after 固有 1）"
assert_line "slide 増減: after にだけある slide を別掲" "$TMP/extra-slide.md" \
    "- after にだけある slide: 3"

# --- 8. 引数不正 ---
ARG_ERR="$(node "$COMPARE" "$TMP/base.pptx" 2>&1 > /dev/null)"
assert_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-pptx.mjs"*) pass "引数 1 個: usage を stderr に出す" ;;
    *) fail "引数 1 個: usage を stderr に出す (actual='$ARG_ERR')" ;;
esac

# --- 9. cli/dist 不在 ---
DIST_ERR="$(PECOTV_CLI_DIST="$TMP/no-such-dist" node "$COMPARE" "$TMP/base.pptx" "$TMP/base.pptx" 2>&1 > /dev/null)"
assert_eq "cli/dist 不在: exit 2" "2" "$?"
case "$DIST_ERR" in
    *"pnpm --filter @pecot/pecotv-cli run build"*) pass "cli/dist 不在: build 手順を stderr に出す" ;;
    *) fail "cli/dist 不在: build 手順を stderr に出す (actual='$DIST_ERR')" ;;
esac

# --- 10. 読み取り失敗 ---
echo "not a zip" > "$TMP/broken.pptx"
node "$COMPARE" "$TMP/broken.pptx" "$TMP/base.pptx" > /dev/null 2>&1
assert_eq "pptx 読み取り失敗: exit 2" "2" "$?"

# --- 11. 作業ツリーへ出力を残さない（plugins/pecot-visual 配下全体を対象にする） ---
# 開発中の未コミット変更は、テスト開始前から存在し得る。
# そのため、絶対的に空であることではなく、実行前後で差分が増えていないことを assert する。
GIT_STATUS_AFTER="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"
assert_eq "作業ツリーに新たな変更を残さない (plugins/pecot-visual 配下、実行前後の差分無し)" \
    "$GIT_STATUS_BEFORE" "$GIT_STATUS_AFTER"

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
