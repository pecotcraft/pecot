#!/bin/bash
# Notification hook (Claude Code): BEL を terminalSequence で出す。
# hooks.json の matcher（permission_prompt|idle_prompt|elicitation_dialog）に当たる通知だけ起動する。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/notification"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/terminal-bell.sh"
