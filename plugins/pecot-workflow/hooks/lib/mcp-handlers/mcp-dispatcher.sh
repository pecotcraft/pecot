#!/bin/bash
# PreToolUse (MCP): deny（pr-create-block）→ ask（pecot-post-ask）→ allow（context7-allow）の順に流す。出力のあった段で終える。
# set -e は入れない。前段が非 0 で終わっても後段へ進める。有効・無効の判定は各ハンドラーが行う。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DENY_OUTPUT=$("$SCRIPT_DIR/pr-create-block.sh")
if [ -n "$DENY_OUTPUT" ]; then
    echo "$DENY_OUTPUT"
    exit 0
fi

ASK_OUTPUT=$("$SCRIPT_DIR/pecot-post-ask.sh")
if [ -n "$ASK_OUTPUT" ]; then
    echo "$ASK_OUTPUT"
    exit 0
fi

"$SCRIPT_DIR/context7-allow.sh"
exit 0
