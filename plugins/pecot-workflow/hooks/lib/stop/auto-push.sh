#!/bin/bash
# Stop hook: auto-push URLをユーザーに表示してフラグを消す
#
# フラグ: .pecot/state/.auto-push-urls
# PostToolUse auto-push.sh が書き込み、このスクリプトが読み取り+削除

AUTO_PUSH_FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/.auto-push-urls"

# フラグがなければ何もしない
[ -f "$AUTO_PUSH_FLAG" ] || exit 0

# 内容を読み取って削除
SYS_MESSAGE=$(cat "$AUTO_PUSH_FLAG")
rm -f "$AUTO_PUSH_FLAG"

[ -z "$SYS_MESSAGE" ] && exit 0

jq -n --arg sys "$SYS_MESSAGE" '{"systemMessage": $sys}'
