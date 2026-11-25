#!/bin/bash
# SessionStart: Claude Code が作る worktree で、setup_command を 1 回だけ流す。
# 時間切れのフックは出力が捨てられるので、session-start.sh（session-title を含む）と別のエントリにし、timeout を長く取る。
# 出力（素のテキスト）は、merge-hook-outputs.sh で JSON にする。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"

echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$SCRIPT_DIR/lib/session-start/worktree-setup.sh"
