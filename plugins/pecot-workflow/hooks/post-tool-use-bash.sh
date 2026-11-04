#!/bin/bash
# PostToolUse hook: Bashツール実行後の処理。
# bash-post-match.sh が commit の成功を判定し、そうでなければここで終了する
# （一致したときだけ project-root と対象リポジトリを解決する）。
# merge-hook-outputs.sh で複数サブスクリプトの出力を単一JSONにマージして返す。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"
PECOT_PROJECT_ROOT_LAZY="1"

INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
source "$LIB_DIR/bash-post-match.sh" "$INPUT"
[ -z "$PECOT_POST_MATCHED" ] && exit 0
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$LIB_DIR/commit-info-display.sh" "$LIB_DIR/auto-push.sh"
