#!/bin/bash
# compare-cx-measure.mjs を確かめる (#1073)。measure の出力 2 形状・片側だけの spec・cx 減少・config の行 parse を fixture で固定する。
# spec id は tests/fixtures/cx-config.yml から取り出して fixture を組む（spec の増減で落ちないように）。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../../../.githooks/scripts/test_report/bash-test.sh
. "$(cd "$SCRIPT_DIR/../../../../.." && pwd)/.githooks/scripts/test_report/bash-test.sh"
COMPARE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPARE="$COMPARE_DIR/compare-cx-measure.mjs"
CONFIG="$SCRIPT_DIR/fixtures/cx-config.yml"

# $1=題 $2=出力のファイル $3=含むはずの行
expect_line() {
    local label="$1" file="$2" line="$3"
    if grep -qF -- "$line" "$file"; then
        bt_pass "$label"
    else
        bt_fail "$label" "出力に無い行: '$line'"$'\n'"$(cat "$file")"
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
bt_eq "同値: exit 0" "0" "$?"
expect_line "同値: 判定 PASS" "$TMP/same.md" "結果: PASS（cx が減少した spec なし）"
expect_line "同値: cx 減少 0 件" "$TMP/same.md" "- cx 減少: 0 件"
expect_line "同値: カンマを含む algn を parse する" "$TMP/same.md" "同一 (l,ctr/t/square)"
bt_eq "同値: spec 別の行数" "2" "$(grep -c '^| spec-' "$TMP/same.md")"

# --- 2. cx 減少 ---
{
    measure_line spec-a 6 2286000 l
    measure_line spec-b 1 4000000 'l,ctr'
} > "$TMP/decreased.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/decreased.txt" --out "$TMP/decreased.md" > /dev/null 2>&1
bt_eq "cx 減少: exit 1" "1" "$?"
expect_line "cx 減少: 判定 FAIL" "$TMP/decreased.md" "結果: FAIL（1 spec で cx が減少）"
expect_line "cx 減少: 差が負値" "$TMP/decreased.md" "| -943475 |"

# --- 3. 片側にだけある spec と matched 0 ---
{
    measure_line spec-a 6 2286000 l
    echo "[INFO] measure 'spec-c': matched 0"
} > "$TMP/partial.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/partial.txt" --out "$TMP/partial.md" > /dev/null 2>&1
bt_eq "片側 spec: exit 0（差を計算できないため判定に載せない）" "0" "$?"
expect_line "片側 spec: before 固有を別掲" "$TMP/partial.md" "- before 固有: \`spec-b\`"
expect_line "片側 spec: after 固有を別掲" "$TMP/partial.md" "- after 固有: \`spec-c\`"

{
    measure_line spec-a 6 2286000 l
    echo "[INFO] measure 'spec-b': matched 0"
} > "$TMP/matched0.txt"
node "$COMPARE" "$TMP/same-before.txt" "$TMP/matched0.txt" --out "$TMP/matched0.md" > /dev/null 2>&1
bt_eq "matched 0: exit 0（cx 欠測は差の計算対象にしない）" "0" "$?"
expect_line "matched 0: 欠測 1 件" "$TMP/matched0.md" "- cx 欠測（matched 0）: 1 件"
expect_line "matched 0: 表に (matched 0) を出す" "$TMP/matched0.md" "| (matched 0) | - |"

# --- 4. config.yml との突合（spec id は config から取り出す） ---
mapfile -t SPEC_IDS < <(sed -nE 's/^[[:space:]]*- id:[[:space:]]*([^#[:space:]]+).*$/\1/p' "$CONFIG")
bt_eq "config から spec id を取り出せる" "0" "$([ "${#SPEC_IDS[@]}" -gt 0 ] && echo 0 || echo 1)"
: > "$TMP/config-measure.txt"
for spec_id in "${SPEC_IDS[@]}"; do
    measure_line "$spec_id" 1 2286000 l >> "$TMP/config-measure.txt"
done
node "$COMPARE" "$TMP/config-measure.txt" "$TMP/config-measure.txt" \
    --config "$CONFIG" --out "$TMP/config.md" > /dev/null 2>&1
bt_eq "config: exit 0" "0" "$?"
bt_eq "config: 余裕列が全 spec に出る" "${#SPEC_IDS[@]}" "$(grep -cE '\([-0-9]+\.[0-9]{2}%\) \|' "$TMP/config.md")"
expect_line "config: spec 数を出す" "$TMP/config.md" "- config の spec 数: ${#SPEC_IDS[@]}"

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
bt_eq "config 件数不一致: exit 2" "2" "$?"
case "$CONFIG_ERR" in
    *"3 件"*"2 件"*) bt_pass "config 件数不一致: 件数を stderr に出す" ;;
    *) bt_fail "config 件数不一致: 件数を stderr に出す" "actual='$CONFIG_ERR'" ;;
esac

# --- 6. measure 行が無い / 引数不正 ---
echo "no measure lines here" > "$TMP/empty.txt"
node "$COMPARE" "$TMP/empty.txt" "$TMP/same-after.txt" > /dev/null 2>&1
bt_eq "measure 行 0 件: exit 2" "2" "$?"

ARG_ERR="$(node "$COMPARE" "$TMP/same-before.txt" 2>&1 > /dev/null)"
bt_eq "引数 1 個: exit 2" "2" "$?"
case "$ARG_ERR" in
    *"usage: node compare-cx-measure.mjs"*) bt_pass "引数 1 個: usage を stderr に出す" ;;
    *) bt_fail "引数 1 個: usage を stderr に出す" "actual='$ARG_ERR'" ;;
esac

bt_finish
