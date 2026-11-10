#!/bin/bash
# git commit成功後のコミット情報表示
#
# 入力: PECOT_POST_COMMIT / PECOT_POST_REPO_DIR（bash-post-match.sh が成功した commit を判定して export）。
# stdin の JSON は読まない（出力の取り方は Claude / Copilot の両形式を bash-post-match が吸収する）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/git-repo-resolver.sh"
pecot_hook_enabled "commit-info-display" true || exit 0

[ "${PECOT_POST_COMMIT:-}" = "1" ] || exit 0

# bash-post-match.sh が解決した対象リポジトリ（source 時に REPO_DIR が空になるため別名で受ける）。
REPO_DIR="${PECOT_POST_REPO_DIR:-}"

# === コミット情報取得（全コミット対象） ===
COMMIT_MSG=$(_git log -1 --format='%s' 2>/dev/null || echo "")
if _git rev-parse HEAD~1 >/dev/null 2>&1; then
    DIFF_STAT=$(_git diff --stat HEAD~1..HEAD 2>/dev/null || echo "")
else
    DIFF_STAT=$(_git diff --stat --cached HEAD 2>/dev/null || echo "")
fi

MESSAGE=$(hook_message note "commit complete
message: ${COMMIT_MSG}
changes: ${DIFF_STAT}")

jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": $msg
  }
}'
