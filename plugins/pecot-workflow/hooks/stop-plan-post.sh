#!/bin/bash
# Stop (Claude Code): ExitPlanMode でコンテキストクリアを選んだ後の計画投稿
# ExitPlanMode の PostToolUse はクリアを選ぶと動かない。旧セッションの PreToolUse が
# .plan-post-pending に残した計画ファイルのパスから、新セッションの最初の Stop で Issue に投稿する。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/stop"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/plan-post-fallback.sh"
