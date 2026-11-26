#!/usr/bin/env bash
set -euo pipefail

# root 共通フック (.githooks/ 配下) の pytest のランナー。引数のファイルだけ、無ければ tests/ 全部を動かす。
# 固定した版は dependabot が追わない。上げるときは uvx の版をここで直し、tests を全量で通す。

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 外の nx の色指定は、出力を比べるテストを落とすので外す。
unset FORCE_COLOR

targets=("$@")
if [ "${#targets[@]}" -eq 0 ]; then
    targets=("$TESTS_DIR")
fi

# nx のレーンから動いたときだけ、Allure の結果を残す。--clean-alluredir は xdist の worker も消すので使わない。
report=()
if [ -n "${NX_TASK_TARGET_TARGET:-}" ]; then
    results="$(dirname "$TESTS_DIR")/test-results/$NX_TASK_TARGET_TARGET/allure-results"
    rm -rf "$results"
    report=(--alluredir "$results" -o "pecot_report_project=${NX_TASK_TARGET_PROJECT:-}" -o "pecot_report_lane=$NX_TASK_TARGET_TARGET")
fi

echo "==> pytest ${targets[*]}"
uvx --python 3.12 --with pytest-xdist==3.8.0 --with packaging==26.3 --with pyyaml==6.0.3 --with allure-pytest==2.16.2 \
    pytest==9.2.0 "${targets[@]}" "${report[@]}" -q --import-mode=importlib -n auto -p no:cacheprovider

if [ "${#report[@]}" -gt 0 ]; then
    bash "$(dirname "$TESTS_DIR")/scripts/test_report/step-gate.sh" "$results"
fi
