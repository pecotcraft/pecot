#!/bin/bash
# PostToolUse hook: スキル実行後のフラグ設定と警告。
# merge-hook-outputs.sh 経由で出す（Copilot CLI の PostToolUse はトップレベルの additionalContext だけをモデルに渡す）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/pecot-skill-reminder.sh"
