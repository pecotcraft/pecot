#!/bin/bash
# PreToolUse (MCP): MCPハンドラーのディスパッチ。
#
# 実行順序（deny > allow の不変条件を維持）は次のとおり。
#   1. pr-create-block.sh  → deny。出力があれば返す
#   2. context7-allow.sh   → allow。deny 系の後段
#
# ツール名は PECOT_HOOK_TOOL_NAME（エントリの project-root.sh が export）で受け、
# stdin の JSON は読まない。
#
# 配置は hooks/lib/mcp-handlers/mcp-dispatcher.sh。
# 呼び出し元: hooks/pre-tool-use-mcp.sh。
#
# set -e は入れない。前段が非 0 で終わっても後段へ到達させる必要がある。
# pecot_hook_enabled の判定も入れない（純粋な transport。有効・無効は各ハンドラーが判定する）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DENY_OUTPUT=$("$SCRIPT_DIR/pr-create-block.sh")
if [ -n "$DENY_OUTPUT" ]; then
    echo "$DENY_OUTPUT"
    exit 0
fi

"$SCRIPT_DIR/context7-allow.sh"
exit 0
