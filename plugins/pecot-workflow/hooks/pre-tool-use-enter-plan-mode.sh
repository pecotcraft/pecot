#!/bin/bash
# PreToolUse (EnterPlanMode): プランモードへ入る時、投稿フラグを立てる。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/pre-tool-use"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$LIB_DIR/plan-flag-setter.sh"
