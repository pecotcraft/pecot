#!/bin/bash
# create-slash-flag: ユーザープロンプトの先頭行がスラッシュコマンドのとき、
# 対応する外部反映免除フラグを .pecot/state/ に設置する。
#   /pecot-w:w-pr /w-pr → pr-create-slash-pending。
#   /pecot-w:w-merge /w-merge → merge-slash-pending（gh pr merge の ask を免除）。
#     消費は MCP ツール session_finish の成功時。
#   /pecot-w:w-quick|w-ready|w-backlog|w-issueize → issue-create-slash-pending。
#   /w-quick|w-ready|w-backlog|w-issueize → issue-create-slash-pending。
#     フラグの内容は起点コマンド名（名前空間なしの w-quick 等）で、デバッグ用。
#
# UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡る。
# Claude Code はプラグインコマンドを名前空間なしの短縮形（/w-pr）でも受け付ける。
# その場合は .prompt にも短縮形が渡るため、フル修飾と短縮形の双方を捕捉する（#939）。
# 短縮形の捕捉により、他プラグインの同名コマンド（/w-pr 等）でもフラグは立つ。
# ただし、免除の対象は pecot 自身の外部反映コマンドに限られる。
# フラグはエージェント側からも作成できるため、そもそも防御境界ではない（README 既記載）。
# このため許容する。
#
# フラグは「投稿成功まで生存する一発券」。削除は CLI が実投稿成功時に行う（消費）。
# 放置フローの残骸はセッション開始時の create-slash-cleanup.sh が掃除する。
# 本スクリプトは設置のみを行い、削除しない（ターンを跨ぐ聞き返しフロー
# — 起票内容の確認質問にユーザーが地の文で補足するケース — でフラグを生存させる）。
#
# stdin: UserPromptSubmit JSON (.prompt)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/pecot-state-guard.sh"

INPUT=$(cat)
USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

# 先頭行のみを判定対象にする（2 行目以降にスラッシュコマンドが現れても対象外）。
FIRST_LINE="${USER_PROMPT%%$'\n'*}"

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

if [[ "$FIRST_LINE" =~ ^/(pecot-w:)?w-pr([[:space:]]|$) ]]; then
    pecot_hook_enabled "pr-create-slash-flag" true || exit 0
    # pecot 未使用リポではフラグを立てない（gitignore-before-write #666）。
    pecot_state_dir_ensure "$STATE_DIR" || exit 0
    touch "$STATE_DIR/pr-create-slash-pending"
elif [[ "$FIRST_LINE" =~ ^/(pecot-w:)?w-merge([[:space:]]|$) ]]; then
    pecot_hook_enabled "merge-slash-flag" true || exit 0
    pecot_state_dir_ensure "$STATE_DIR" || exit 0
    touch "$STATE_DIR/merge-slash-pending"
elif [[ "$FIRST_LINE" =~ ^/(pecot-w:)?(w-quick|w-ready|w-backlog|w-issueize)([[:space:]]|$) ]]; then
    ORIGIN="${BASH_REMATCH[2]}"
    pecot_hook_enabled "issue-create-slash-flag" true || exit 0
    pecot_state_dir_ensure "$STATE_DIR" || exit 0
    echo "$ORIGIN" > "$STATE_DIR/issue-create-slash-pending"
fi
