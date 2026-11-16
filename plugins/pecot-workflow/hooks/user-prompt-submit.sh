#!/bin/bash
# UserPromptSubmit hook: pecot のコマンドのプロンプトなら .pecot を初期化する。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$SCRIPT_DIR/lib/core"
INPUT=$(cat)
source "$CORE_DIR/project-root.sh" "$INPUT"
echo "$INPUT" | "$CORE_DIR/pecot-dir-init-detect.sh"
exit 0
