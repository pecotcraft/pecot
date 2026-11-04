#!/bin/bash
# PostToolUse hook: ExitPlanMode後にチーム活用リマインド + 計画をIssueに自動投稿。
# merge-hook-outputs.sh で複数サブスクリプトの出力を単一JSONにマージして返す。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/plan-issue-poster.sh"
