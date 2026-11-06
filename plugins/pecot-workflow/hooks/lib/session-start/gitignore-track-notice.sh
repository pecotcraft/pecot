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
PROJECT_DIR="${PROJECT_DIR%/}"  # 末尾スラッシュを除去（既存慣行）

TARGET="${PROJECT_DIR}/.pecot/.gitignore"
[ -f "$TARGET" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

if ! git -C "$PROJECT_DIR" ls-files --error-unmatch -- .pecot/.gitignore >/dev/null 2>&1; then
    echo '`.pecot/.gitignore` が未追跡です。`git add -f .pecot/.gitignore` で追加して commit すると、新しい clone や CI でも `.pecot/` の生成物が未追跡として出なくなります。追跡していないブランチへ切り替えるとファイルは消えますが、次の hook で書き直されます。'
    exit 0
fi

ENSURE="${SCRIPT_DIR%/*}/core/pecot-gitignore-ensure.sh"
MISSING=$(grep -vE '^[[:space:]]*(#|$)' <("$ENSURE" --print) | while IFS= read -r line; do
    tr -d '\r' < "$TARGET" | grep -qxF -- "$line" || printf '%s\n' "$line"
done)
if [ -n "$MISSING" ]; then
    echo "追跡中の \`.pecot/.gitignore\` に、現行の定義の行が欠けています。\`${ENSURE} --print > .pecot/.gitignore\` で書き直して commit してください。"
fi
