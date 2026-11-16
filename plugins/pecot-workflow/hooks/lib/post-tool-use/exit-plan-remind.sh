#!/bin/bash
# ExitPlanMode 後のリマインダー。
#
# stdin: PostToolUse フック JSON
# 計画の Issue 投稿は、確認を求める前にエージェントが済ませている（w-active / w-quick の手順）。
# ここでは承認後の計画の更新と、quick 以外の実装の引き継ぎを案内する。
# .pecot-quick-mode は、プランモードの終了でライフサイクルを終えるので消す。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/active-issue.sh"
pecot_hook_enabled "exit-plan-remind" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

INPUT=$(cat)

# tool 名ガード: matcher は守られるが、単体で呼ばれたときの防御として残す。
# Claude は ExitPlanMode、GitHub Copilot CLI は exit_plan_mode で届く（camelCase の toolName は読まない）。
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
case "$TOOL_NAME" in
    ExitPlanMode|exit_plan_mode) ;;
    *) exit 0 ;;
esac

IS_QUICK=0
[ -f "$STATE_DIR/.pecot-quick-mode" ] && IS_QUICK=1
rm -f "$STATE_DIR/.pecot-quick-mode"

# 作業中の Issue が無いセッションでは案内しない。
pecot_active_issue_number "$CLAUDE_PROJECT_DIR" >/dev/null || exit 0

MESSAGE=$(cat "${PLUGIN_HOOKS}/templates/exit-plan-comment-update.md" 2>/dev/null)

# クイックモードは main が実装するため、サブエージェントへの引き継ぎは案内しない。
IMPLEMENTER_REMIND="${PLUGIN_HOOKS}/templates/exit-plan-implementer-remind.md"
if [ "$IS_QUICK" -eq 0 ] && [ -f "$IMPLEMENTER_REMIND" ]; then
    MESSAGE="${MESSAGE:+${MESSAGE}

}$(cat "$IMPLEMENTER_REMIND")"
fi

[ -n "$MESSAGE" ] || exit 0
jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $msg
  }
}'
