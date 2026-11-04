#!/bin/bash
# pecot-issue-pending-state: w-quick または w-ready の実行時に、.pecot/state/issue-pending を作成する。
# これにより、Issue 起票忘れリマインダーを起動する。
#
# Skill ツール経由（PostToolUse）と並行する手段で、スラッシュコマンドで直接起動された場合をカバーする。
# 対象は、/pecot-w:w-quick / /pecot-w:w-ready と、名前空間なしの短縮形 /w-quick / /w-ready。
# UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡る。
# Claude Code が受け付ける短縮形入力では、名前空間が付かない（#939）。
#
# 判定は先頭行のみを対象にする（create-slash-flag.sh と同じ方式）。地の文の 2 行目以降で
# コマンド名に言及しただけの入力でフラグを立てないため。
#
# stdin: UserPromptSubmit JSON (.prompt)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"
pecot_hook_enabled "pecot-issue-pending-state" true || exit 0

INPUT=$(cat)
USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

# 先頭行のみを判定対象にする（2 行目以降にスラッシュコマンドが現れても対象外）。
FIRST_LINE="${USER_PROMPT%%$'\n'*}"

ORIGIN=""
if [[ "$FIRST_LINE" =~ ^/(pecot-w:)?w-quick([[:space:]]|$) ]]; then
    ORIGIN="w-quick"
elif [[ "$FIRST_LINE" =~ ^/(pecot-w:)?w-ready([[:space:]]|$) ]]; then
    ORIGIN="w-ready"
fi

if [ -n "$ORIGIN" ]; then
    STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
    # pecot 未使用リポでは pending フラグを立てない（gitignore-before-write #666）。
    pecot_state_dir_ensure "$STATE_DIR" || exit 0
    echo "$ORIGIN" > "$STATE_DIR/issue-pending"
fi
