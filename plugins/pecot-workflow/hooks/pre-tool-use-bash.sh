#!/bin/bash
# PreToolUse (Bash): Bashガード統合エントリスクリプト。
# Claude Code / Copilot CLI 共通（Copilot も snake_case の tool_input.command を送る）。
# merge-hook-outputs.sh で、ガードと /tmp リマインダーの出力を単一JSONにマージして返す。
# deny / allow の判定と理由は落とさない。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$LIB_DIR/core/merge-hook-outputs.sh" "$LIB_DIR/adapters/claude-bash-guards.sh" "$LIB_DIR/pre-tool-use/tmp-path-warner.sh"
exit 0
