# compare-cx-measure.mjs を確かめる (#1073)。measure の出力 2 形状・片側だけの spec・cx 減少・config の行 parse を fixture で固定する。
# spec id は fixtures/cx-config.yml から取り出して fixture を組む（spec の増減で落ちないように）。

bats_require_minimum_version 1.5.0

COMPARE="$BATS_TEST_DIRNAME/../compare-cx-measure.mjs"
CONFIG="$BATS_TEST_DIRNAME/fixtures/cx-config.yml"

measure_line() {
    printf "[INFO] measure '%s': matched=%s, min cx=%s, suggested min_cx_emu=%s, algn=%s, anchor=t, wrap=square\n" \
        "$1" "$2" "$3" "$((${3} * 95 / 100))" "$4"
}

# $1=出力のファイル $2=含むはずの行
assert_md_has() {
    run cat "$1"
    assert_output --partial "$2"
}

setup() {
    bats_load_library pecot-bats
    SAME="$BATS_FILE_TMPDIR/same-before.txt"
}

setup_file() {
    {
        echo "[INFO] --measure mode: assertion を skip し、各 spec の actual cx を出力"
        measure_line spec-a 6 2286000 l
        measure_line spec-b 1 4943475 'l,ctr'
        echo "[INFO] elapsed: 5.7s"
    } > "$BATS_FILE_TMPDIR/same-before.txt"
    cp "$BATS_FILE_TMPDIR/same-before.txt" "$BATS_FILE_TMPDIR/same-after.txt"
}

@test "同じ measure の出力を比べると PASS と判定し、カンマを含む algn も parse する" {
    explains "同じ内容の measure 出力 2 つを比べるテストです。cx の減少が 0 件で、終了コード 0 の PASS と出力されることを確認します。"
    run node "$COMPARE" "$SAME" "$BATS_FILE_TMPDIR/same-after.txt" --out "$BATS_TEST_TMPDIR/same.md"
    assert_success
    assert_md_has "$BATS_TEST_TMPDIR/same.md" "結果: PASS（cx が減少した spec なし）"
    assert_md_has "$BATS_TEST_TMPDIR/same.md" "- cx 減少: 0 件"
    assert_md_has "$BATS_TEST_TMPDIR/same.md" "同一 (l,ctr/t/square)"
    assert_equal "$(grep -c '^| spec-' "$BATS_TEST_TMPDIR/same.md")" "2"
}

@test "cx の減少した spec があるとき、FAIL と判定して差を負値で出し、終了コード 1 で終わる" {
    explains "片方の spec で cx が小さくなった measure 出力を比べるテストです。終了コード 1 の FAIL と判定され、差が負の値で表に出ることを確認します。"
    {
        measure_line spec-a 6 2286000 l
        measure_line spec-b 1 4000000 'l,ctr'
    } > "$BATS_TEST_TMPDIR/decreased.txt"
    run node "$COMPARE" "$SAME" "$BATS_TEST_TMPDIR/decreased.txt" --out "$BATS_TEST_TMPDIR/decreased.md"
    assert_failure 1
    assert_md_has "$BATS_TEST_TMPDIR/decreased.md" "結果: FAIL（1 spec で cx が減少）"
    assert_md_has "$BATS_TEST_TMPDIR/decreased.md" "| -943475 |"
}

@test "片側にだけある spec は、判定に載せず別掲し、終了コード 0 で終わる" {
    explains "after に spec-b が無く spec-c だけがある measure 出力を比べるテストです。差を計算できない spec が判定に載らず、片側固有として別掲されることを確認します。"
    {
        measure_line spec-a 6 2286000 l
        echo "[INFO] measure 'spec-c': matched 0"
    } > "$BATS_TEST_TMPDIR/partial.txt"
    run node "$COMPARE" "$SAME" "$BATS_TEST_TMPDIR/partial.txt" --out "$BATS_TEST_TMPDIR/partial.md"
    assert_success
    assert_md_has "$BATS_TEST_TMPDIR/partial.md" '- before 固有: `spec-b`'
    assert_md_has "$BATS_TEST_TMPDIR/partial.md" '- after 固有: `spec-c`'
}

@test "matched が 0 の spec は、cx 欠測として数え、差の計算対象にしない" {
    explains "after の spec-b が matched 0 の measure 出力を比べるテストです。欠測として 1 件数えられ、終了コード 0 のまま表に (matched 0) が出ることを確認します。"
    {
        measure_line spec-a 6 2286000 l
        echo "[INFO] measure 'spec-b': matched 0"
    } > "$BATS_TEST_TMPDIR/matched0.txt"
    run node "$COMPARE" "$SAME" "$BATS_TEST_TMPDIR/matched0.txt" --out "$BATS_TEST_TMPDIR/matched0.md"
    assert_success
    assert_md_has "$BATS_TEST_TMPDIR/matched0.md" "- cx 欠測（matched 0）: 1 件"
    assert_md_has "$BATS_TEST_TMPDIR/matched0.md" "| (matched 0) | - |"
}

@test "config を渡すと、config の全 spec に余白の列を出し、spec 数を表示する" {
    explains "config の spec id から組んだ measure 出力を、config 付きで比べるテストです。全 spec に余白の列が出て、spec 数が表示されることを確認します。"
    mapfile -t spec_ids < <(sed -nE 's/^[[:space:]]*- id:[[:space:]]*([^#[:space:]]+).*$/\1/p' "$CONFIG")
    assert [ "${#spec_ids[@]}" -gt 0 ]
    : > "$BATS_TEST_TMPDIR/config-measure.txt"
    local spec_id
    for spec_id in "${spec_ids[@]}"; do
        measure_line "$spec_id" 1 2286000 l >> "$BATS_TEST_TMPDIR/config-measure.txt"
    done
    run node "$COMPARE" "$BATS_TEST_TMPDIR/config-measure.txt" "$BATS_TEST_TMPDIR/config-measure.txt" \
        --config "$CONFIG" --out "$BATS_TEST_TMPDIR/config.md"
    assert_success
    assert_equal "$(grep -cE '\([-0-9]+\.[0-9]{2}%\) \|' "$BATS_TEST_TMPDIR/config.md")" "${#spec_ids[@]}"
    assert_md_has "$BATS_TEST_TMPDIR/config.md" "- config の spec 数: ${#spec_ids[@]}"
}

@test "config の id と min_cx_emu の件数が合わないとき、件数を stderr に出して終了コード 2 で終わる" {
    explains "id が 3 件で min_cx_emu が 2 件の不整合な config を渡すテストです。両方の件数が stderr に出て、終了コード 2 で終わることを確認します。"
    cat > "$BATS_TEST_TMPDIR/broken-config.yml" <<'BROKEN'
spec:
  - id: a
    min_cx_emu: 100
  - id: b
    min_cx_emu: 200
  - id: c
BROKEN
    run --separate-stderr node "$COMPARE" "$SAME" "$BATS_FILE_TMPDIR/same-after.txt" --config "$BATS_TEST_TMPDIR/broken-config.yml"
    assert_failure 2
    assert_regex "$stderr" '3 件.*2 件'
}

@test "measure の行が 1 件も無い入力を渡すと、終了コード 2 で終わる" {
    explains "measure の行を含まない入力ファイルを渡すテストです。比べる対象が無いため、終了コード 2 で終わることを確認します。"
    echo "no measure lines here" > "$BATS_TEST_TMPDIR/empty.txt"
    run node "$COMPARE" "$BATS_TEST_TMPDIR/empty.txt" "$BATS_FILE_TMPDIR/same-after.txt"
    assert_failure 2
}

@test "引数が 1 個しかないとき、usage を stderr に出して終了コード 2 で終わる" {
    explains "入力ファイルを 1 個だけ渡して起動するテストです。usage が stderr に表示され、終了コード 2 で終わることを確認します。"
    run --separate-stderr node "$COMPARE" "$SAME"
    assert_failure 2
    assert_regex "$stderr" 'usage: node compare-cx-measure\.mjs'
}
