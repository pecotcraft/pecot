#!/usr/bin/env bash
# ci.yml の「Summary を書き写す」step が、ホストの runner で動かす。
# コンテナの中からは $GITHUB_STEP_SUMMARY に書けないため、ワークスペースの Summary をここで書き写す。
# buildx が無いと devcontainers/ci は警告だけで成功するため、完了の印が無ければ失敗にする。

set -euo pipefail

summary=.pecot/tmp/ci/step-summary.md
done_file=.pecot/tmp/ci/done
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ -f "$summary" ]; then
    cat "$summary" >> "$out"
fi

if [ "${UP_OUTCOME:-}" != "success" ]; then
    echo "環境: コンテナの取得・起動に失敗した（基盤の失敗で、テストの失敗ではない）。" >> "$out"
    exit 1
fi

if [ ! -f "$done_file" ]; then
    echo "検証が完了していない（完了の印 $done_file が無い）。" >> "$out"
    exit 1
fi

# 印の中身は run-pr-checks.sh の exit code。
[ "$(cat "$done_file")" = "0" ]
