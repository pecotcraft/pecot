#!/bin/bash
# PreToolUse (ExitPlanMode): 計画ファイルのパス記録 + 初回ExitPlanModeブロック＆リマインド。
# 記録は first-block より先に動かせる。
# first-block が deny する呼び出しでは記録しない。
# この判定は、first-block が deny のために作る .exit-plan-confirmed の有無に依るため。
# merge-hook-outputs.sh で複数サブスクリプトの出力を単一JSONにマージして返す。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/pre-tool-use"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/plan-path-recorder.sh" "$LIB_DIR/exit-plan-mode-first-block.sh"
