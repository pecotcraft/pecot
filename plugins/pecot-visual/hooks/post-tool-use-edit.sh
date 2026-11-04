#!/bin/bash
# PostToolUse hook: Edit ツール実行後に v-slidev プロジェクトなら lint を自動実行
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"

INPUT=$(cat)
# 引数順が additionalContext の連結順になる。判定でない抜粋提示を先、
# 修正指示を伴う ESLint 違反と文章規則の違反を後にする。
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" \
    "$LIB_DIR/layout-conventions.sh" \
    "$LIB_DIR/eslint-check.sh" \
    "$LIB_DIR/text-lint-check.sh" \
    "$LIB_DIR/validate-references-check.sh"
