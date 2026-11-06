#!/bin/bash
# PreToolUse (Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode): Issue 起票忘れリマインダー。
# merge-hook-outputs.sh でサブスクリプトの出力を単一JSONにマージして返す。
# Bash は pre-tool-use-bash.sh が担当する。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR_PRE="$SCRIPT_DIR/lib/pre-tool-use"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR_PRE/pecot-issue-pending-reminder.sh"
