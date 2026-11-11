#!/bin/bash
# PreToolUse (MCP): MCPハンドラーのディスパッチ。呼び出し元は hooks/pre-tool-use-mcp.sh。
#
# 実行順序（deny > ask > allow の不変条件を維持）は次のとおり。出力があった段で終える。
#   1. pr-create-block.sh → deny
#   2. pecot-post-ask.sh  → ask
#   3. context7-allow.sh  → allow
#
# ツール名は PECOT_HOOK_TOOL_NAME（エントリの project-root.sh が export）で受ける。
# stdin の JSON は pecot-post-ask.sh だけが読む。ほかのハンドラーは読まないので、前段が消費しない。
#
# set -e は入れない。前段が非 0 で終わっても後段へ到達させる必要がある。
# pecot_hook_enabled の判定も入れない（純粋な transport。有効・無効は各ハンドラーが判定する）。

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
