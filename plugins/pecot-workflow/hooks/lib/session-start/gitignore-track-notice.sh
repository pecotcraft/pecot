#!/bin/bash
# .pecot/.gitignore の追跡を案内する。index は変異させない（実行は利用者/AI に委ねる）。
#
# - 追跡していない: `git add -f` と commit で追跡を始める手順を案内する。
# - 追跡していて、定義（ensure --print）の行が欠けている: 直す手順を案内する。
#   利用者が足した行は差として扱わない。比べる前に \r を落とす。
# 非 git ディレクトリ・git 不在・ファイル不在では無出力で exit 0。
# SessionStart の stdout は、セッションコンテキストに注入される。
#
# set -euo pipefail は付けない。lib/session-start/ の既存サブスクリプト群の慣行に揃える。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "gitignore-track-notice" true || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
[ -z "$PROJECT_DIR" ] && exit 0
# 末尾スラッシュを除去（既存慣行）
PROJECT_DIR="${PROJECT_DIR%/}"

TARGET="${PROJECT_DIR}/.pecot/.gitignore"
[ -f "$TARGET" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

if ! git -C "$PROJECT_DIR" ls-files --error-unmatch -- .pecot/.gitignore >/dev/null 2>&1; then
    hook_message note '`.pecot/.gitignore` is untracked. Adding it with `git add -f .pecot/.gitignore` and committing keeps the generated files under `.pecot/` from showing as untracked in new clones and CI. Switching to a branch that does not track it removes the file, but the next hook rewrites it.'
    exit 0
fi

ENSURE="${SCRIPT_DIR%/*}/core/pecot-gitignore-ensure.sh"
MISSING=$(grep -vE '^[[:space:]]*(#|$)' <("$ENSURE" --print) | while IFS= read -r line; do
    tr -d '\r' < "$TARGET" | grep -qxF -- "$line" || printf '%s\n' "$line"
done)
if [ -n "$MISSING" ]; then
    hook_message note "the tracked \`.pecot/.gitignore\` lacks lines of the current definition. Rewrite it with \`${ENSURE} --print > .pecot/.gitignore\` and commit."
fi
