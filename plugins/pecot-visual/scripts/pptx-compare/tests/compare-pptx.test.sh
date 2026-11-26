#!/bin/bash
# compare-pptx.mjs を確かめる (#1073)。make-fixture.mjs の小さな pptx で、非決定差が正規化で吸収され、実差分が判定と表に出ること。
# パート差分は exit code に載らないため、exit code と出力 Markdown の行の両方を見る。cli/dist は build 済みが前提。
set -u

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPARE_DIR/../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
COMPARE="$COMPARE_DIR/compare-pptx.mjs"
MAKE_FIXTURE="$SCRIPT_DIR/make-fixture.mjs"

# 元から dirty でもよいよう、実行前後の `git status --porcelain` を比べて、新たな変更が増えていないことだけを見る。
GIT_STATUS_BEFORE="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"

# 出力に該当行があることを確かめる（行そのものを期待値として渡す）。
expect_line() {
    local label="$1" file="$2" line="$3" summary
    if grep -qF -- "$line" "$file"; then
        bt_pass "$label"
    else
        summary="$(grep -E '^(結果|- \[[^]]*\]|- 生の sha256|- 正規化後|- ラスタ media|- 書体 part|- slide 数|- after だけ)' "$file")"
        bt_fail "$label" "出力に無い行: '$line'"$'\n'"判定・集計行:"$'\n'"$summary"
    fi
}
# stderr にスタックトレース（Node の未捕捉例外）が無いことを確かめる。`written: ...` 等の想定内メッセージは許容する。
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

# variant の pptx を合成する。合成自体の失敗はテストの前提崩れなので即座に落とす。
make_fixture() {
    local variant="$1"
    if ! node "$MAKE_FIXTURE" "$variant" "$TMP/$variant.pptx"; then
        echo "ERROR: fixture 合成に失敗: $variant"
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
bt_eq "同一: exit 0" "0" "$RC"
expect_line "同一: 機械判定が全て PASS" "$TMP/same.md" "結果: PASS（機械判定 5 項目すべて PASS）"
expect_line "同一: 差分のある slide なし" "$TMP/same.md" "差分のある slide はありません"
expect_line "同一: 生の相違 0" "$TMP/same.md" "- 生の sha256 相違: 0 件"
expect_line "同一: 正規化後の相違 0" "$TMP/same.md" "- 正規化後の相違: 0 件"
expect_line "同一: 消失 a:t 0" "$TMP/same.md" "- [PASS] before の \`a:t\` が after に全て残る: 消失 0 件"
expect_line "同一: 全体表に a:t 合計の行がある" "$TMP/same.md" "| \`a:t\` 合計 | 4 | 4 | 0 |"

# --- 2. 同一ファイル同士 ---
RC="$(run_compare self "$TMP/base.pptx" "$TMP/base.pptx")"
bt_eq "同一ファイル同士: exit 0" "0" "$RC"
expect_line "同一ファイル同士: 生の相違 0" "$TMP/self.md" "- 生の sha256 相違: 0 件"

# --- 3. 非決定差は生の相違として出て、正規化後は 0 になる ---
# $1=variant $2=期待する生の相違件数
expect_absorbed() {
    local variant="$1" raw="$2"
    local rc
    rc="$(run_compare "$variant" "$TMP/base.pptx" "$TMP/$variant.pptx")"
    bt_eq "非決定 $variant: exit 0" "0" "$rc"
    expect_line "非決定 $variant: 生の相違 $raw 件" "$TMP/$variant.md" "- 生の sha256 相違: $raw 件"
    expect_line "非決定 $variant: 正規化後の相違 0 件" "$TMP/$variant.md" "- 正規化後の相違: 0 件"
}
expect_absorbed xmlns-order 3
expect_absorbed cnvpr-id 2
expect_absorbed clip-id 1
expect_absorbed core-dates 1
expect_absorbed font-swap 3
expect_absorbed font-rename 2
expect_line "非決定 font-swap: 書体 part が両側同一" "$TMP/font-swap.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"
expect_line "非決定 font-rename: 改名は生の片側のみに出る" "$TMP/font-rename.md" \
    "- 生の sha256 相違: 2 件（一致 6 / before 固有 3 / after 固有 3）"
expect_line "非決定 font-rename: 書体 part が両側同一" "$TMP/font-rename.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"

# --- 4. 負例 g: フォント実体の取り違え（名前は同じで中身だけ違う） ---
RC="$(run_compare font-content "$TMP/base.pptx" "$TMP/font-content.pptx")"
bt_eq "負例 実体取り違え: exit 0（機械判定の対象外・要判断に出る）" "0" "$RC"
expect_line "負例 実体取り違え: 書体 part の多重集合が相違" "$TMP/font-content.md" \
    "- 書体 part の突合（sha256 多重集合）: 一致 2 / before 固有 1 / after 固有 1"
expect_line "負例 実体取り違え: 正規化後も presentation.xml と rels が相違" \
    "$TMP/font-content.md" "- 正規化後の相違: 2 件"

# --- 5. 負例 h: cNvPr の他属性（hidden）は正規化で消えない ---
RC="$(run_compare cnvpr-hidden "$TMP/base.pptx" "$TMP/cnvpr-hidden.pptx")"
bt_eq "負例 cNvPr hidden: exit 0（形状指標は動かない）" "0" "$RC"
expect_line "負例 cNvPr hidden: 正規化後の相違 1 件" "$TMP/cnvpr-hidden.md" "- 正規化後の相違: 1 件"
expect_line "負例 cNvPr hidden: 相違は slide xml" "$TMP/cnvpr-hidden.md" \
    "- \`ppt/slides/slide1.xml\`:"

# --- 6. 実差分 ---
RC="$(run_compare real-diff "$TMP/base.pptx" "$TMP/real-diff.pptx")"
bt_eq "実差分: exit 1" "1" "$RC"
expect_line "実差分: 消失 a:t 1 件" "$TMP/real-diff.md" \
    "- [FAIL] before の \`a:t\` が after に全て残る: 消失 1 件"
expect_line "実差分: 消失一覧に当該テキスト" "$TMP/real-diff.md" "セクション C"
expect_line "実差分: xfrm 差 1 件" "$TMP/real-diff.md" \
    "- [FAIL] テキスト一致 sp の \`xfrm\` 差が無い: xfrm 差 1 件"
expect_line "実差分: slide 2 の pic は 1 → 2" "$TMP/real-diff.md" "| 2 | 2 → 1 | 1 → 2 |"
expect_line "実差分: ラスタ media の相違 1 件" "$TMP/real-diff.md" "- ラスタ media の相違: 1 件"
expect_line "実差分: after だけの typeface" "$TMP/real-diff.md" "- after だけの typeface: Noto Sans JP"
expect_no_stacktrace "実差分: stderr にスタックトレース無し" "$TMP/real-diff.stderr"

# --- 6b. 負例 i: 対応する slide の p:pic 減少と、埋め込み typeface の消失 ---
RC="$(run_compare pic-typeface-drop "$TMP/base.pptx" "$TMP/pic-and-typeface-drop.pptx")"
bt_eq "pic/typeface 減少: exit 1" "1" "$RC"
expect_line "pic/typeface 減少: p:pic が減らない FAIL" "$TMP/pic-typeface-drop.md" \
    "- [FAIL] 対応する slide で \`p:pic\` が減らない: 減少した slide 1 件"
expect_line "pic/typeface 減少: 埋め込み typeface FAIL" "$TMP/pic-typeface-drop.md" \
    "- [FAIL] before の埋め込み typeface が after に全て残る: 消失 typeface 1 件"
expect_no_stacktrace "pic/typeface 減少: stderr にスタックトレース無し" "$TMP/pic-typeface-drop.stderr"

# --- 6c. 負例 j: normalizeClipIds は対象 3 文脈以外を正規化しない ---
# 対象は id 属性・url 参照・clip-path 属性。本文（a:t）の `clip_` を連番へ畳むと、正規化後の slide1.xml の相違が消える。
RC="$(run_compare clip-in-text "$TMP/clip-in-text-a.pptx" "$TMP/clip-in-text-b.pptx")"
bt_eq "本文の clip_ 文字列: exit 1（テキスト自体が別内容）" "1" "$RC"
expect_line "本文の clip_ 文字列: 過剰正規化されず正規化後も slide1.xml が相違" \
    "$TMP/clip-in-text.md" "- \`ppt/slides/slide1.xml\`:"

# --- 7. slide の増減（対応する slide だけで判定する） ---
RC="$(run_compare extra-slide "$TMP/base.pptx" "$TMP/extra-slide.pptx")"
bt_eq "slide 増減: exit 0" "0" "$RC"
expect_line "slide 増減: 対応 2 slide で判定" "$TMP/extra-slide.md" \
    "- slide 数: 2 → 3（対応 2 / before 固有 0 / after 固有 1）"
expect_line "slide 増減: after にだけある slide を別掲" "$TMP/extra-slide.md" \
    "- after にだけある slide: 3"

# --- 8. 引数不正 ---
ARG_ERR="$(node "$COMPARE" "$TMP/base.pptx" 2>&1 > /dev/null)"
bt_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-pptx.mjs"*) bt_pass "引数 1 個: usage を stderr に出す" ;;
    *) bt_fail "引数 1 個: usage を stderr に出す" "actual='$ARG_ERR'" ;;
esac

# --- 9. cli/dist 不在 ---
DIST_ERR="$(PECOTV_CLI_DIST="$TMP/no-such-dist" node "$COMPARE" "$TMP/base.pptx" "$TMP/base.pptx" 2>&1 > /dev/null)"
bt_eq "cli/dist 不在: exit 2" "2" "$?"
case "$DIST_ERR" in
    *"pnpm --filter @pecot/pecotv-cli run build"*) bt_pass "cli/dist 不在: build 手順を stderr に出す" ;;
    *) bt_fail "cli/dist 不在: build 手順を stderr に出す" "actual='$DIST_ERR'" ;;
esac

# --- 10. 読み取り失敗 ---
echo "not a zip" > "$TMP/broken.pptx"
node "$COMPARE" "$TMP/broken.pptx" "$TMP/base.pptx" > /dev/null 2>&1
bt_eq "pptx 読み取り失敗: exit 2" "2" "$?"

# --- 11. 作業ツリーへ出力を残さない（plugins/pecot-visual 配下全体を対象にする） ---
# 未コミットの変更は元からあり得るため、実行前後で差分が増えていないことを見る。
GIT_STATUS_AFTER="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"
bt_eq "作業ツリーに新たな変更を残さない (plugins/pecot-visual 配下、実行前後の差分無し)" \
    "$GIT_STATUS_BEFORE" "$GIT_STATUS_AFTER"

bt_finish
