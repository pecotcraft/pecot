#!/bin/bash
# PreToolUse MCP handler: context7 読み取りツールの自動許可（Claude Code形式）。
#
# tool_name が pecot-workflow plugin の context7 読み取り2ツールに完全一致した場合のみ
# allow JSON を出力する。それ以外は無出力（通常の許可フローに委ねる）。
# deny 系ハンドラー（pr-create-block）の後段で呼び出すこと。
# Copilot CLI は対象外とする。
# Copilot の context7 は OAuth を要して呼べない。
# ツール名（<mcpServers のキー>-<ツール名>）での allow の働き方は、確かめられない（Issue #789 の領分）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "context7-allow" true || exit 0

case "${PECOT_HOOK_TOOL_NAME:-}" in
    mcp__plugin_pecot-w_context7__resolve-library-id | mcp__plugin_pecot-w_context7__query-docs)
        REASON=$(hook_message note "context7-allow: allowed automatically because the context7 tool is read-only")
        jq -n --arg reason "$REASON" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": $reason}}'
        ;;
esac

exit 0
