# compare-pptx.mjs を確かめる (#1073)。make-fixture.mjs の小さな pptx で、非決定差が正規化で吸収され、実差分が判定と表に出ること。
# パート差分は exit code に載らないため、exit code と出力 Markdown の行の両方を見る。cli/dist は build 済みが前提。

bats_require_minimum_version 1.5.0

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

COMPARE_DIR="$BATS_TEST_DIRNAME/.."
REPO_ROOT="$BATS_TEST_DIRNAME/../../../../.."
COMPARE="$COMPARE_DIR/compare-pptx.mjs"
MAKE_FIXTURE="$BATS_TEST_DIRNAME/make-fixture.mjs"

setup() {
    bats_load_library pecot-bats
    FIX="$BATS_FILE_TMPDIR"
}

setup_file() {
    # 元から dirty でもよいよう、実行前後の差分を比べる。
    git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual > "$BATS_FILE_TMPDIR/git-status-before"
    local variant
    for variant in base xmlns-order cnvpr-id clip-id core-dates font-swap font-rename \
        font-content cnvpr-hidden real-diff extra-slide pic-and-typeface-drop \
        clip-in-text-a clip-in-text-b; do
        if ! node "$MAKE_FIXTURE" "$variant" "$BATS_FILE_TMPDIR/$variant.pptx"; then
            echo "ERROR: fixture 合成に失敗: $variant" >&2
            return 1
        fi
    done
    # zip のバイト列は mtime で変わるため、同じ変換をもう 1 回合成する。
    node "$MAKE_FIXTURE" base "$BATS_FILE_TMPDIR/base-again.pptx"
}

# before / after を比べる。結果は $status・$stderr、Markdown は $BATS_TEST_TMPDIR/<label>.md に残る。
run_compare() {
    local label="$1" before="$2" after="$3"
    run_attached --separate-stderr node "$COMPARE" "$before" "$after" --out "$BATS_TEST_TMPDIR/$label.md"
}

# $1=ラベル $2=含むはずの行
assert_md_has() {
    run read_output "$BATS_TEST_TMPDIR/$1.md"
    assert_success
    assert_output --partial "$2"
}

# stderr に Node のスタックトレースが無いこと。`written: ...` 等の想定内メッセージは許容する。
refute_stacktrace() {
    if grep -qE '^\s+at ' <<< "$1"; then
        fail "stderr にスタックトレースがある:"$'\n'"$1"
    fi
}

assert_stderr_has() {
    [[ "$stderr" == *"$1"* ]] || fail "stderr に無い文言: $1"$'\n'"$stderr"
}

@test "同じ変換を 2 回合成した pptx を比べると、全項目を PASS と判定する" {
    explains "同じ変換から 2 回合成した pptx を比べるテストです。機械判定は全項目が PASS となり、相違と消失は 0 件であることを確認します。"
    run_compare same "$FIX/base.pptx" "$FIX/base-again.pptx"
    assert_success
    assert_md_has same "結果: PASS（機械判定 5 項目すべて PASS）"
    assert_md_has same "差分のある slide はありません"
    assert_md_has same "- 生の sha256 相違: 0 件"
    assert_md_has same "- 正規化後の相違: 0 件"
    assert_md_has same '- [PASS] before の `a:t` が after に全て残る: 消失 0 件'
    assert_md_has same '| `a:t` 合計 | 4 | 4 | 0 |'
}

@test "同じファイルを before と after に渡すと、生の相違が 0 件になる" {
    explains "同じ pptx を before と after の両方に渡すテストです。終了コード 0 で、生の相違が 0 件になることを確認します。"
    run_compare self "$FIX/base.pptx" "$FIX/base.pptx"
    assert_success
    assert_md_has self "- 生の sha256 相違: 0 件"
}

# $1=variant $2=期待する生の相違件数
assert_absorbed() {
    explains "非決定な差だけを持つ pptx を base と比べるテストです。生の相違として検出され、正規化後は 0 件になって終了コード 0 で終わることを確認します。"
    run_compare "$1" "$FIX/base.pptx" "$FIX/$1.pptx"
    assert_success
    assert_md_has "$1" "- 生の sha256 相違: $2 件"
    assert_md_has "$1" "- 正規化後の相違: 0 件"
}

for entry in "xmlns-order 3" "cnvpr-id 2" "clip-id 1" "core-dates 1" "font-swap 3" "font-rename 2"; do
    read -r variant raw <<< "$entry"
    bats_test_function --description "非決定差 $variant は、生の相違 $raw 件として出て、正規化後は 0 件になる" -- assert_absorbed "$variant" "$raw"
done

@test "書体 part の並びだけを入れ替えた pptx では、書体 part が両側で同一になる" {
    explains "書体 part の並びを入れ替えた pptx を base と比べるテストです。sha256 の多重集合が一致し、before と after に固有の書体 part が無いことを確認します。"
    run_compare font-swap "$FIX/base.pptx" "$FIX/font-swap.pptx"
    assert_md_has font-swap "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"
}

@test "書体 part を改名した pptx では、改名が生の片側だけに出て、書体 part は両側で同一になる" {
    explains "書体 part の名前だけを変えた pptx を base と比べるテストです。生の相違には前後の固有分が出て、書体 part の多重集合は一致することを確認します。"
    run_compare font-rename "$FIX/base.pptx" "$FIX/font-rename.pptx"
    assert_md_has font-rename "- 生の sha256 相違: 2 件（一致 6 / before 固有 3 / after 固有 3）"
    assert_md_has font-rename "- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0"
}

@test "フォント実体を取り違えた pptx では、書体 part の多重集合の相違を検出する" {
    explains "名前は同じで中身だけ違う書体 part を持つ pptx を比べるテストです。機械判定の対象外なので終了コード 0 のまま、書体 part と正規化後の相違が表に出ることを確認します。"
    run_compare font-content "$FIX/base.pptx" "$FIX/font-content.pptx"
    assert_success
    assert_md_has font-content "- 書体 part の突合（sha256 多重集合）: 一致 2 / before 固有 1 / after 固有 1"
    assert_md_has font-content "- 正規化後の相違: 2 件"
}

@test "cNvPr の hidden 属性だけが違う pptx では、正規化後も slide の xml の相違が残る" {
    explains "\`cNvPr\` の hidden 属性だけを変えた pptx を比べるテストです。形状の指標は動かず終了コード 0 で、正規化では消えない相違が slide の xml に 1 件残ることを確認します。"
    run_compare cnvpr-hidden "$FIX/base.pptx" "$FIX/cnvpr-hidden.pptx"
    assert_success
    assert_md_has cnvpr-hidden "- 正規化後の相違: 1 件"
    assert_md_has cnvpr-hidden '- `ppt/slides/slide1.xml`:'
}

@test "テキストの消失・位置の変更・画像の差し替えがある pptx では、FAIL と判定して表に出す" {
    explains "テキスト 1 件の消失と、位置・画像・書体の変更を含む pptx を比べるテストです。終了コード 1 で FAIL と判定され、各差分が表と集計に出てスタックトレースが無いことを確認します。"
    run_compare real-diff "$FIX/base.pptx" "$FIX/real-diff.pptx"
    assert_failure 1
    refute_stacktrace "$stderr"
    assert_md_has real-diff '- [FAIL] before の `a:t` が after に全て残る: 消失 1 件'
    assert_md_has real-diff "セクション C"
    assert_md_has real-diff '- [FAIL] テキスト一致 sp の `xfrm` 差が無い: xfrm 差 1 件'
    assert_md_has real-diff "| 2 | 2 → 1 | 1 → 2 |"
    assert_md_has real-diff "- ラスタ media の相違: 1 件"
    assert_md_has real-diff "- after だけの typeface: Noto Sans JP"
}

@test "p:pic が減り、埋め込み typeface が消えた pptx では、FAIL と判定する" {
    explains "対応する slide の \`p:pic\` が減り、埋め込み typeface も消えた pptx を比べるテストです。終了コード 1 で、2 つの FAIL が出てスタックトレースが無いことを確認します。"
    run_compare pic-typeface-drop "$FIX/base.pptx" "$FIX/pic-and-typeface-drop.pptx"
    assert_failure 1
    refute_stacktrace "$stderr"
    assert_md_has pic-typeface-drop '- [FAIL] 対応する slide で `p:pic` が減らない: 減少した slide 1 件'
    assert_md_has pic-typeface-drop "- [FAIL] before の埋め込み typeface が after に全て残る: 消失 typeface 1 件"
}

@test "本文にある clip_ の文字列は、clip の id でないので連番に正規化しない" {
    explains "本文の \`a:t\` に \`clip_\` を含む 2 つの pptx を比べるテストです。id 属性・url 参照・clip-path 属性以外は連番に畳まれず、正規化後も slide の xml の相違が残ることを確認します。"
    run_compare clip-in-text "$FIX/clip-in-text-a.pptx" "$FIX/clip-in-text-b.pptx"
    assert_failure 1
    assert_md_has clip-in-text '- `ppt/slides/slide1.xml`:'
}

@test "after にだけ slide が増えたとき、対応する slide だけで判定して増えた slide を別掲する" {
    explains "after に slide が 1 枚増えた pptx を比べるテストです。対応する 2 枚で判定されて終了コード 0 になり、増えた slide が別掲されることを確認します。"
    run_compare extra-slide "$FIX/base.pptx" "$FIX/extra-slide.pptx"
    assert_success
    assert_md_has extra-slide "- slide 数: 2 → 3（対応 2 / before 固有 0 / after 固有 1）"
    assert_md_has extra-slide "- after にだけある slide: 3"
}

@test "引数が 1 個しかないとき、usage を stderr に出して終了コード 2 で終わる" {
    explains "pptx を 1 個だけ渡して起動するテストです。usage が stderr に表示され、終了コード 2 で終わることを確認します。"
    run_attached --separate-stderr node "$COMPARE" "$FIX/base.pptx"
    assert_failure 2
    assert_stderr_has "usage: node compare-pptx.mjs"
}

@test "cli/dist が存在しないとき、build の手順を stderr に出して終了コード 2 で終わる" {
    explains "\`PECOTV_CLI_DIST\` に存在しないパスを指定して起動するテストです。build の手順が stderr に表示され、終了コード 2 で終わることを確認します。"
    run_attached --separate-stderr env PECOTV_CLI_DIST="$BATS_TEST_TMPDIR/no-such-dist" node "$COMPARE" "$FIX/base.pptx" "$FIX/base.pptx"
    assert_failure 2
    assert_stderr_has "pnpm --filter @pecot/pecotv-cli run build"
}

@test "zip として読めない pptx を渡すと、終了コード 2 で終わる" {
    explains "中身が zip でないファイルを before に渡すテストです。pptx を読み取れず、終了コード 2 で終わることを確認します。"
    echo "not a zip" > "$BATS_TEST_TMPDIR/broken.pptx"
    run_attached node "$COMPARE" "$BATS_TEST_TMPDIR/broken.pptx" "$FIX/base.pptx"
    assert_failure 2
}

# テストは並列に動くため、作業ツリーに変更が残らないことは、すべて終わった後に確かめる。落ちると broken になる。
teardown_file() {
    bats_load_library pecot-bats
    run git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual
    assert_output "$(cat "$BATS_FILE_TMPDIR/git-status-before")"
}
