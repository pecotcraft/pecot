#!/bin/bash
# セッション開始時の残存 issue-pending フラグクリーンアップ。
# w-quick / w-ready を Issue 未起票のまま中断した場合の stale フラグを消し、
# 次セッションで Edit/Write 時のリマインダーが鳴り続けるのを防ぐ。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "issue-pending-cleanup" true || exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"
ISSUE_PENDING="$STATE_DIR/issue-pending"

if [[ -f "$ISSUE_PENDING" ]]; then
    rm -f "$ISSUE_PENDING"
fi
