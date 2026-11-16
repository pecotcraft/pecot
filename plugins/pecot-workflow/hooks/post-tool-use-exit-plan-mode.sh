#!/bin/bash
# PostToolUse hook: ExitPlanMode 後の計画の更新と実装の引き継ぎのリマインド。
# w-active・w-quick の frontmatter の hooks.PostToolUse から、--mode=active|quick 付きで呼ばれる。
# hooks.json には登録しない。引数は exit-plan-remind.sh にそのまま渡す。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$LIB_DIR/exit-plan-remind.sh" "$@"
