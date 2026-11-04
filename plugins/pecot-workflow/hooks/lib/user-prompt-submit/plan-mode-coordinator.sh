#!/bin/bash
# plan-mode-coordinator: プランモード検出時に.plan-post-pendingフラグを作成
#
# stdin: JSON (.permission_mode, .session_id)
# stdout: なし

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "plan-mode-coordinator" true || exit 0

INPUT=$(cat)
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
PECOT_FLAG="$STATE_DIR/.pecot-active"
PLAN_POST_FLAG="$STATE_DIR/.plan-post-pending"

PERMISSION_MODE=$(echo "$INPUT" | jq -r '.permission_mode // "default"')

if [ "$PERMISSION_MODE" = "plan" ]; then
    ISSUE_REF=""
    if [ -f "$PECOT_FLAG" ]; then
        ISSUE_REF=$(cat "$PECOT_FLAG" | tr -d '[:space:]')
    fi
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

    # フラグがまだなければ立てる（重複防止）
    if [ ! -f "$PLAN_POST_FLAG" ] && [ -n "$ISSUE_REF" ] && [ -n "$SESSION_ID" ]; then
        echo "${SESSION_ID}:${ISSUE_REF}" > "$PLAN_POST_FLAG"
    fi
fi
