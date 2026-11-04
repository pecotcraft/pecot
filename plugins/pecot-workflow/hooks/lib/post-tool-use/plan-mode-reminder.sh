#!/bin/bash
# プランモード開始時にテンプレートを読み込んで計画指示を出力
#
# stdin: PostToolUseフックJSON
# テンプレート: plan-mode-reminder.md

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "plan-mode-reminder" true || exit 0

INPUT=$(cat)

# クイックモードフラグが存在する場合はクイック専用テンプレートを使用。
# 非クイック時は team/single 共通テンプレートを使用する。
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
QUICK_FLAG="$STATE_DIR/.pecot-quick-mode"
if [ -f "$QUICK_FLAG" ]; then
    TEMPLATE="${PLUGIN_HOOKS}/templates/plan-mode-reminder-quick.md"
else
    TEMPLATE="${PLUGIN_HOOKS}/templates/plan-mode-reminder.md"
fi

if [ ! -f "$TEMPLATE" ]; then
    exit 0
fi

MESSAGE=$(cat "$TEMPLATE")

jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $msg
  }
}'
