#!/usr/bin/env bash
# レーンの Allure の結果に、step-gate.mjs の quality gate をかける。名前付きの step が無い passed のテストがあれば、非 0 で終わる。
# usage: step-gate.sh <allure-results のディレクトリ>
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $(basename "$0") <allure-results のディレクトリ>" >&2
    exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
results="$(cd "$1" && pwd)"

# allure quality-gate は結果の JSON を output に書くので、一時ディレクトリに書かせて消す。
output="$(mktemp -d)"
trap 'rm -rf "$output"' EXIT

echo "==> step の quality gate: $results"
cd "$root"
PECOT_STEP_GATE_OUTPUT="$output" bash "$root/.githooks/scripts/run-pnpm.sh" exec allure quality-gate \
    --config "$here/step-gate.mjs" "$results"
