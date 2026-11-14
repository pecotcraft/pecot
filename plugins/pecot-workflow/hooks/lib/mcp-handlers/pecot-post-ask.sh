#!/bin/bash
# PreToolUse MCP handler: pecot-workflow の issue_create / pr_create の投稿を ask にする。
# ask の文は core/mcp-guidance.sh の mcp_guidance_post_ask_issue / mcp_guidance_post_ask_pr。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-tool-names.sh"
source "${SCRIPT_DIR%/*}/core/mcp-guidance.sh"

TOOL=$(pecot_tool_from_hook_name "${PECOT_HOOK_TOOL_NAME:-}") || exit 0

case "$TOOL" in
    issue_create)
        pecot_hook_enabled "pecot-issue-create-ask" true || exit 0
        MESSAGE="$(mcp_guidance_post_ask_issue)"
        FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/issue-create-slash-pending"
        ;;
    pr_create)
        pecot_hook_enabled "pecot-pr-create-ask" true || exit 0
        MESSAGE="$(mcp_guidance_post_ask_pr)"
        FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/pr-create-slash-pending"
        ;;
    *)
        exit 0
        ;;
esac

# prepare・dry_run が true のときは、何も投稿しないので素通しにする。tool_input が文字列で届くクライアントは空のオブジェクトとして読む（ask にする）。真偽値の true だけを素通しにする。
# jq が失敗したときは空のまま ask に進む（fail-safe）。
FLAGS=$(jq -r '(.tool_input | if type == "object" then . else {} end) as $ti | [($ti.prepare == true), ($ti.dry_run == true)] | @tsv' 2>/dev/null)
IFS=$'\t' read -r PREPARE DRY_RUN <<< "$FLAGS"
[ "$PREPARE" = "true" ] && exit 0
[ "$DRY_RUN" = "true" ] && exit 0
[ -f "$FLAG" ] && exit 0

REASON=$(hook_message warning "$MESSAGE")
jq -n --arg reason "$REASON" '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": $reason}}'
exit 0
