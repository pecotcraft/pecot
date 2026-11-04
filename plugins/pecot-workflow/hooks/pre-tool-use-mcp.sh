#!/bin/bash
# PreToolUse hook: MCPツール統合エントリ
# Claude Code / Copilot CLI 共通（入力は両クライアントとも snake_case の tool_name）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$LIB_DIR/mcp-handlers/mcp-dispatcher.sh"
exit 0
