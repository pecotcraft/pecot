#!/bin/bash
# PreToolUse (ExitPlanMode): 初回ExitPlanModeをブロックしてリマインドを表示

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
pecot_hook_enabled "exit-plan-mode-first-block" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
# pecot 未使用リポでは .pecot を作らず、block リマインドも出さない（gitignore-before-write #666）
pecot_state_dir_ensure "$STATE_DIR" || exit 0

# クイックモード: ブロック不要（レビューなし設計のため反映確認リマインドも不要）
QUICK_FLAG="$STATE_DIR/.pecot-quick-mode"
[ -f "$QUICK_FLAG" ] && exit 0

FLAG_FILE="$STATE_DIR/.exit-plan-confirmed"

# レビュー指摘の反映確認（安全網）を促してから ExitPlanMode を通す。
# フラグあり（確認済み）: すり抜け
if [ -f "$FLAG_FILE" ]; then
    exit 0
fi

# フラグなし（初回）: フラグ作成 → deny
date '+%Y-%m-%d %H:%M:%S' > "$FLAG_FILE"

REMIND_MD="${PLUGIN_HOOKS}/templates/exit-plan-mode-remind.md"
REASON=$(cat "$REMIND_MD")
jq -n --arg reason "$REASON" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
