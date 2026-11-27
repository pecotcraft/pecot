# compare-pages.mjs を確かめる (#1341)。make-fixture.mjs の小さな PNG で、画素の一致・相違・寸法違い・片側欠けの判定を固定する。
# exit code と出力 Markdown の該当行の両方を見る。

bats_require_minimum_version 1.5.0

# git hook 経由で起動されると GIT_DIR などが export され、作業ツリーの `git status` に響くため捨てる。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_COMMON_DIR GIT_NAMESPACE

COMPARE_DIR="$BATS_TEST_DIRNAME/.."
REPO_ROOT="$BATS_TEST_DIRNAME/../../../../.."
COMPARE="$COMPARE_DIR/compare-pages.mjs"
MAKE_FIXTURE="$BATS_TEST_DIRNAME/make-fixture.mjs"

setup() {
    bats_load_library pecot-bats
    T="$BATS_TEST_TMPDIR"
}

setup_file() {
    git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual > "$BATS_FILE_TMPDIR/git-status-before"
}

# variant の PNG を $2 に合成する。合成の失敗は前提崩れなので、そのテストを止める。
put() {
    mkdir -p "$(dirname "$2")"
    node "$MAKE_FIXTURE" "$1" "$2" || fail "fixture 合成に失敗: $1 -> $2"
}

# 比べる。結果は $status・$stderr、Markdown は $BATS_TEST_TMPDIR/<label>.md に残る。
run_compare() {
    local label="$1" before="$2" after="$3"
    run --separate-stderr node "$COMPARE" "$before" "$after" --out "$BATS_TEST_TMPDIR/$label.md"
}

# $1=ラベル $2=含むはずの行
assert_md_has() {
    run cat "$BATS_TEST_TMPDIR/$1.md"
    assert_output --partial "$2"
}

# stderr に Node のスタックトレースが無いこと。
refute_stacktrace() {
    if grep -qE '^\s+at ' <<< "$1"; then
        fail "stderr にスタックトレースがある:"$'\n'"$1"
    fi
}

@test "同一の 2 ページを比べると、PASS と判定し、片側固有のページの行を出さない" {
    explains "同じ PNG を 2 ページずつ並べた 2 つのディレクトリを比べるテストです。終了コード 0 で PASS と判定され、対応ページが 2 件で、片側だけのページの行が出ないことを確認します。"
    local n d
    for n in 1 2; do
        for d in a b; do put base "$T/same/$d/$n.png"; done
    done
    run_compare same "$T/same/a" "$T/same/b"
    assert_success
    assert_md_has same "結果: PASS（差のあるページはありません）"
    assert_md_has same "- 対応ページ: 2 / before 固有: 0 / after 固有: 0"
    run cat "$T/same.md"
    refute_output --partial "- before だけのページ:"
}

@test "バイト列は違うが画素が同一の PNG は、差なしと判定する" {
    explains "付加情報の tEXt だけが違い、sha256 が一致しない 2 つの PNG を比べるテストです。画素は同じなので、終了コード 0 で PASS と判定されることを確認します。"
    put base "$T/meta/a/1.png"
    put same "$T/meta/b/1.png"
    run_compare meta "$T/meta/a" "$T/meta/b"
    assert_success
    assert_md_has meta "結果: PASS（差のあるページはありません）"
}

@test "1 画素だけ違うページは、FAIL と判定し、差分の座標を表に出す" {
    explains "1 画素だけ色が違う PNG を比べるテストです。終了コード 1 で FAIL と判定され、差分画素の数と最初の座標と外接矩形が表に出ることを確認します。"
    put base "$T/px/a/1.png"
    put one-pixel "$T/px/b/1.png"
    run_compare px "$T/px/a" "$T/px/b"
    assert_failure 1
    assert_md_has px "結果: FAIL（差のあるページ 1 件）"
    assert_md_has px "| ページ | 差分画素 | 最初の座標 | 外接矩形 |"
    assert_md_has px "| 1 | 1 | (2,1) | (2,1)-(2,1) |"
}

@test "寸法が違うページは、FAIL と判定し、寸法の変化を表に出す" {
    explains "幅が違う 2 つの PNG を比べるテストです。終了コード 1 で FAIL と判定され、表に寸法の変化が出ることを確認します。"
    put base "$T/dim/a/1.png"
    put size "$T/dim/b/1.png"
    run_compare dim "$T/dim/a" "$T/dim/b"
    assert_failure 1
    assert_md_has dim "結果: FAIL（差のあるページ 1 件）"
    assert_md_has dim "| 1 | 寸法 4x3 → 5x3 | - | - |"
}

@test "片側にしか無いページは、固有のページとして別掲し、FAIL と判定する" {
    explains "before に 1・3・5 ページ、after に 1・7 ページがあるディレクトリを比べるテストです。終了コード 1 で、対応ページと片側だけのページの番号が表示されることを確認します。"
    local n
    for n in 1 3 5; do put base "$T/miss/a/$n.png"; done
    for n in 1 7; do put base "$T/miss/b/$n.png"; done
    run_compare miss "$T/miss/a" "$T/miss/b"
    assert_failure 1
    assert_md_has miss "- 対応ページ: 1 / before 固有: 2 / after 固有: 1"
    assert_md_has miss "- before だけのページ: 3, 5"
    assert_md_has miss "- after だけのページ: 7"
}

@test "RGBA と RGB の PNG は、alpha を比べずに画素で比べる" {
    explains "alpha を持つ PNG と持たない PNG を比べるテストです。alpha は比較の対象にならず、終了コード 0 で PASS と判定されることを確認します。"
    put base "$T/rgba/a/1.png"
    put rgba "$T/rgba/b/1.png"
    run_compare rgba "$T/rgba/a" "$T/rgba/b"
    assert_success
    assert_md_has rgba "結果: PASS（差のあるページはありません）"
}

# $1=variant
assert_unsupported_png() {
    explains "対応していない形式の PNG を after に置いて比べるテストです。終了コード 2 で、理由が stderr に表示され、スタックトレースは出ないことを確認します。"
    put base "$T/$1/a/1.png"
    put "$1" "$T/$1/b/1.png"
    run_compare "$1" "$T/$1/a" "$T/$1/b"
    assert_failure 2
    refute_stacktrace "$stderr"
    assert [ -n "$stderr" ]
}

for variant in interlace bit16; do
    bats_test_function --description "対応外の PNG（$variant）を渡すと、理由を stderr に出して終了コード 2 で終わる" -- assert_unsupported_png "$variant"
done

@test "PNG として読めないファイルを渡すと、スタックトレースを出さずに終了コード 2 で終わる" {
    explains "中身が PNG でないファイルを before に置いて比べるテストです。読み取りに失敗し、スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    mkdir -p "$T/broken/a"
    echo "not a png" > "$T/broken/a/1.png"
    put base "$T/broken/b/1.png"
    run_compare broken "$T/broken/a" "$T/broken/b"
    assert_failure 2
    refute_stacktrace "$stderr"
}

@test "引数が 1 個しかないとき、usage を stderr に出して終了コード 2 で終わる" {
    explains "ディレクトリを 1 個だけ渡して起動するテストです。usage が stderr に表示され、終了コード 2 で終わることを確認します。"
    mkdir -p "$T/one"
    run --separate-stderr node "$COMPARE" "$T/one"
    assert_failure 2
    assert_regex "$stderr" 'usage: node compare-pages\.mjs'
}

@test "ディレクトリが存在しないとき、スタックトレースを出さずに終了コード 2 で終わる" {
    explains "存在しないディレクトリを before に渡すテストです。スタックトレースは出ずに、終了コード 2 で終わることを確認します。"
    mkdir -p "$T/after"
    run --separate-stderr node "$COMPARE" "$T/no-such-dir" "$T/after"
    assert_failure 2
    refute_stacktrace "$stderr"
}

@test "--out を省くと、判定の Markdown を stdout に出す" {
    explains "\`--out\` を省いて同一のページを比べるテストです。終了コード 0 で、判定の行が stdout に表示されることを確認します。"
    put base "$T/out/a/1.png"
    put base "$T/out/b/1.png"
    run --separate-stderr node "$COMPARE" "$T/out/a" "$T/out/b"
    assert_success
    assert_output --partial "結果: PASS（差のあるページはありません）"
}

# テストは並列に動くため、作業ツリーに変更が残らないことは、すべて終わった後に確かめる。落ちると broken になる。
teardown_file() {
    bats_load_library pecot-bats
    run git -C "$REPO_ROOT" status --porcelain -- plugins/pecot-visual
    assert_output "$(cat "$BATS_FILE_TMPDIR/git-status-before")"
}
