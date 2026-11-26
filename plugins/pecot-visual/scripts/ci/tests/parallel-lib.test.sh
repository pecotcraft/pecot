#!/bin/bash
# parallel-lib.sh の run_tests_parallel を確かめる (#1225)。並走してもログは引数の順に出て、1 本の失敗で全体が落ちること。
# 並走の判定は、所要時間でなく待ち合わせ（バリア）で行う。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
BT_LIB="$REPO_ROOT/.githooks/scripts/test_report/bash-test.sh"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$BT_LIB"
# 偽のテストの確かめや broken を、このレーンの結果に混ぜない。
unset PECOT_REPORT_RESULTS
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP="$(mktemp -d)"
# 失敗したテストが残した sleep を巻き込まないよう、記録した pid を落としてから消す。
cleanup() {
    local f
    for f in "$TMP"/*.pid; do
        [ -f "$f" ] && kill -KILL "$(cat "$f")" 2> /dev/null
    done
    rm -rf "$TMP"
}
trap cleanup EXIT

if [ ! -f "$CI_DIR/parallel-lib.sh" ]; then
    echo "ERROR: $CI_DIR/parallel-lib.sh が無い"
    exit 1
fi
# shellcheck source=../parallel-lib.sh
. "$CI_DIR/parallel-lib.sh"

# 偽のテストの締め。確かめを 1 件（rc が 0 でなければ落として）残し、bt_finish で終える。
fake_finish() {
    local name="$1" rc="$2"
    cat << SCRIPT
if [ $rc -eq 0 ]; then bt_pass "$name が通る"; else bt_fail "$name が通る" "わざと落とす"; fi
bt_finish
SCRIPT
}

# 全員が開始するまで待ち合わせ（バリア）してから、その名前の行を 3 本出して終わるテスト。
# 開始時に $SYNC/<name> を置き、印が $count 本揃うまで待つ。直列に動くと先頭のテストが期限（20 秒）で落ちる。
make_barrier_test() {
    local name="$1" sync="$2" count="$3" tail_sleep="$4" rc="$5"
    cat > "$TMP/$name.test.sh" << SCRIPT
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
    local name="$1" rc="$2"
    cat > "$TMP/$name.test.sh" << SCRIPT
#!/bin/bash
. "$BT_LIB"
echo "$name: start"
sleep 0.2
echo "$name: middle"
echo "$name: end"
$(fake_finish "$name" "$rc")
SCRIPT
}

# a は b より後に終わる（b が先に終わってもログが入れ替わらないことの検証用）。
SYNC_OK="$TMP/sync-ok"
mkdir -p "$SYNC_OK"
make_barrier_test a "$SYNC_OK" 3 1 0
make_barrier_test b "$SYNC_OK" 3 0 0
make_barrier_test c "$SYNC_OK" 3 0 0
make_test ok 0
make_test bad 1

# --- 1. 3 本が並走する（全員が開始するまで各テストが待ち、直列なら期限で失敗する）---
run_tests_parallel "$TMP/a.test.sh" "$TMP/b.test.sh" "$TMP/c.test.sh" > "$TMP/out-ok.txt" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
    bt_pass "全部通れば 0"
else
    bt_fail "全部通れば 0" "rc=$rc: $(tr '\n' '|' < "$TMP/out-ok.txt")"
fi
if [ "$(ls "$SYNC_OK" | wc -l)" -eq 3 ] && ! grep -q '並走していない' "$TMP/out-ok.txt"; then
    bt_pass "並走する（3 本とも他の 2 本の開始を待ち合わせられた）"
else
    bt_fail "並走する（3 本とも他の 2 本の開始を待ち合わせられた）" "$(tr '\n' '|' < "$TMP/out-ok.txt")"
fi

# --- 2. ログは引数の順に、1 本ずつまとまって出る ---
summary="PASS: 1 / FAIL: 0 / SKIP: 0"
expected="$(printf '%s\n' \
    "==> bash $TMP/a.test.sh" "a: start" "a: middle" "a: end" "PASS: a が通る" "" "$summary" \
    "==> bash $TMP/b.test.sh" "b: start" "b: middle" "b: end" "PASS: b が通る" "" "$summary" \
    "==> bash $TMP/c.test.sh" "c: start" "c: middle" "c: end" "PASS: c が通る" "" "$summary")"
if [ "$(cat "$TMP/out-ok.txt")" = "$expected" ]; then
    bt_pass "ログが引数の順にまとまって出る（b が a より先に終わっても入れ替わらない）"
else
    bt_fail "ログが引数の順にまとまって出る（b が a より先に終わっても入れ替わらない）" "$(tr '\n' '|' < "$TMP/out-ok.txt")"
fi

# --- 3. 1 本失敗しても残りは最後まで動き、全体は失敗する ---
run_tests_parallel "$TMP/ok.test.sh" "$TMP/bad.test.sh" "$TMP/ok.test.sh" > "$TMP/out-ng.txt" 2>&1
bt_ne "1 本失敗すれば 0 以外" 0 "$?"
if [ "$(grep -c '^ok: end$' "$TMP/out-ng.txt")" -eq 2 ] && grep -q '^bad: end$' "$TMP/out-ng.txt"; then
    bt_pass "失敗の前後のテストも最後まで動く"
else
    MSG_DETAIL="$(tr '\n' '|' < "$TMP/out-ng.txt")"
    bt_fail "失敗の前後のテストも最後まで動く" "失敗で打ち切られた: $MSG_DETAIL"
fi
if grep -q "bad.test.sh" "$TMP/out-ng.txt" && grep -q 'FAILED' "$TMP/out-ng.txt"; then
    bt_pass "失敗したテストのファイル名が出る"
else
    bt_fail "失敗したテストのファイル名が出る" "$(tr '\n' '|' < "$TMP/out-ng.txt")"
fi

# --- 4. 引数が無ければ失敗（空のまま通過して緑になるのを防ぐ）---
run_tests_parallel > "$TMP/out-empty.txt" 2>&1
bt_ne "テストが 0 本なら失敗" 0 "$?"

# --- 5. 中断（TERM / INT）で子を残さず、workdir を消し、130 で終わる ---
# driver は lib を source する別プロセス。TMPDIR を専用にし、workdir が残らないことを見る。
# hang1 は孫と EXIT trap を持ち、孫まで止まって後始末が動くかを見る。hang2 は sleep に exec する。
cat > "$TMP/hang1.test.sh" << SCRIPT
#!/bin/bash
trap 'echo ran > "$TMP/hang1.exit-trap"' EXIT
echo \$\$ > "$TMP/hang1.pid"
sleep 60 &
echo \$! > "$TMP/hang1-grandchild.pid"
wait
SCRIPT
cat > "$TMP/hang2.test.sh" << SCRIPT
#!/bin/bash
echo \$\$ > "$TMP/hang2.pid"
exec sleep 60
SCRIPT
cat > "$TMP/driver.sh" << SCRIPT
. "$CI_DIR/parallel-lib.sh"
trap 'echo ran > "$TMP/driver-exit-trap.txt"' EXIT
run_tests_parallel "$TMP/hang1.test.sh" "$TMP/hang2.test.sh"
SCRIPT

# 起動した driver の hang*.pid が揃うのを待つ。
wait_hang_pids() {
    local i
    for ((i = 0; i < 200; i++)); do
        [ -s "$TMP/hang1.pid" ] && [ -s "$TMP/hang1-grandchild.pid" ] && [ -s "$TMP/hang2.pid" ] && return 0
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

# 中断シグナルを送って結果を確かめる。$1=シグナル名 $2=driver の起動コマンド（INT は既定動作に戻して起動）。
expect_interrupt() {
    local sig="$1"
    shift
    rm -rf "$TMP/driver-tmp" "$TMP"/hang*.pid "$TMP/hang1-grandchild.pid" "$TMP/hang1.exit-trap" "$TMP/driver-exit-trap.txt"
    mkdir -p "$TMP/driver-tmp"
    TMPDIR="$TMP/driver-tmp" "$@" > "$TMP/driver-$sig.out" 2>&1 &
    local driver=$!
    if ! wait_hang_pids; then
        bt_fail "$sig: 子が起動する" "hang*.pid が揃わない"
        kill -KILL "$driver" 2> /dev/null
        return
    fi
    local pid1 pid2 gpid drc=0
    pid1="$(cat "$TMP/hang1.pid")"
    pid2="$(cat "$TMP/hang2.pid")"
    gpid="$(cat "$TMP/hang1-grandchild.pid")"
    kill -"$sig" "$driver"
    wait "$driver" || drc=$?
    bt_eq "$sig: 130 で終わる" "130" "$drc"
    if pid_gone "$pid1" && pid_gone "$pid2"; then
        bt_pass "$sig: 並走中の子が残らない"
    else
        bt_fail "$sig: 並走中の子が残らない" "子が残っている (pid $pid1 $pid2)"
    fi
    if pid_gone "$gpid"; then
        bt_pass "$sig: 子が起動した孫プロセスも残らない"
    else
        bt_fail "$sig: 子が起動した孫プロセスも残らない" "孫プロセスが残っている (pid $gpid)"
    fi
    if [ -f "$TMP/hang1.exit-trap" ]; then
        bt_pass "$sig: 子の EXIT trap が動く（後始末ができる）"
    else
        bt_fail "$sig: 子の EXIT trap が動く（後始末ができる）" "印が無い"
    fi
    bt_eq "$sig: workdir を消す" "" "$(ls -A "$TMP/driver-tmp")"
    if [ -f "$TMP/driver-exit-trap.txt" ]; then
        bt_pass "$sig: 呼び出し元の EXIT trap が動く"
    else
        bt_fail "$sig: 呼び出し元の EXIT trap が動く" "印が無い"
    fi
}

expect_interrupt TERM bash "$TMP/driver.sh"
# `&` の子は SIGINT を無視で始まり trap できない。perl で既定動作に戻して driver を起動する（端末の Ctrl-C と同じ）。
if command -v perl > /dev/null 2>&1; then
    expect_interrupt INT perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' bash "$TMP/driver.sh"
else
    bt_skip "INT: 中断の確かめ" "perl が無い"
fi

# --- 6. 正常に戻ったときは INT / TERM の trap を残さず、呼び出し元の EXIT trap を上書きしない ---
cat > "$TMP/driver-normal.sh" << SCRIPT
. "$CI_DIR/parallel-lib.sh"
trap 'echo caller-exit' EXIT
run_tests_parallel "$TMP/ok.test.sh" > /dev/null 2>&1
echo "int=[\$(trap -p INT)] term=[\$(trap -p TERM)]"
SCRIPT
NORMAL_OUT="$(bash "$TMP/driver-normal.sh" 2>&1)"
bt_eq "正常終了: INT / TERM の trap を外し、呼び出し元の EXIT trap は残る" \
    "$(printf 'int=[] term=[]\ncaller-exit')" "$NORMAL_OUT"

bt_finish
