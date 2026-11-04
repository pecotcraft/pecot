#!/bin/bash
# UserPromptSubmit hook: ユーザープロンプト送信時の注入
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/user-prompt-submit"
CORE_DIR="$SCRIPT_DIR/lib/core"
INPUT=$(cat)
source "$CORE_DIR/project-root.sh" "$INPUT"
echo "$INPUT" | "$CORE_DIR/pecot-dir-init-detect.sh"
echo "$INPUT" | "$LIB_DIR/workflow-compliance-injector.sh"
echo "$INPUT" | "$LIB_DIR/plan-mode-coordinator.sh"
echo "$INPUT" | "$LIB_DIR/pecot-issue-pending-state.sh"
echo "$INPUT" | "$LIB_DIR/create-slash-flag.sh"
exit 0
