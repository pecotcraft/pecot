#!/bin/bash
# parallel-lib.sh の run_tests_parallel を検証する (#1225)。
#
# release lane の scripts/release/tests/*.test.sh は、互いに独立している。
# 一時ディレクトリ・モックレジストリのポート・監査記録が、すべてテスト内に閉じるためだ。
# そのため並走させ、lane の所要を最長の 1 本に縮める。
# 並走しても、次の 2 点は直列の実行と同じでなければならない。
# ログは引数の順に 1 本ずつまとめて出ること。
# 1 本でも失敗したら、全体が失敗すること。
# 並走の判定は、所要時間でなく待ち合わせ（バリア）で行う。
#
# `set -e` は使わない: 失敗するテストの戻り値を握って評価を続けるため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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
    echo "FAIL: $CI_DIR/parallel-lib.sh が無い"
    exit 1
fi
# shellcheck source=../parallel-lib.sh
. "$CI_DIR/parallel-lib.sh"

# 全員が開始するまで待ち合わせ（バリア）してから、その名前の行を 3 本出し、指定の終了コードで終わるテスト。
# 開始時に $SYNC/<name> を置き、$SYNC の印が $count 本揃うまで待つ。
# 直列に動くと、先頭のテストが他の印を待ち続けて、期限（20 秒）で失敗する。
# そのため、所要時間でなく「同時に動いたこと」そのもので、並走を判定できる。
# 高負荷でも偽陰性にならない。
make_barrier_test() {
    local name="$1" sync="$2" count="$3" tail_sleep="$4" rc="$5"
    cat > "$TMP/$name.test.sh" << SCRIPT
#!/bin/bash
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
exit $rc
SCRIPT
}

# 待ち合わせの無い短いテスト（失敗の握り方の検証用）。
make_test() {
    local name="$1" rc="$2"
    cat > "$TMP/$name.test.sh" << SCRIPT
#!/bin/bash
echo "$name: start"
sleep 0.2
echo "$name: middle"
echo "$name: end"
exit $rc
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

# --- 1. 3 本が並走する（全員が開始するまで各テストが待つ。直列なら期限で失敗する）---
run_tests_parallel "$TMP/a.test.sh" "$TMP/b.test.sh" "$TMP/c.test.sh" > "$TMP/out-ok.txt" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
    pass "全部通れば 0"
else
    MSG_DETAIL_0="$(tr '\n' '|' < "$TMP/out-ok.txt")"
    fail "全部通ったのに rc=$rc ($MSG_DETAIL_0)"
fi
if [ "$(ls "$SYNC_OK" | wc -l)" -eq 3 ] && ! grep -q '並走していない' "$TMP/out-ok.txt"; then
    pass "並走する（3 本とも他の 2 本の開始を待ち合わせられた）"
else
    MSG_DETAIL_1="$(tr '\n' '|' < "$TMP/out-ok.txt")"
    fail "並走していない: $MSG_DETAIL_1"
fi

# --- 2. ログは引数の順に、1 本ずつまとまって出る ---
expected="$(printf '%s\n' \
    "==> bash $TMP/a.test.sh" "a: start" "a: middle" "a: end" \
    "==> bash $TMP/b.test.sh" "b: start" "b: middle" "b: end" \
    "==> bash $TMP/c.test.sh" "c: start" "c: middle" "c: end")"
if [ "$(cat "$TMP/out-ok.txt")" = "$expected" ]; then
    pass "ログが引数の順にまとまって出る（b が a より先に終わっても入れ替わらない）"
else
    MSG_DETAIL_2="$(tr '\n' '|' < "$TMP/out-ok.txt")"
    fail "ログの並びが違う: $MSG_DETAIL_2"
fi

# --- 3. 1 本失敗しても残りは最後まで動き、全体は失敗する ---
run_tests_parallel "$TMP/ok.test.sh" "$TMP/bad.test.sh" "$TMP/ok.test.sh" > "$TMP/out-ng.txt" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "1 本失敗すれば 0 以外"; else fail "失敗を握り潰した"; fi
if [ "$(grep -c '^ok: end$' "$TMP/out-ng.txt")" -eq 2 ] && grep -q '^bad: end$' "$TMP/out-ng.txt"; then
    pass "失敗の前後のテストも最後まで動く"
else
    MSG_DETAIL_3="$(tr '\n' '|' < "$TMP/out-ng.txt")"
    fail "失敗で打ち切られた: $MSG_DETAIL_3"
fi
if grep -q "bad.test.sh" "$TMP/out-ng.txt" && grep -q 'FAILED' "$TMP/out-ng.txt"; then
    pass "失敗したテストのファイル名が出る"
else
    MSG_DETAIL_4="$(tr '\n' '|' < "$TMP/out-ng.txt")"
    fail "失敗したテストが分からない: $MSG_DETAIL_4"
fi

# --- 4. 引数が無ければ失敗（空のまま通過して緑になるのを防ぐ）---
run_tests_parallel > "$TMP/out-empty.txt" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then pass "テストが 0 本なら失敗"; else fail "0 本で通った"; fi

# --- 5. 中断（TERM / INT）で子を残さず、workdir を消し、130 で終わる ---
# 非対話シェルの `&` で起動した子は SIGINT を無視する。
# そのため Ctrl-C だけでは、並走中のテストが最後まで動き続ける。
# lib が INT / TERM を拾って、子へ TERM を送り、workdir を消してから終わる。
# driver は、lib を source して run_tests_parallel を呼ぶ別プロセス。
# TMPDIR を専用にして、mktemp -d の workdir が残らないことを見る。
# hang1: 孫プロセス（モックレジストリ相当）を持ち、EXIT trap で後始末の印を置く。
#        TERM で孫まで止まり、EXIT trap が動くことを見る。
# hang2: exec で sleep に置き換わる（trap を持てない最小の形）。
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

# 中断シグナルを送って結果を検証する。$1=シグナル名 $2=driver の起動コマンド（INT は既定動作に戻して起動）。
check_interrupt() {
    local sig="$1"
    shift
    rm -rf "$TMP/driver-tmp" "$TMP"/hang*.pid "$TMP/hang1-grandchild.pid" "$TMP/hang1.exit-trap" "$TMP/driver-exit-trap.txt"
    mkdir -p "$TMP/driver-tmp"
    TMPDIR="$TMP/driver-tmp" "$@" > "$TMP/driver-$sig.out" 2>&1 &
    local driver=$!
    if ! wait_hang_pids; then
        fail "$sig: 子が起動しない"
        kill -KILL "$driver" 2> /dev/null
        return
    fi
    local pid1 pid2 gpid drc=0
    pid1="$(cat "$TMP/hang1.pid")"
    pid2="$(cat "$TMP/hang2.pid")"
    gpid="$(cat "$TMP/hang1-grandchild.pid")"
    kill -"$sig" "$driver"
    wait "$driver" || drc=$?
    assert_eq "$sig: 130 で終わる" "130" "$drc"
    if pid_gone "$pid1" && pid_gone "$pid2"; then
        pass "$sig: 並走中の子が残らない"
    else
        fail "$sig: 子が残っている (pid $pid1 $pid2)"
    fi
    if pid_gone "$gpid"; then
        pass "$sig: 子が起動した孫プロセスも残らない"
    else
        fail "$sig: 孫プロセスが残っている (pid $gpid)"
    fi
    if [ -f "$TMP/hang1.exit-trap" ]; then
        pass "$sig: 子の EXIT trap が動く（後始末ができる）"
    else
        fail "$sig: 子の EXIT trap が動かない"
    fi
    assert_eq "$sig: workdir を消す" "0" "$(ls -A "$TMP/driver-tmp" | wc -l | tr -d ' ')"
    if [ -f "$TMP/driver-exit-trap.txt" ]; then
        pass "$sig: 呼び出し元の EXIT trap が動く"
    else
        fail "$sig: 呼び出し元の EXIT trap が動かない"
    fi
}

check_interrupt TERM bash "$TMP/driver.sh"
# INT は、`&` で起動した子が SIGINT を無視する（無視で始まったシグナルは trap できない）ため、
# perl で既定動作に戻してから driver を起動する。端末の Ctrl-C を受けるシェルと同じ状態。
if command -v perl > /dev/null 2>&1; then
    check_interrupt INT perl -e '$SIG{INT} = "DEFAULT"; exec @ARGV' bash "$TMP/driver.sh"
else
    echo "SKIP: INT: perl が無いため確認しない"
fi

# --- 6. 正常に戻ったときは INT / TERM の trap を残さず、呼び出し元の EXIT trap を上書きしない ---
cat > "$TMP/driver-normal.sh" << SCRIPT
. "$CI_DIR/parallel-lib.sh"
trap 'echo caller-exit' EXIT
run_tests_parallel "$TMP/ok.test.sh" > /dev/null 2>&1
echo "int=[\$(trap -p INT)] term=[\$(trap -p TERM)]"
SCRIPT
NORMAL_OUT="$(bash "$TMP/driver-normal.sh" 2>&1)"
assert_eq "正常終了: INT / TERM の trap を外し、呼び出し元の EXIT trap は残る" \
    "$(printf 'int=[] term=[]\ncaller-exit')" "$NORMAL_OUT"

echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
