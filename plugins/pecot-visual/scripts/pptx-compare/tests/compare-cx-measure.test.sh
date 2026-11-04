#!/bin/bash
# compare-cx-measure.mjs の検証 (#1073)。
#
# 次の 3 つを fixture で固定する。
# `check-cx.mjs --measure` の出力 2 形状（通常形 / `matched 0`）。
# 片側にだけある spec と、cx 減少。
# config の行 parse。
# `--config` には tests/fixtures/cx-config.yml（汎用の小さな config）を渡す。
# spec id は config から取り出して fixture を組み立てる。spec が増減しても、テストが失敗しないようにするためだ。
#
# `set -e` は使わない: 負例で非ゼロ終了を意図的に発生させ、その exit code を assert するため。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PECOTV_ROOT="$(cd "$COMPARE_DIR/../.." && pwd)"
COMPARE="$COMPARE_DIR/compare-cx-measure.mjs"
CONFIG="$SCRIPT_DIR/fixtures/cx-config.yml"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

measure_line() {
    printf "[INFO] measure '%s': matched=%s, min cx=%s, suggested min_cx_emu=%s, algn=%s, anchor=t, wrap=square\n" \
        "$1" "$2" "$3" "$((${3} * 95 / 100))" "$4"
}

# --- 1. 同値ペア（synthetic id・config なし） ---
{
    echo "[INFO] --measure mode: assertion を skip し、各 spec の actual cx を出力"
    measure_line spec-a 6 2286000 l
    measure_line spec-b 1 4943475 'l,ctr'
    echo "[INFO] elapsed: 5.7s"
} > "$TMP/same-before.txt"
cp "$TMP/same-before.txt" "$TMP/same-after.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/same-after.txt" --out "$TMP/same.md" > /dev/null 2>&1
assert_eq "同値: exit 0" "0" "$?"
assert_line "同値: 判定 PASS" "$TMP/same.md" "結果: PASS（cx が減少した spec なし）"
assert_line "同値: cx 減少 0 件" "$TMP/same.md" "- cx 減少: 0 件"
assert_line "同値: カンマを含む algn を parse する" "$TMP/same.md" "同一 (l,ctr/t/square)"
assert_eq "同値: spec 別の行数" "2" "$(grep -c '^| spec-' "$TMP/same.md")"

# --- 2. cx 減少 ---
{
    measure_line spec-a 6 2286000 l
    measure_line spec-b 1 4000000 'l,ctr'
} > "$TMP/decreased.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/decreased.txt" --out "$TMP/decreased.md" > /dev/null 2>&1
assert_eq "cx 減少: exit 1" "1" "$?"
assert_line "cx 減少: 判定 FAIL" "$TMP/decreased.md" "結果: FAIL（1 spec で cx が減少）"
assert_line "cx 減少: 差が負値" "$TMP/decreased.md" "| -943475 |"

# --- 3. 片側にだけある spec と matched 0 ---
{
    measure_line spec-a 6 2286000 l
    echo "[INFO] measure 'spec-c': matched 0"
} > "$TMP/partial.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/partial.txt" --out "$TMP/partial.md" > /dev/null 2>&1
assert_eq "片側 spec: exit 0（差を計算できないため判定に載せない）" "0" "$?"
assert_line "片側 spec: before 固有を別掲" "$TMP/partial.md" "- before 固有: \`spec-b\`"
assert_line "片側 spec: after 固有を別掲" "$TMP/partial.md" "- after 固有: \`spec-c\`"

{
    measure_line spec-a 6 2286000 l
    echo "[INFO] measure 'spec-b': matched 0"
} > "$TMP/matched0.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/matched0.txt" --out "$TMP/matched0.md" > /dev/null 2>&1
assert_eq "matched 0: exit 0（cx 欠測は差の計算対象にしない）" "0" "$?"
assert_line "matched 0: 欠測 1 件" "$TMP/matched0.md" "- cx 欠測（matched 0）: 1 件"
assert_line "matched 0: 表に (matched 0) を出す" "$TMP/matched0.md" "| (matched 0) | - |"

# --- 4. config.yml との突合（spec id は config から取り出す） ---
mapfile -t SPEC_IDS < <(sed -nE 's/^[[:space:]]*- id:[[:space:]]*([^#[:space:]]+).*$/\1/p' "$CONFIG")
assert_eq "config から spec id を取り出せる" "0" "$([ "${#SPEC_IDS[@]}" -gt 0 ] && echo 0 || echo 1)"
: > "$TMP/config-measure.txt"
for spec_id in "${SPEC_IDS[@]}"; do
    measure_line "$spec_id" 1 2286000 l >> "$TMP/config-measure.txt"
done
node "$COMPARE" "$TMP/config-measure.txt" "$TMP/config-measure.txt" \
    --config "$CONFIG" --out "$TMP/config.md" > /dev/null 2>&1
assert_eq "config: exit 0" "0" "$?"
assert_eq "config: 余裕列が全 spec に出る" "${#SPEC_IDS[@]}" "$(grep -cE '\([-0-9]+\.[0-9]{2}%\) \|' "$TMP/config.md")"
assert_line "config: spec 数を出す" "$TMP/config.md" "- config の spec 数: ${#SPEC_IDS[@]}"

# --- 5. config の行 parse 不整合 ---
cat > "$TMP/broken-config.yml" <<'BROKEN'
spec:
  - id: a
    min_cx_emu: 100
  - id: b
    min_cx_emu: 200
  - id: c
BROKEN
CONFIG_ERR="$(node "$COMPARE" "$TMP/same-before.txt" "$TMP/same-after.txt" --config "$TMP/broken-config.yml" 2>&1 > /dev/null)"
assert_eq "config 件数不一致: exit 2" "2" "$?"
case "$CONFIG_ERR" in
    *"3 件"*"2 件"*) pass "config 件数不一致: 件数を stderr に出す" ;;
    *) fail "config 件数不一致: 件数を stderr に出す (actual='$CONFIG_ERR')" ;;
esac

# --- 6. measure 行が無い / 引数不正 ---
echo "no measure lines here" > "$TMP/empty.txt"
node "$COMPARE" "$TMP/empty.txt" "$TMP/same-after.txt" > /dev/null 2>&1
assert_eq "measure 行 0 件: exit 2" "2" "$?"

ARG_ERR="$(node "$COMPARE" "$TMP/same-before.txt" 2>&1 > /dev/null)"
assert_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-cx-measure.mjs"*) pass "引数 1 個: usage を stderr に出す" ;;
    *) fail "引数 1 個: usage を stderr に出す (actual='$ARG_ERR')" ;;
esac

echo
echo "PASS: $PASS / FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
