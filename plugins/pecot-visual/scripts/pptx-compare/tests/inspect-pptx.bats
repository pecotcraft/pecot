# inspect-pptx.mjs を確かめる (#1139)。make-fixture.mjs の inspect 用 variant（base の 2 slide に slide 3 以降を足したもの）を使う。
# 枚ごと・deck 全体の集計値、複数入力の欠損セル、Markdown / JSON の出力、exit code を見る。cli/dist は build 済みが前提。

bats_require_minimum_version 1.5.0

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

COMPARE_DIR="$BATS_TEST_DIRNAME/.."
REPO_ROOT="$BATS_TEST_DIRNAME/../../../../.."
INSPECT="$COMPARE_DIR/inspect-pptx.mjs"
MAKE_FIXTURE="$BATS_TEST_DIRNAME/make-fixture.mjs"
S3='j.files[0].slides[2]'
S4='j.files[0].slides[3]'
DECK='j.files[0].deck'

setup() {
    bats_load_library pecot-bats
    FIX="$BATS_FILE_TMPDIR"
}

setup_file() {
    git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual > "$BATS_FILE_TMPDIR/git-status-before"
    local variant rc
    for variant in base full-image table-frame css-raster-pic prst-mix timing; do
        if ! node "$MAKE_FIXTURE" "$variant" "$BATS_FILE_TMPDIR/$variant.pptx"; then
            echo "ERROR: fixture 合成に失敗: $variant" >&2
            return 1
        fi
    done
    # 新 variant を 1 本ずつ集計し、終了コードと stderr を残す。
    for variant in full-image table-frame css-raster-pic prst-mix timing; do
        rc=0
        node "$INSPECT" "$BATS_FILE_TMPDIR/$variant.pptx" --json "$BATS_FILE_TMPDIR/$variant.json" \
            > /dev/null 2> "$BATS_FILE_TMPDIR/$variant.stderr" || rc=$?
        echo "$rc" > "$BATS_FILE_TMPDIR/$variant.rc"
    done
    # 3 本入力は枚数が違う（2 / 3 / 4 枚）。
    rc=0
    node "$INSPECT" "$BATS_FILE_TMPDIR/base.pptx" "$BATS_FILE_TMPDIR/timing.pptx" "$BATS_FILE_TMPDIR/full-image.pptx" \
        --out "$BATS_FILE_TMPDIR/multi.md" --json "$BATS_FILE_TMPDIR/multi.json" \
        > "$BATS_FILE_TMPDIR/multi.stdout" 2> "$BATS_FILE_TMPDIR/multi.stderr" || rc=$?
    echo "$rc" > "$BATS_FILE_TMPDIR/multi.rc"
}

# stderr に Node のスタックトレースが無いこと。
refute_stacktrace() {
    if grep -qE '^\s+at ' <<< "$1"; then
        fail "stderr にスタックトレースがある:"$'\n'"$1"
    fi
}

# JSON ファイルに対して JS 式を評価し、結果（JSON.stringify）を返す。式の中では `j` が parse 結果。
json_eval() {
    node -e '
        const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
        process.stdout.write(JSON.stringify(eval(process.argv[2])))
    ' "$1" "$2"
}

# $1=JSON ファイル $2=JS 式 $3=期待する JSON
assert_json() {
    run json_eval "$1" "$2"
    assert_output "$3"
}

# Markdown の「### <title>」節（次の見出しまで）に、該当行が丸ごとあること。
assert_section_line() {
    local file="$1" title="$2" line="$3" section
    attach_file "$file"
    section="$(awk -v heading="### $title" '
        $0 == heading { inside = 1; next }
        inside && /^#/ { exit }
        inside { print }
    ' "$file")"
    run printf '%s\n' "$section"
    assert_line "$line"
}

# 「## 全体集計」の表に、該当行が丸ごとあること。
assert_deck_line() {
    local file="$1" line="$2" section
    attach_file "$file"
    section="$(awk '$0 == "## 全体集計" { inside = 1; next } inside && /^#/ { exit } inside { print }' "$file")"
    run printf '%s\n' "$section"
    assert_line "$line"
}

@test "新しい variant を 1 本ずつ集計すると、終了コード 0 で終わり、スタックトレースを出さない" {
    explains "全面画像・表・CSS ラスタ・図形・アニメーションの 5 種の pptx を集計するテストです。どれも終了コード 0 で、stderr にスタックトレースが無いことを確認します。"
    local variant rc err
    for variant in full-image table-frame css-raster-pic prst-mix timing; do
        rc="$(read_output "$FIX/$variant.rc")"
        err="$(read_output "$FIX/$variant.stderr")"
        assert_equal "$rc" "0"
        refute_stacktrace "$err"
    done
}

@test "背景 blip だけの枚と全面の pic の枚を、全面画像として集計する" {
    explains "背景 blip だけで図形の無い枚と、スライドと同寸の pic の枚を含む pptx を集計するテストです。2 枚が全面画像と判定され、一意の media は 1 件に数えられることを確認します。"
    local F="$FIX/full-image.json"
    attach_file "$F"
    assert_json "$F" "$DECK.slideCount" '4'
    assert_json "$F" "$S3.backgroundBlip" 'true'
    assert_json "$F" "[$S3.spCount, $S3.picCount, $S3.graphicFrame]" '[0,0,{"table":0,"chart":0,"other":0}]'
    assert_json "$F" "[$S3.fullImage, $S3.fullImageReason]" '[true,"background-only"]'
    assert_json "$F" "$S3.images" '{"raster":{"count":1,"bytes":14},"svg":{"count":0,"bytes":0}}'
    assert_json "$F" "$S4.backgroundBlip" 'false'
    assert_json "$F" "[$S4.fullImage, $S4.fullImageReason, $S4.picCount]" '[true,"full-size-pic",1]'
    assert_json "$F" 'j.files[0].slides.slice(0, 2).map((s) => s.fullImage)' '[false,false]'
    assert_json "$F" "$DECK.uniqueMedia" '{"raster":{"count":1,"bytes":14},"svg":{"count":0,"bytes":0},"parts":["ppt/media/image2.png"]}'
    assert_json "$F" "$DECK.fullImageSlideCount" '2'
}

@test "表を持つ graphicFrame の枚では、graphicFrame を種別に分け、表セルのテキストも数える" {
    explains "表・グラフ・その他の graphicFrame を 1 つずつ持つ枚を集計するテストです。種別ごとに 1 件ずつ数えられ、テキストの run は図形と表セルの合計になることを確認します。"
    local F="$FIX/table-frame.json"
    attach_file "$F"
    assert_json "$F" "$S3.graphicFrame" '{"table":1,"chart":1,"other":1}'
    assert_json "$F" "$S3.textRunCount" '4'
    assert_json "$F" "[$S3.spCount, $S3.textSpCount, $S3.picCount]" '[1,1,0]'
}

@test "CSS で画像化された pic と svg 付きの pic を、理由別と画像の種類別に数える" {
    explains "descr に CSS の理由が付いた pic と、svgBlip 付きの pic を含む枚を集計するテストです。理由ごとの件数と、非 svg と svg を分けた画像参照が出ることを確認します。"
    local F="$FIX/css-raster-pic.json"
    attach_file "$F"
    assert_json "$F" "$S3.picCount" '4'
    assert_json "$F" "$S3.cssRasterReasons" '{"clip-path":1,"filter":2}'
    assert_json "$F" "$S3.images" '{"raster":{"count":1,"bytes":14},"svg":{"count":1,"bytes":41}}'
    assert_json "$F" 'j.files[0].slides[0].cssRasterReasons' '{}'
}

@test "prstGeom と custGeom が混在する枚では、図形の種別ごとの件数と typeface を集計する" {
    explains "rect・roundRect・line と custGeom が混在する枚を集計するテストです。種別ごとの件数、図形とテキストの数、latin と ea の typeface の一覧が出ることを確認します。"
    local F="$FIX/prst-mix.json"
    attach_file "$F"
    assert_json "$F" "$S3.prstGeom" '{"line":1,"rect":2,"roundRect":1}'
    assert_json "$F" "$S3.custGeomCount" '1'
    assert_json "$F" "[$S3.spCount, $S3.textSpCount, $S3.textRunCount]" '[5,3,3]'
    assert_json "$F" "$DECK.typefaces" '{"latin":{"Inter":2},"ea":{"Noto Sans JP":2}}'
}

@test "p:timing を持つ枚を、deck 全体で 1 枚と数える" {
    explains "3 枚目に \`p:timing\` を持つ pptx を集計するテストです。その枚だけが有りと判定され、deck の枚数が 1 になることを確認します。"
    local F="$FIX/timing.json"
    attach_file "$F"
    assert_json "$F" "$S3.timing" 'true'
    assert_json "$F" 'j.files[0].slides.slice(0, 2).map((s) => s.timing)' '[false,false]'
    assert_json "$F" "$DECK.timingSlideCount" '1'
}

@test "base を集計すると、枚順と part 名・図形の数・埋め込みフォントを出し、Markdown を stdout に出す" {
    explains "2 枚の base pptx を、\`--out\` を省いて集計するテストです。枚順と part 名、1 枚目の図形の数、埋め込みフォントが JSON に出て、Markdown の見出しが stdout に表示されることを確認します。"
    run_attached node "$INSPECT" "$FIX/base.pptx" --json "$BATS_TEST_TMPDIR/base.json"
    assert_success
    assert_line '# pptx 集計'
    local F="$BATS_TEST_TMPDIR/base.json"
    attach_file "$F"
    assert_json "$F" 'j.files[0].slides.map((s) => [s.index, s.part])' '[[1,"ppt/slides/slide1.xml"],[2,"ppt/slides/slide2.xml"]]'
    assert_json "$F" 'const s = j.files[0].slides[0]; [s.spCount, s.textSpCount, s.textRunCount, s.picCount]' '[3,2,2,1]'
    assert_json "$F" "$DECK.embeddedFonts.count" '3'
}

@test "3 本の入力を渡すと、終了コード 0 で終わり、--out を指定したので stdout には何も出さない" {
    explains "枚数が 2・3・4 枚の pptx を、\`--out\` を指定して集計するテストです。終了コード 0 で終わり、stdout が空で、stderr にスタックトレースが無いことを確認します。"
    local rc err out
    rc="$(read_output "$FIX/multi.rc")"
    err="$(read_output "$FIX/multi.stderr")"
    out="$(read_output "$FIX/multi.stdout")"
    assert_equal "$rc" "0"
    refute_stacktrace "$err"
    assert_equal "$out" ""
}

@test "3 本の入力の全体集計は、列を入力の順に並べる" {
    explains "枚数が違う 3 本の pptx の集計で、全体集計の表を読むテストです。枚数・\`p:timing\` を持つ枚数・全面画像の枚数が、入力の順に列として並ぶことを確認します。"
    local M="$FIX/multi.md"
    assert_deck_line "$M" "| 枚数 | 2 | 3 | 4 |"
    assert_deck_line "$M" '| `p:timing` を持つ枚数 | 0 | 1 | 0 |'
    assert_deck_line "$M" "| 全面画像の枚数 | 0 | 0 | 2 |"
}

@test "3 本の入力で枚数が違うとき、枚ごとの表は欠けたセルを - で埋める" {
    explains "枚数が違う 3 本の pptx の集計で、枚ごとの表を読むテストです。入力に無い枚のセルが \`-\` になり、全入力にある 1 枚目は全列に値が入ることを確認します。"
    local M="$FIX/multi.md"
    assert_section_line "$M" "part 名" "| 3 | - | ppt/slides/slide3.xml | ppt/slides/slide3.xml |"
    assert_section_line "$M" "part 名" "| 4 | - | - | ppt/slides/slide4.xml |"
    assert_section_line "$M" '`p:sp` 数' "| 3 | - | 1 | 0 |"
    assert_section_line "$M" '`p:timing`' "| 3 | - | あり | なし |"
    assert_section_line "$M" "背景 blip" "| 3 | - | なし | あり |"
    assert_section_line "$M" "全面画像" "| 3 | - | なし | 背景のみ |"
    assert_section_line "$M" "全面画像" "| 4 | - | - | 全面 pic |"
    assert_section_line "$M" "画像参照 非 svg（件 / バイト）" "| 4 | - | - | 1 / 14 |"
    assert_section_line "$M" '`p:pic` 数' "| 1 | 1 | 1 | 1 |"
}

@test "3 本の入力の JSON は、入力の順に files を並べ、入力ごとの枚数だけ slides を持つ" {
    explains "枚数が違う 3 本の pptx の集計で、JSON を読むテストです。files がラベルとファイル名と枚数を入力の順に持ち、slides の件数が入力ごとの枚数と一致することを確認します。"
    local J="$FIX/multi.json"
    attach_file "$J"
    assert_json "$J" 'j.files.map((f) => [f.label, f.path.split("/").pop(), f.deck.slideCount])' \
        '[["A","base.pptx",2],["B","timing.pptx",3],["C","full-image.pptx",4]]'
    assert_json "$J" 'j.files.map((f) => f.slides.length)' '[2,3,4]'
}

@test "引数が無いとき、usage を stderr に出して終了コード 2 で終わる" {
    explains "引数を渡さずに起動するテストです。usage が stderr に表示され、スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    run_attached --separate-stderr node "$INSPECT"
    assert_failure 2
    assert_regex "$stderr" 'usage: node inspect-pptx\.mjs'
    refute_stacktrace "$stderr"
}

@test "存在しない pptx を渡すと、そのパスを stderr に出して終了コード 2 で終わる" {
    explains "実在する pptx と存在しない pptx を並べて渡すテストです。存在しないファイルのパスが stderr に表示され、スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    run_attached --separate-stderr node "$INSPECT" "$FIX/base.pptx" "$BATS_TEST_TMPDIR/no-such.pptx"
    assert_failure 2
    assert_regex "$stderr" 'no-such\.pptx'
    refute_stacktrace "$stderr"
}

@test "zip でないファイルを渡すと、スタックトレースを出さずに終了コード 2 で終わる" {
    explains "中身が zip でないファイルを渡すテストです。pptx を読み取れず、スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    echo "not a zip" > "$BATS_TEST_TMPDIR/broken.pptx"
    run_attached --separate-stderr node "$INSPECT" "$BATS_TEST_TMPDIR/broken.pptx"
    assert_failure 2
    refute_stacktrace "$stderr"
}

@test "--out の書き込み先が存在しないとき、終了コード 2 で終わる" {
    explains "\`--out\` に存在しないディレクトリのパスを渡すテストです。書き込みに失敗し、終了コード 2 で終わることを確認します。"
    run_attached node "$INSPECT" "$FIX/base.pptx" --out "$BATS_TEST_TMPDIR/no-such-dir/out.md"
    assert_failure 2
}

@test "--json の書き込み先が存在しないとき、スタックトレースを出さずに終了コード 2 で終わる" {
    explains "\`--json\` に存在しないディレクトリのパスを渡すテストです。書き込みに失敗し、スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    run_attached --separate-stderr node "$INSPECT" "$FIX/base.pptx" --json "$BATS_TEST_TMPDIR/no-such-dir/out.json"
    assert_failure 2
    refute_stacktrace "$stderr"
}

# テストは並列に動くため、作業ツリーに変更が残らないことは、すべて終わった後に確かめる。落ちると broken になる。
teardown_file() {
    bats_load_library pecot-bats
    run git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual
    assert_output "$(cat "$BATS_FILE_TMPDIR/git-status-before")"
}
