#!/bin/bash
# Stop hook (Claude Code): BEL（terminalSequence）+ auto-push URL表示 + .pecot 誤配置検知。
# JSON を出力しうるサブスクリプションは merge-hook-outputs.sh で単一JSONにマージして返す。
# Copilot CLI は terminalSequence が無いため stop-copilot.sh（PTY ベル）を使う。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$SCRIPT_DIR/lib/notification/terminal-bell.sh" "$SCRIPT_DIR/lib/stop/auto-push.sh" "$SCRIPT_DIR/lib/stop/misplaced-pecot-notice.sh"
