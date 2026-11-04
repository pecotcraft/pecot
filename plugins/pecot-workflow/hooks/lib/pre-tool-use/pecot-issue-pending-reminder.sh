#!/bin/bash
# Issue 起票忘れリマインダー（非ブロック）。
#
# 入力は、hook-input.sh が export 済みの PECOT_HOOK_* で、stdin の JSON は読まない。
# .pecot/state/issue-pending が立っている間は、次の操作をしようとしたときに、リマインドを返す。
# 対象は、Edit / Write / MultiEdit / NotebookEdit / EnterPlanMode と、Bash の `git checkout` と `git switch`。
# リマインドは additionalContext で返し、exit 0 でブロックはしない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "pecot-issue-pending-reminder" true || exit 0

[ -z "$CLAUDE_PROJECT_DIR" ] && exit 0

FLAG="${CLAUDE_PROJECT_DIR}/.pecot/state/issue-pending"
[ -f "$FLAG" ] || exit 0

case "${PECOT_HOOK_TOOL_NAME:-}" in
    Edit|Write|MultiEdit|NotebookEdit)
        case "${PECOT_HOOK_FILE_PATH:-}" in
            */.pecot/tmp/output/*) exit 0 ;;
        esac
        ;;
    EnterPlanMode)
        ;;
    Bash)
        source "${SCRIPT_DIR%/*}/core/hook-input.sh"
        pecot_hook_command_reload
        echo "${PECOT_HOOK_COMMAND:-}" | grep -qE 'git[[:space:]]+(checkout|switch)\b' || exit 0
        ;;
    *)
        exit 0
        ;;
esac

ORIGIN=$(head -n1 "$FLAG" | tr -d '[:space:]')

case "$ORIGIN" in
    w-quick)
        MESSAGE='【リマインダー】Issue 起票が未完了です。

w-quick の Step 1 を完了してから次に進んでください。
  PECOT=pecot
  # Copilot CLI の場合は、次の値にする。

  PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"

  $PECOT issue quick -r owner/repo -m "ユーザー指示の要約"

起票に成功すると自動でこのリマインダーは消えます。'
        ;;
    w-ready)
        MESSAGE='【リマインダー】サブタスク Issue の起票が未完了です。

w-ready の Step 4 を完了してから次に進んでください。
  PECOT=pecot
  # Copilot CLI の場合は、次の値にする。

  PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"

  1. $PECOT issue create --prepare --template task --repo <owner/repo>

  2. 出力されたファイルを編集（title / parent_epic を設定。repository は --repo で反映済）

  3. $PECOT issue create <ファイルパス>

起票に成功すると自動でこのリマインダーは消えます。'
        ;;
    *)
        MESSAGE='【リマインダー】Issue 起票が未完了です。先に `pecot issue quick` または `pecot issue create` を実行してください。'
        ;;
esac

jq -n --arg msg "$MESSAGE" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": $msg
  }
}'
