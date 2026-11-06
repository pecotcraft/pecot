#!/usr/bin/env bash
# 文章規則をコミットメッセージに適用する hook（#1280）。
#
# Stage: commit-msg。git が COMMIT_EDITMSG のパスを $1 に渡す。
# libs/text-rules/dist の bin を直接起動し、その exit code をそのまま返す。
# dist の欠落・古さと依存の欠落は、lib が作り直しと復旧で解消する。
# できないときは案内を出して exit 1 で止める。

set -euo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=../lib/text-rules-ready.sh
source "$here/../lib/text-rules-ready.sh"

root=$(git rev-parse --show-toplevel)
bin="$root/libs/text-rules/dist/bin/pecot-text-lint.js"

require_text_rules_ready "$root" || exit 1

message_file="${1:-}"
if [ -z "$message_file" ]; then
    echo "ERROR: 第 1 引数に COMMIT_EDITMSG のパスを渡してください" >&2
    exit 1
fi

exec node "$bin" --commit-msg "$message_file"
