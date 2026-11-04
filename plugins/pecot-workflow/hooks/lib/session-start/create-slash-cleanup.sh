#!/bin/bash
# セッション開始時の残存スラッシュコマンド免除フラグクリーンアップ。
# pr-create-slash-pending / issue-create-slash-pending は、セッションをまたいで有効にしない。
# 前セッションの未消費フラグで、実投稿の ask / deny が免除されるのを防ぐため。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "create-slash-cleanup" true || exit 0

rm -f "${CLAUDE_PROJECT_DIR}/.pecot/state/pr-create-slash-pending" \
      "${CLAUDE_PROJECT_DIR}/.pecot/state/issue-create-slash-pending"
