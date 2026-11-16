#!/bin/bash
# ExitPlanMode 後の案内。Usage: exit-plan-remind.sh --mode=active|quick
# active は計画の更新と実装の引き継ぎ、quick は計画の更新だけを出す。

# 引数の検証より先に stdin を読み切る。先に終えると、送り手に EPIPE が返る。
INPUT=$(cat)

MODE=""
for arg in "$@"; do
    case "$arg" in
        --mode=*) MODE="${arg#--mode=}" ;;
    esac
done
case "$MODE" in
    active|quick) ;;
    *)
        echo "exit-plan-remind: --mode must be active or quick" >&2
        exit 1
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/active-issue.sh"
pecot_hook_enabled "exit-plan-remind" true || exit 0

# tool 名ガード: frontmatter の matcher で絞られるが、単体で呼ばれたときの防御として残す。
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL_NAME" = "ExitPlanMode" ] || exit 0

# pecot を使っていないリポと、作業中の Issue が無いセッションでは案内しない。
[ -d "${CLAUDE_PROJECT_DIR}/.pecot" ] || exit 0
pecot_active_issue_number "$CLAUDE_PROJECT_DIR" >/dev/null || exit 0

MESSAGE=$(cat "${PLUGIN_HOOKS}/templates/exit-plan-comment-update.md" 2>/dev/null)

IMPLEMENTER_REMIND="${PLUGIN_HOOKS}/templates/exit-plan-implementer-remind.md"
if [ "$MODE" = "active" ] && [ -f "$IMPLEMENTER_REMIND" ]; then
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
