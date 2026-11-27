#!/usr/bin/env bash
# bats のテストのファイルを 1 本ずつ動かし、落ちたファイルがあれば一覧を出して 1 で終わる。
# PECOT_REPORT_RESULTS を渡すと、@test ごとの Allure の結果をそこに書き、説明の無い passed の @test でも落ちる。
# 使い方: [PECOT_REPORT_RESULTS=<dir>] bash .githooks/scripts/test_report/bats/run.sh <ファイル>...
set -u

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
# shellcheck source=../allure-result.sh
. "$ROOT/.githooks/scripts/test_report/allure-result.sh"

BATS="$ROOT/node_modules/.bin/bats"
FORMATTER="$ROOT/.githooks/scripts/test_report/bats/allure-formatter.sh"
RESULTS="${PECOT_REPORT_RESULTS:-}"
# テストと被テストのスクリプトには渡さない。
unset PECOT_REPORT_RESULTS
export BATS_LIB_PATH="$ROOT/.githooks/scripts/test_report/bats:$ROOT/node_modules"

work=""
trap 'rm -rf "$work"' EXIT

failed=()
missing=()
for file in "$@"; do
    echo "==> bats $file"
    rc=0
    if [ -z "$RESULTS" ]; then
        "$BATS" "$file" || rc=$?
        [ "$rc" -eq 0 ] || failed+=("$file (exit $rc)")
        continue
    fi
    work="$(mktemp -d)"
    start="$(allure_result_now_ms)"
    # stderr はそのまま流し、読み込みで止まったときの理由に添える写しを取る。
    {
        PECOT_BATS_REPORT=1 "$BATS" -T --formatter tap --report-formatter "$FORMATTER" --output "$work" "$file" \
            2>&1 1>&3 3>&- | tee "$work/stderr" >&2 3>&-
        rc="${PIPESTATUS[0]}"
    } 3>&1
    if grep -q '^{"uuid":' "$work/report.log" 2> /dev/null; then
        allure_result_split "$work/report.log" "$RESULTS"
    elif [ "$rc" -ne 0 ]; then
        # 題の重なりやファイルの直下のコードの失敗では、bats は formatter に何も渡さずに終わる。
        rel="$(allure_result_relpath "$file" "$ROOT")"
        allure_result_write "$RESULTS" "$rel" bats broken "読み込む" \
            "bats がテストを読み込めず、終了コード $rc で終わった" "$start" "$(allure_result_now_ms)" "" \
            "$(tail -n 20 "$work/stderr" 2> /dev/null)" "$(allure_result_layer "$rel" "$ROOT")" ""
    fi
    while IFS= read -r line; do
        missing+=("${line#missing-description: }")
    done < <(grep '^missing-description: ' "$work/report.log" 2> /dev/null)
    rm -rf "$work"
    work=""
    [ "$rc" -eq 0 ] || failed+=("$file (exit $rc)")
done

status=0
if [ "${#missing[@]}" -gt 0 ]; then
    echo "MISSING: explains で説明を付けていない passed の @test が ${#missing[@]} 件あります:" >&2
    printf '  %s\n' "${missing[@]}" >&2
    status=1
fi
if [ "${#failed[@]}" -gt 0 ]; then
    echo "FAILED: ${#failed[@]} 本のテストが失敗しました:" >&2
    printf '  %s\n' "${failed[@]}" >&2
    status=1
fi
exit "$status"
