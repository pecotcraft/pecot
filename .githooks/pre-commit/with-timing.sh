#!/usr/bin/env bash
# 自前 hook の所要を記録するラッパー（#1083）。
#
# 用法: with-timing.sh <hook-id> <script> [args...]
#
# <script> [args...] を子として実行する。
# 終了後に `<repo_root>/.pecot/tmp/githooks-timing.tsv` へ追記する。
# 追記するのは、名前 = <hook-id>、補足 = rc=<子の exit code> の hook 行 1 行。
# 子の exit code はそのまま返す。stdin / env / cwd は子へそのまま継承する。
#
# hook 本体（check-text.sh 等）は関数内で EXIT trap を張るため、hook 本体へ
# 計測を仕込まずラッパーで包む。ラッパーは EXIT trap を使わない。INT / TERM だけ
# 空処理の trap を張り、子がシグナルで終了しても bash が自身を終了させず、
# rc=130 / 143 の hook 行を残して同じ exit code を返す。
# 記録は hook の成否を変えない: repo root が解決できない（git 管理外）・記録先へ
# 書けない場合も子は実行し、その exit code を返す（記録だけを諦める）。

set -uo pipefail

# shellcheck source=lib/timing.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/timing.sh"

if [ "$#" -lt 2 ]; then
    echo "usage: with-timing.sh <hook-id> <script> [args...]" >&2
    exit 2
fi

hook_id="$1"
repo_root=$(git rev-parse --show-toplevel 2> /dev/null) || repo_root=""

start_us=$(timing_now_us)
rc=0
trap : INT TERM
"${@:2}" || rc=$?

if [ -n "$repo_root" ]; then
    timing_record "$repo_root" hook "$hook_id" "$(timing_elapsed_sec "$start_us")" "rc=$rc"
fi

exit "$rc"
