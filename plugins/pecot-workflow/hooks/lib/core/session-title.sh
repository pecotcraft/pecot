#!/bin/bash
# session-title: 作業中の Issue からセッション名を組み、Claude Code の sessionTitle に流す（SessionStart・UserPromptSubmit）。
# 題名は `.pecot-session-title` が同じ番号のときだけ使い、`session-title-sent` と同じなら送り直さない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/pecot-state-guard.sh"
source "${SCRIPT_DIR}/active-issue.sh"
pecot_hook_enabled "session-title" true || exit 0

# Copilot CLI は transcript_path を送らず、sessionTitle も解釈しない。
[ -n "${PECOT_HOOK_TRANSCRIPT_PATH:-}" ] || exit 0
# sessionTitle が適用される source は、この 3 つだけ。
if [ "${PECOT_HOOK_EVENT:-}" = "SessionStart" ]; then
    case "${PECOT_HOOK_SOURCE:-}" in
        startup | resume | fork) ;;
        *) exit 0 ;;
    esac
fi

[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

NUMBER=$(pecot_active_issue_number "$CLAUDE_PROJECT_DIR") || exit 0

TITLE=$(head -n1 "${STATE_DIR}/.pecot-session-title" 2>/dev/null)
case "$TITLE" in
    "#${NUMBER}" | "#${NUMBER} "*) ;;
    *) TITLE="#${NUMBER}" ;;
esac

[ "${PECOT_HOOK_SESSION_TITLE:-}" = "$TITLE" ] && exit 0

# 送った後に利用者が /rename した名は、Issue が変わるまで上書きしない。
SENT_FILE="${STATE_DIR}/session-title-sent"
SENT="${PECOT_HOOK_SESSION_ID:-}:${TITLE}"
[ "$(cat "$SENT_FILE" 2>/dev/null)" = "$SENT" ] && exit 0

pecot_state_dir_ensure "$STATE_DIR" || exit 0
printf '%s\n' "$SENT" > "$SENT_FILE"

jq -n --arg ev "${PECOT_HOOK_EVENT:-}" --arg title "$TITLE" '{
  "hookSpecificOutput": {
    "hookEventName": $ev,
    "sessionTitle": $title
  }
}'
