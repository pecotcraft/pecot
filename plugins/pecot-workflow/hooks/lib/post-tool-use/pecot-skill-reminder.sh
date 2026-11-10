#!/bin/bash
# pecotスキルリマインダー: pecotスキル起動時にワークフロー注意を表示。
#
# 入力: PECOT_HOOK_SKILL_NAME（hook-input.sh が export 済み。stdin の JSON は読まない）。
# Copilot CLI は名前空間なしの名前（w-quick）で届くので、core/skill-name.sh で正規化する。
# pecot スキルの場合、警告を表示。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
source "${SCRIPT_DIR%/*}/core/skill-name.sh"
pecot_hook_enabled "pecot-skill-reminder" true || exit 0

# スキル名を取得。
SKILL_NAME=$(pecot_normalize_skill_name "${PECOT_HOOK_SKILL_NAME:-}")

# w-quick / w-ready 起動時は issue-pending フラグを作成。
case "$SKILL_NAME" in
    "pecot-w:w-quick"|"pecot-w:w-ready")
        # pecot 未使用リポでは pending フラグを立てない（リマインダー表示は後段で続行）#666。
        STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
        ORIGIN="${SKILL_NAME#pecot-w:}"
        pecot_state_dir_ensure "$STATE_DIR" && echo "$ORIGIN" > "$STATE_DIR/issue-pending"
        ;;
esac

# pecot-w または pecot-w:quick/task/ready/epic の場合に警告を表示。
if [ "$SKILL_NAME" = "pecot-w" ] || \
   [ "$SKILL_NAME" = "pecot-w:w-quick" ] || \
   [ "$SKILL_NAME" = "pecot-w:w-task" ] || \
   [ "$SKILL_NAME" = "pecot-w:w-ready" ] || \
   [ "$SKILL_NAME" = "pecot-w:w-epic" ]; then

    MESSAGE=$(hook_message note "pecot-workflow skill started.

All work is tracked in an Issue; there is no situation where filing the Issue is skipped.

Phase 1: hearing -> Phase 2: routine work (delegated to subagents) -> Phase 3: plan mode")

    jq -n --arg msg "$MESSAGE" '{
      "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": $msg
      }
    }'
fi
