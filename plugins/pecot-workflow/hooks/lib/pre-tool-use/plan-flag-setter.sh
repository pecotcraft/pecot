#!/bin/bash
# PreToolUse (EnterPlanMode): プランモードへ入る時、投稿フラグを立てる。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
pecot_hook_enabled "plan-flag-setter" true || exit 0

INPUT=$(cat)
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

# tool 名ガード: EnterPlanMode 以外では何もしない。
# matcher は Claude Code・Copilot CLI（1.0.103 確認）のどちらでも守られる。
# それでも残すのは、単体で呼ばれたときの防御のため。
# .exit-plan-confirmed の誤削除やフラグ誤設定をしないようにする。
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL_NAME" = "EnterPlanMode" ] || exit 0

# プランモードへ入るたび、ExitPlanMode 確認フラグをリセットする。
rm -f "$STATE_DIR/.exit-plan-confirmed"
PECOT_FLAG="$STATE_DIR/.pecot-active"
PLAN_POST_FLAG="$STATE_DIR/.plan-post-pending"

ISSUE_REF=""
if [ -f "$PECOT_FLAG" ]; then
    ISSUE_REF=$(cat "$PECOT_FLAG" | tr -d '[:space:]')
fi
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$ISSUE_REF" ] && [ -n "$SESSION_ID" ]; then
    # pecot 未使用リポではフラグを立てない（gitignore-before-write #666）。
    pecot_state_dir_ensure "$STATE_DIR" || exit 0
    # フラグにセッションIDとIssue参照を保存。
    echo "${SESSION_ID}:${ISSUE_REF}" > "$PLAN_POST_FLAG"

    # デバッグログ。
    pecot_state_dir_ensure "$CLAUDE_PROJECT_DIR/.pecot/tmp/debug" || exit 0
    echo "$(date '+%Y-%m-%d %H:%M:%S') EnterPlanMode: flag set SESSION=$SESSION_ID ISSUE=$ISSUE_REF" >> "$CLAUDE_PROJECT_DIR/.pecot/tmp/debug/plan-post-flow.log"
fi
