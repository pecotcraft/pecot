#!/bin/bash
# MCPハンドラ: PR作成ブロック（Claude Code / Copilot CLI 共通）。
#
# PECOT_HOOK_TOOL_NAME（hook-input.sh が export 済み）でツール名をチェックする。
# 対象なら、hookSpecificOutput.permissionDecision:"deny" を出力する。
#
# 対象ツール名は次のとおり。
#   - Claude Code: mcp__github*__create_pull_request
#   - Copilot CLI: github-mcp-server-create_pull_request
#     MCP のツール名は <mcpServers のキー>-<ツール名> の形。
#     --enable-all-github-mcp-tools で、組み込みの GitHub MCP に現れる（T050 追加確認）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "pr-create-block" true || exit 0

# 対象のツール名にマッチしなければ何もしない。
if ! echo "${PECOT_HOOK_TOOL_NAME:-}" | grep -qE '^(mcp__github.*__create_pull_request|github-mcp-server-create_pull_request)$'; then
    exit 0
fi

# pecotフラグ立時 → ブロック。
MESSAGE=$(hook_message error "pr-create-block: creating a PR with an MCP tool is not allowed while pecot-workflow is running.

How to proceed:
When the user has explicitly asked for a PR, use the /pecot-w:w-pr skill.

Details:
- The pecot-w:w-pr skill applies the required template and validation.
- Calling the MCP tool directly loses traceability.")

jq -n --arg msg "$MESSAGE" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": $msg}}'
exit 0
