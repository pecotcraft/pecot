#!/usr/bin/env bash
# ci.yml の「Summary を書き写す」step が、ホストの runner で動かす。
#
# コンテナの中の run-pr-checks.sh は、ホストの $GITHUB_STEP_SUMMARY に書けない。
# そのため、ワークスペースのファイルに書いた Summary を、ここで書き写す。
# あわせて、検証が最後まで動いたかを完了の印で確かめる。
# buildx が無いと devcontainers/ci は警告だけで成功するため、印が無ければ失敗にする。
#
# 環境変数:
#   UP_OUTCOME          : 「コンテナを取得・起動する」step の outcome。
#   GITHUB_STEP_SUMMARY : runner が渡す Summary の書き先。

set -euo pipefail

summary=.pecot/tmp/ci/step-summary.md
done_file=.pecot/tmp/ci/done
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ -f "$summary" ]; then
    cat "$summary" >> "$out"
fi

# 取得・起動の step が落ちたときは、基盤の失敗として書く。
if [ "${UP_OUTCOME:-}" != "success" ]; then
    echo "環境: コンテナの取得・起動に失敗した（基盤の失敗で、テストの失敗ではない）。" >> "$out"
    exit 1
fi

# 印が無いのは、検証が最後まで動かなかったとき。
if [ ! -f "$done_file" ]; then
    echo "検証が完了していない（完了の印 $done_file が無い）。" >> "$out"
    exit 1
fi

# 印の中身は run-pr-checks.sh の exit code。
[ "$(cat "$done_file")" = "0" ]
