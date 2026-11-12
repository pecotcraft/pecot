#!/bin/bash
# Issue 起票忘れリマインダー（非ブロック）。
#
# 入力は、hook-input.sh が export 済みの PECOT_HOOK_* で、stdin の JSON は読まない。
# .pecot/state/issue-pending が立っている間は、次の操作をしようとしたときに、リマインドを返す。
# 対象は、Edit / Write / MultiEdit / NotebookEdit / EnterPlanMode と、Bash の `git checkout` と `git switch`。
# リマインドは additionalContext で返し、exit 0 でブロックはしない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/mcp-guidance.sh"
pecot_hook_enabled "pecot-issue-pending-reminder" true || exit 0

[ -z "$CLAUDE_PROJECT_DIR" ] && exit 0

FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/issue-pending"
[ -f "$FLAG" ] || exit 0

case "${PECOT_HOOK_TOOL_NAME:-}" in
    Edit|Write|MultiEdit|NotebookEdit)
        case "${PECOT_HOOK_FILE_PATH:-}" in
            */.pecot/tmp/output/*) exit 0 ;;
        esac
        ;;
    EnterPlanMode)
        ;;
    Bash)
        source "${SCRIPT_DIR%/*}/core/hook-input.sh"
        pecot_hook_command_reload
        echo "${PECOT_HOOK_COMMAND:-}" | grep -qE 'git[[:space:]]+(checkout|switch)\b' || exit 0
        ;;
    *)
        exit 0
        ;;
esac

ORIGIN=$(head -n1 "$FLAG" | tr -d '[:space:]')

case "$ORIGIN" in
    w-quick) MESSAGE=$(mcp_guidance_reminder_quick) ;;
    w-ready) MESSAGE=$(mcp_guidance_reminder_ready) ;;
    *) MESSAGE=$(mcp_guidance_reminder_other) ;;
esac

MESSAGE=$(hook_message warning "$MESSAGE")

jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": $msg
  }
}'
