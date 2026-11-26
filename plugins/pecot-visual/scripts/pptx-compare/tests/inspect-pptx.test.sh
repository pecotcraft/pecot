#!/bin/bash
# inspect-pptx.mjs を確かめる (#1139)。make-fixture.mjs の inspect 用 variant（base の 2 slide に slide 3 以降を足したもの）を使う。
# 枚ごと・deck 全体の集計値、複数入力の欠損セル、Markdown / JSON の出力、exit code を見る。cli/dist は build 済みが前提。
set -u

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPARE_DIR/../../../.." && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
INSPECT="$COMPARE_DIR/inspect-pptx.mjs"
MAKE_FIXTURE="$SCRIPT_DIR/make-fixture.mjs"

GIT_STATUS_BEFORE="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"

# Markdown の「### <title>」節（次の見出しまで）に該当行があることを確かめる。
expect_section_line() {
    local label="$1" file="$2" title="$3" line="$4"
    local section
    section="$(awk -v heading="### $title" '
        $0 == heading { inside = 1; next }
        inside && /^#/ { exit }
        inside { print }
    ' "$file")"
    if printf '%s\n' "$section" | grep -qxF -- "$line"; then
        bt_pass "$label"
    else
        bt_fail "$label" "「### $title」節に無い行: '$line'"$'\n'"$section"
    fi
}
# 「## 全体集計」の表に該当行があることを確かめる。
expect_deck_line() {
    local label="$1" file="$2" line="$3"
    local section
    section="$(awk '$0 == "## 全体集計" { inside = 1; next } inside && /^#/ { exit } inside { print }' "$file")"
    if printf '%s\n' "$section" | grep -qxF -- "$line"; then
        bt_pass "$label"
    else
        bt_fail "$label" "全体集計に無い行: '$line'"$'\n'"$section"
    fi
}
# JSON ファイルに対して JS 式を評価し、結果（JSON.stringify）を返す。式の中では `j` が parse 結果。
json_eval() {
    local file="$1" expression="$2"
    node -e '
        const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
        process.stdout.write(JSON.stringify(eval(process.argv[2])))
    ' "$file" "$expression"
}
expect_json() {
    local label="$1" file="$2" expression="$3" expected="$4"
    bt_eq "$label" "$expected" "$(json_eval "$file" "$expression" 2>&1)"
}
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

# 合成の失敗はテストの前提崩れなので、即座に落とす。
make_fixture() {
    local variant="$1"
    if ! node "$MAKE_FIXTURE" "$variant" "$TMP/$variant.pptx"; then
        echo "ERROR: fixture 合成に失敗: $variant"
        exit 1
    fi
}

# 引数をそのまま inspect-pptx.mjs に渡す。
# stdout を $TMP/<label>.stdout、stderr を $TMP/<label>.stderr に残して、exit code を返す。
run_inspect() {
    local label="$1"
    shift
    node "$INSPECT" "$@" > "$TMP/$label.stdout" 2> "$TMP/$label.stderr"
    echo "$?"
}

for variant in base full-image table-frame css-raster-pic prst-mix timing; do
    make_fixture "$variant"
done

# --- 1. 新 variant を 1 本ずつ集計し、slide 3（以降）の値を JSON で固定する ---
for variant in full-image table-frame css-raster-pic prst-mix timing; do
    RC="$(run_inspect "$variant" "$TMP/$variant.pptx" --json "$TMP/$variant.json")"
    bt_eq "$variant: exit 0" "0" "$RC"
    expect_no_stacktrace "$variant: stderr にスタックトレースが無い" "$TMP/$variant.stderr"
done

S3='j.files[0].slides[2]'
S4='j.files[0].slides[3]'
DECK='j.files[0].deck'

# 背景 blip だけで spTree が空の枚（slide 3）と、p:sldSz と同寸の pic の枚（slide 4）。
F="$TMP/full-image.json"
expect_json "full-image: 枚数 4" "$F" "$DECK.slideCount" '4'
expect_json "full-image: slide 3 は背景 blip あり" "$F" "$S3.backgroundBlip" 'true'
expect_json "full-image: slide 3 は sp / pic / graphicFrame が 0" "$F" \
    "[$S3.spCount, $S3.picCount, $S3.graphicFrame]" '[0,0,{"table":0,"chart":0,"other":0}]'
expect_json "full-image: slide 3 は全面画像（背景のみ）" "$F" \
    "[$S3.fullImage, $S3.fullImageReason]" '[true,"background-only"]'
expect_json "full-image: slide 3 の画像参照は非 svg 1 件 14 バイト" "$F" "$S3.images" \
    '{"raster":{"count":1,"bytes":14},"svg":{"count":0,"bytes":0}}'
expect_json "full-image: slide 4 は背景 blip なし" "$F" "$S4.backgroundBlip" 'false'
expect_json "full-image: slide 4 は全面画像（全面 pic）" "$F" \
    "[$S4.fullImage, $S4.fullImageReason, $S4.picCount]" '[true,"full-size-pic",1]'
expect_json "full-image: base の slide は全面画像でない" "$F" \
    'j.files[0].slides.slice(0, 2).map((s) => s.fullImage)' '[false,false]'
expect_json "full-image: 2 枚が同じ part を参照しても一意 media は 1 件" "$F" "$DECK.uniqueMedia" \
    '{"raster":{"count":1,"bytes":14},"svg":{"count":0,"bytes":0},"parts":["ppt/media/image2.png"]}'
expect_json "full-image: 全面画像の枚数 2" "$F" "$DECK.fullImageSlideCount" '2'

# a:tbl を持つ graphicFrame の枚。a:t は sp 1 + 表セル 3（空セルは a:t なし）。
F="$TMP/table-frame.json"
expect_json "table-frame: graphicFrame の分類 table 1 / chart 1 / その他 1" "$F" "$S3.graphicFrame" \
    '{"table":1,"chart":1,"other":1}'
expect_json "table-frame: a:t は sp と表セルの合計 4" "$F" "$S3.textRunCount" '4'
expect_json "table-frame: sp 1 / テキストあり sp 1 / pic 0" "$F" \
    "[$S3.spCount, $S3.textSpCount, $S3.picCount]" '[1,1,0]'

# descr が Rendered as an image because of CSS <reason> の pic と svgBlip 付きの pic。
F="$TMP/css-raster-pic.json"
expect_json "css-raster-pic: pic 4" "$F" "$S3.picCount" '4'
expect_json "css-raster-pic: descr reason 別の件数" "$F" "$S3.cssRasterReasons" '{"clip-path":1,"filter":2}'
expect_json "css-raster-pic: 画像参照は非 svg と svg を分けて数える" "$F" "$S3.images" \
    '{"raster":{"count":1,"bytes":14},"svg":{"count":1,"bytes":41}}'
expect_json "css-raster-pic: base の slide は descr reason なし" "$F" \
    'j.files[0].slides[0].cssRasterReasons' '{}'

# prstGeom が rect / roundRect / line 混在で custGeom 1 つ。a:latin / a:ea を 2 run に持つ。
F="$TMP/prst-mix.json"
expect_json "prst-mix: prstGeom 種別別件数" "$F" "$S3.prstGeom" '{"line":1,"rect":2,"roundRect":1}'
expect_json "prst-mix: custGeom 1" "$F" "$S3.custGeomCount" '1'
expect_json "prst-mix: sp 5 / テキストあり sp 3 / a:t 3" "$F" \
    "[$S3.spCount, $S3.textSpCount, $S3.textRunCount]" '[5,3,3]'
expect_json "prst-mix: typeface 一覧" "$F" "$DECK.typefaces" \
    '{"latin":{"Inter":2},"ea":{"Noto Sans JP":2}}'

# p:timing あり。
F="$TMP/timing.json"
expect_json "timing: slide 3 は p:timing あり" "$F" "$S3.timing" 'true'
expect_json "timing: base の slide は p:timing なし" "$F" \
    'j.files[0].slides.slice(0, 2).map((s) => s.timing)' '[false,false]'
expect_json "timing: p:timing を持つ枚数 1" "$F" "$DECK.timingSlideCount" '1'

# base の値（#1062 baseline の collectMetrics とは別定義だが、base では同じ値になる）。
RC="$(run_inspect base "$TMP/base.pptx" --json "$TMP/base.json")"
bt_eq "base: exit 0" "0" "$RC"
F="$TMP/base.json"
expect_json "base: 枚順と part 名" "$F" 'j.files[0].slides.map((s) => [s.index, s.part])' \
    '[[1,"ppt/slides/slide1.xml"],[2,"ppt/slides/slide2.xml"]]'
expect_json "base: slide 1 の sp 3 / テキストあり sp 2 / a:t 2 / pic 1" "$F" \
    'const s = j.files[0].slides[0]; [s.spCount, s.textSpCount, s.textRunCount, s.picCount]' '[3,2,2,1]'
expect_json "base: 埋め込みフォント part 3 件" "$F" "$DECK.embeddedFonts.count" '3'
if grep -qxF '# pptx 集計' "$TMP/base.stdout"; then
    bt_pass "base: --out 省略時は Markdown を stdout に出す（見出しがある）"
else
    bt_fail "base: --out 省略時は Markdown を stdout に出す（見出しがある）" "stdout に「# pptx 集計」が無い"
fi

# --- 2. 3 本入力で枚数が違う（2 / 3 / 4 枚）: 欠損セルは `-` ---
RC="$(run_inspect multi "$TMP/base.pptx" "$TMP/timing.pptx" "$TMP/full-image.pptx" \
    --out "$TMP/multi.md" --json "$TMP/multi.json")"
bt_eq "3 本入力: exit 0" "0" "$RC"
expect_no_stacktrace "3 本入力: stderr にスタックトレースが無い" "$TMP/multi.stderr"
bt_eq "3 本入力: --out 指定時は stdout に出さない" "" "$(cat "$TMP/multi.stdout")"
M="$TMP/multi.md"
expect_deck_line "3 本入力: 全体集計の枚数行（列 = 入力）" "$M" "| 枚数 | 2 | 3 | 4 |"
expect_deck_line "3 本入力: 全体集計の p:timing 枚数行" "$M" "| \`p:timing\` を持つ枚数 | 0 | 1 | 0 |"
expect_deck_line "3 本入力: 全体集計の全面画像の枚数" "$M" "| 全面画像の枚数 | 0 | 0 | 2 |"
expect_section_line "3 本入力: part 名の 3 枚目は A が欠損" "$M" "part 名" \
    "| 3 | - | ppt/slides/slide3.xml | ppt/slides/slide3.xml |"
expect_section_line "3 本入力: part 名の 4 枚目は A / B が欠損" "$M" "part 名" \
    "| 4 | - | - | ppt/slides/slide4.xml |"
expect_section_line "3 本入力: p:sp 数の 3 枚目" "$M" "\`p:sp\` 数" "| 3 | - | 1 | 0 |"
expect_section_line "3 本入力: p:timing の 3 枚目" "$M" "\`p:timing\`" "| 3 | - | あり | なし |"
expect_section_line "3 本入力: 背景 blip の 3 枚目" "$M" "背景 blip" "| 3 | - | なし | あり |"
expect_section_line "3 本入力: 全面画像の 3 枚目" "$M" "全面画像" "| 3 | - | なし | 背景のみ |"
expect_section_line "3 本入力: 全面画像の 4 枚目" "$M" "全面画像" "| 4 | - | - | 全面 pic |"
expect_section_line "3 本入力: 画像参照 非 svg の 4 枚目" "$M" "画像参照 非 svg（件 / バイト）" \
    "| 4 | - | - | 1 / 14 |"
expect_section_line "3 本入力: 1 枚目は全入力にある" "$M" "\`p:pic\` 数" "| 1 | 1 | 1 | 1 |"
J="$TMP/multi.json"
expect_json "3 本入力 JSON: files[] は入力順で 3 件" "$J" \
    'j.files.map((f) => [f.label, f.path.split("/").pop(), f.deck.slideCount])' \
    '[["A","base.pptx",2],["B","timing.pptx",3],["C","full-image.pptx",4]]'
expect_json "3 本入力 JSON: slides[] の件数は入力ごとの枚数" "$J" 'j.files.map((f) => f.slides.length)' '[2,3,4]'

# --- 3. 異常系: exit 2 ---
RC="$(run_inspect noargs)"
bt_eq "引数なし: exit 2" "2" "$RC"
NOARGS_STDERR="$(cat "$TMP/noargs.stderr")"
case "$NOARGS_STDERR" in
    *"usage: node inspect-pptx.mjs"*) bt_pass "引数なし: usage を stderr に出す" ;;
    *) bt_fail "引数なし: usage を stderr に出す" "actual: $NOARGS_STDERR" ;;
esac
expect_no_stacktrace "引数なし: スタックトレースが無い" "$TMP/noargs.stderr"

RC="$(run_inspect absent "$TMP/base.pptx" "$TMP/no-such.pptx")"
bt_eq "不在ファイル: exit 2" "2" "$RC"
ABSENT_STDERR="$(cat "$TMP/absent.stderr")"
case "$ABSENT_STDERR" in
    *"no-such.pptx"*) bt_pass "不在ファイル: パスを stderr に出す" ;;
    *) bt_fail "不在ファイル: パスを stderr に出す" "actual: $ABSENT_STDERR" ;;
esac
expect_no_stacktrace "不在ファイル: スタックトレースが無い" "$TMP/absent.stderr"

echo "not a zip" > "$TMP/broken.pptx"
RC="$(run_inspect broken "$TMP/broken.pptx")"
bt_eq "zip でないファイル: exit 2" "2" "$RC"
expect_no_stacktrace "zip でないファイル: スタックトレースが無い" "$TMP/broken.stderr"

RC="$(run_inspect badout "$TMP/base.pptx" --out "$TMP/no-such-dir/out.md")"
bt_eq "--out の書き込み失敗: exit 2" "2" "$RC"
RC="$(run_inspect badjson "$TMP/base.pptx" --json "$TMP/no-such-dir/out.json")"
bt_eq "--json の書き込み失敗: exit 2" "2" "$RC"
expect_no_stacktrace "--json の書き込み失敗: スタックトレースが無い" "$TMP/badjson.stderr"

# --- 4. 作業ツリーへ出力を残さない（plugins/pecot-visual 配下、実行前後の差分無し） ---
GIT_STATUS_AFTER="$(git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual)"
bt_eq "作業ツリーに新たな変更を残さない (plugins/pecot-visual 配下、実行前後の差分無し)" \
    "$GIT_STATUS_BEFORE" "$GIT_STATUS_AFTER"

bt_finish
