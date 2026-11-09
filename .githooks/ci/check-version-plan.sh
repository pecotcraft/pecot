#!/usr/bin/env bash
set -euo pipefail

# CI の version-plan の job の本体。判定は pre-push のスクリプトに任せ、出力と範囲を Summary に書く。

base_sha="$(git merge-base origin/main HEAD)"
head_sha="$(git rev-parse HEAD)"
rc=0
out="$(.githooks/pre-push/check-version-plan-required.sh 2>&1)" || rc=$?
printf '%s\n' "$out"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
        echo "## version plan"
        echo
        echo "範囲: \`${base_sha}\`..\`${head_sha}\`"
        echo
        echo '```text'
        printf '%s\n' "$out"
        echo '```'
        echo
        if [ "$rc" -eq 0 ]; then echo "結論: 成功"; else echo "結論: 失敗（終了コード ${rc}）"; fi
    } >> "$GITHUB_STEP_SUMMARY"
fi
exit "$rc"
