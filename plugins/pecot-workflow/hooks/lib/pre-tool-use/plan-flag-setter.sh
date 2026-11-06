#!/bin/bash
# PreToolUse (EnterPlanMode): プランモードへ入るたび、ExitPlanMode 確認フラグを消す。
# 初回 ExitPlanMode の deny（exit-plan-mode-first-block）を、プランモードごとに 1 回出すため。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "plan-flag-setter" true || exit 0

INPUT=$(cat)
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

# tool 名ガード: EnterPlanMode 以外では何もしない。
# matcher は Claude Code・Copilot CLI（1.0.103 確認）のどちらでも守られる。
# それでも残すのは、単体で呼ばれたときに .exit-plan-confirmed を誤って消さないため。
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL_NAME" = "EnterPlanMode" ] || exit 0

rm -f "$STATE_DIR/.exit-plan-confirmed"
