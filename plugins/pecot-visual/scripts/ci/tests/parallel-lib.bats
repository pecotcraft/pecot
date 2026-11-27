# parallel-lib.sh の run_tests_parallel を確かめる (#1225)。並走してもログは引数の順に出て、1 本の失敗で全体が落ちること。
# 並走の判定は、所要時間でなく待ち合わせ（バリア）で行う。偽のテストは run_tests_parallel の入力なので bt_* で書く。

bats_require_minimum_version 1.5.0

CI_DIR="$BATS_TEST_DIRNAME/.."
BT_LIB="$BATS_TEST_DIRNAME/../../../../../.githooks/scripts/test_report/bash-test.sh"

setup_file() {
    make_test "$BATS_FILE_TMPDIR" ok 0
    make_test "$BATS_FILE_TMPDIR" bad 1
}

setup() {
    bats_load_library pecot-bats
    # shellcheck source=../parallel-lib.sh
    . "$CI_DIR/parallel-lib.sh"
    T="$BATS_TEST_TMPDIR"
}

# 失敗した @test が残した子を巻き込まないよう、記録した pid を落とす。
teardown() {
    local f
    for f in "$BATS_TEST_TMPDIR"/*.pid; do
        [ -f "$f" ] || continue
        kill -KILL "$(cat "$f")" 2> /dev/null || true
    done
}

# 偽のテストの締め。確かめを 1 件（rc が 0 でなければ落として）残し、bt_finish で終える。
fake_finish() {
    local name="$1" rc="$2"
    cat << SCRIPT
if [ $rc -eq 0 ]; then bt_pass "$name が通る"; else bt_fail "$name が通る" "わざと落とす"; fi
bt_finish
SCRIPT
}

# 開始時に $sync/<name> を置き、印が $count 本揃うまで待ってから 3 行出す。直列に動くと先頭のテストが期限（20 秒）で落ちる。
make_barrier_test() {
    local dir="$1" name="$2" sync="$3" count="$4" tail_sleep="$5" rc="$6"
    cat > "$dir/$name.test.sh" << SCRIPT
#!/bin/bash
. "$BT_LIB"
echo "$name: start"
: > "$sync/$name"
deadline=\$((SECONDS + 20))
while [ "\$(ls "$sync" | wc -l)" -lt $count ]; do
    if [ "\$SECONDS" -ge "\$deadline" ]; then
        echo "$name: 他のテストが開始しない（並走していない）"
        exit 99
    fi
    sleep 0.05
done
sleep $tail_sleep
echo "$name: middle"
echo "$name: end"
$(fake_finish "$name" "$rc")
SCRIPT
}

# 待ち合わせの無い短いテスト（失敗の握り方の検証用）。
make_test() {
    local dir="$1" name="$2" rc="$3"
    cat > "$dir/$name.test.sh" << SCRIPT
#!/bin/bash
. "$BT_LIB"
echo "$name: start"
sleep 0.2
echo "$name: middle"
echo "$name: end"
$(fake_finish "$name" "$rc")
SCRIPT
}

# hang1 は孫と EXIT trap を持ち、孫まで止まって後始末が動くかを見る。hang2 は sleep に exec する。
# driver は lib を source する別プロセス。印はすべてこの @test の $T に置く。
write_hang_tests() {
    cat > "$T/hang1.test.sh" << SCRIPT
#!/bin/bash
trap 'echo ran > "$T/hang1.exit-trap"' EXIT
echo \$\$ > "$T/hang1.pid"
sleep 60 &
echo \$! > "$T/hang1-grandchild.pid"
wait
SCRIPT
    cat > "$T/hang2.test.sh" << SCRIPT
#!/bin/bash
echo \$\$ > "$T/hang2.pid"
exec sleep 60
SCRIPT
    cat > "$T/driver.sh" << SCRIPT
. "$CI_DIR/parallel-lib.sh"
trap 'echo ran > "$T/driver-exit-trap.txt"' EXIT
run_tests_parallel "$T/hang1.test.sh" "$T/hang2.test.sh"
SCRIPT
}

# bats の @test と `&` の子は SIGINT を無視で始まり、その中の bash は INT を trap できない。
# perl で既定動作に戻してから起動する（端末の Ctrl-C を受ける shell と同じ）。関数で包むと `&` の pid が perl を指さないので配列にする。
# shellcheck disable=SC2016
DEFAULT_INT=(perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV')

wait_hang_pids() {
    local i
    for ((i = 0; i < 200; i++)); do
        [ -s "$T/hang1.pid" ] && [ -s "$T/hang1-grandchild.pid" ] && [ -s "$T/hang2.pid" ] && return 0
        sleep 0.05
    done
    return 1
}

pid_gone() {
    local i
    for ((i = 0; i < 100; i++)); do
        kill -0 "$1" 2> /dev/null || return 0
        sleep 0.05
    done
    return 1
}

# $1=シグナル名、残り=driver の起動コマンド。driver は fd 3 を閉じて起こす（bats は fd 3 を持つ子の終わりを待つ）。
assert_interrupted() {
    local sig="$1"
    shift
    write_hang_tests
    mkdir -p "$T/driver-tmp"
    TMPDIR="$T/driver-tmp" "$@" > "$T/driver.out" 2>&1 3>&- &
    local driver=$!
    echo "$driver" > "$T/driver.pid"
    if ! wait_hang_pids; then
        cat "$T/driver.out" >&2
        fail "子が起動しない（hang*.pid が揃わない）"
    fi
    local pid1 pid2 gpid drc=0
    pid1="$(cat "$T/hang1.pid")"
    pid2="$(cat "$T/hang2.pid")"
    gpid="$(cat "$T/hang1-grandchild.pid")"
    kill -"$sig" "$driver"
    wait "$driver" || drc=$?
    rm -f "$T/driver.pid"
    assert_equal "$drc" 130
    pid_gone "$pid1" || fail "並走中の子が残っている (pid $pid1)"
    pid_gone "$pid2" || fail "並走中の子が残っている (pid $pid2)"
    pid_gone "$gpid" || fail "子の起動した孫プロセスが残っている (pid $gpid)"
    rm -f "$T"/*.pid
    [ -f "$T/hang1.exit-trap" ] || fail "子の EXIT trap が動いていない"
    assert_equal "$(ls -A "$T/driver-tmp")" ""
    [ -f "$T/driver-exit-trap.txt" ] || fail "呼び出し元の EXIT trap が動いていない"
}

@test "3 本のテストを渡すと、並走させ、ログを引数の順に 1 本ずつまとめて出す" {
    explains "互いの開始を待ち合わせる 3 本の偽のテストを \`run_tests_parallel\` に渡すテストです。直列なら期限で落ちる待ち合わせが通り、先に終わる b があってもログが引数の順に出ることを確認します。"
    local sync="$T/sync"
    mkdir -p "$sync"
    # a は b より後に終わる（b が先に終わってもログが入れ替わらないことの検証用）。
    make_barrier_test "$T" a "$sync" 3 1 0
    make_barrier_test "$T" b "$sync" 3 0 0
    make_barrier_test "$T" c "$sync" 3 0 0
    run run_tests_parallel "$T/a.test.sh" "$T/b.test.sh" "$T/c.test.sh"
    assert_success
    refute_output --partial '並走していない'
    local summary="PASS: 1 / FAIL: 0 / SKIP: 0"
    assert_output "$(printf '%s\n' \
        "==> bash $T/a.test.sh" "a: start" "a: middle" "a: end" "PASS: a が通る" "" "$summary" \
        "==> bash $T/b.test.sh" "b: start" "b: middle" "b: end" "PASS: b が通る" "" "$summary" \
        "==> bash $T/c.test.sh" "c: start" "c: middle" "c: end" "PASS: c が通る" "" "$summary")"
    run ls "$sync"
    assert_output "$(printf '%s\n' a b c)"
}

@test "1 本が失敗すると、残りを最後まで動かし、失敗したファイルを挙げて 1 を返す" {
    explains "成功・失敗・成功の順に 3 本の偽のテストを \`run_tests_parallel\` に渡すテストです。失敗の前後のテストも最後まで動き、失敗したファイル名を表示して 1 を返すことを確認します。"
    local f="$BATS_FILE_TMPDIR"
    run run_tests_parallel "$f/ok.test.sh" "$f/bad.test.sh" "$f/ok.test.sh"
    assert_failure 1
    assert_equal "$(grep -c '^ok: end$' <<< "$output")" 2
    assert_line 'bad: end'
    assert_line 'FAILED: 1 本のテストが失敗しました:'
    assert_line "  $f/bad.test.sh (exit 1)"
}

@test "テストを 1 本も渡さないと、通さずに失敗を返す" {
    explains "\`run_tests_parallel\` を引数なしで呼ぶテストです。テストが 0 本のまま成功とせず、エラーを表示して失敗を返すことを確認します。"
    run run_tests_parallel
    assert_failure
    assert_output --partial 'テストファイルが 0 本です'
}

@test "TERM で中断すると、子と孫を止め、後始末を済ませて 130 で終わる" {
    explains "\`run_tests_parallel\` を動かす別のプロセスに、テストの実行中に TERM を送るテストです。並走中の子と孫が残らず、子と呼び出し元の EXIT trap が動き、作業ディレクトリを消して 130 で終わることを確認します。"
    assert_interrupted TERM bash "$T/driver.sh"
}

@test "INT で中断すると、子と孫を止め、後始末を済ませて 130 で終わる" {
    explains "\`run_tests_parallel\` を動かす別のプロセスに、端末の Ctrl-C と同じく INT を送るテストです。並走中の子と孫が残らず、子と呼び出し元の EXIT trap が動き、作業ディレクトリを消して 130 で終わることを確認します。"
    command -v perl > /dev/null 2>&1 || skip "perl が無い"
    assert_interrupted INT "${DEFAULT_INT[@]}" bash "$T/driver.sh"
}

@test "正常に終わると、INT と TERM の trap を外し、呼び出し元の EXIT trap を残す" {
    explains "\`run_tests_parallel\` が正常に戻った後の trap のテストです。INT と TERM の trap が残らず、呼び出し元が置いた EXIT trap が上書きされずに動くことを確認します。"
    cat > "$T/driver-normal.sh" << SCRIPT
. "$CI_DIR/parallel-lib.sh"
trap 'echo caller-exit' EXIT
run_tests_parallel "$BATS_FILE_TMPDIR/ok.test.sh" > /dev/null 2>&1
echo "int=[\$(trap -p INT)] term=[\$(trap -p TERM)]"
SCRIPT
    command -v perl > /dev/null 2>&1 || skip "perl が無い"
    run "${DEFAULT_INT[@]}" bash "$T/driver-normal.sh"
    assert_success
    assert_output "$(printf 'int=[] term=[]\ncaller-exit')"
}
