#!/bin/bash
# session-title: 作業対象 Issue からセッション名を組み、Claude Code の sessionTitle に流す。
#
# セッション名は Claude Code が英語スラッグで自動生成し、Remote Control と /resume の一覧に
# そのまま出る。
# pecot CLI が作業対象を記録した後は、`.pecot-session-title` をセッション名にする（CLI が `#<番号> <Issue タイトル>` に整形済み）。
# SessionStart と UserPromptSubmit の両方から、merge-hook-outputs.sh 経由で呼ばれる。
# これで、新規起動・再開と、セッション途中の起票の次のプロンプトを、同じ手段で賄う。
#
# 次の場合は何も出さない（記録もしない）。
# - Claude Code ではない（hook 入力に transcript_path が無い）。
#   Copilot CLI は SessionStart / UserPromptSubmit に transcript_path を送らない（1.0.103 確認）。
#   また、sessionTitle も解釈しない。
#   session_title キーは、名前の無いセッションでは入力に付かないため、判別に使えない。
# - SessionStart の source が startup / resume / fork 以外（公式仕様で sessionTitle が適用されるのはこの 3 つだけ）
# - 入力の session_title が題名と同じ（既に付いている。キーが無ければ空）
# - 直前に出した `<session_id>:<題名>`（`session-title-sent`）と同じ（毎プロンプト再送しない）。
#   自分が送った後に利用者が /rename で付け直した名は、Issue が変わるまで上書きしない。
#
# 入力は、hook-input.sh が export 済みの PECOT_HOOK_* で、stdin は読まない。
# 読む変数は、PECOT_HOOK_EVENT / PECOT_HOOK_SOURCE / PECOT_HOOK_SESSION_ID。
# 残りは PECOT_HOOK_TRANSCRIPT_PATH / PECOT_HOOK_SESSION_TITLE。
# 出力は、変化したときだけ次の JSON を出す。
# {"hookSpecificOutput":{"hookEventName":<event>,"sessionTitle":<題名>}}。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/pecot-state-guard.sh"
pecot_hook_enabled "session-title" true || exit 0

[ -n "${PECOT_HOOK_TRANSCRIPT_PATH:-}" ] || exit 0
if [ "${PECOT_HOOK_EVENT:-}" = "SessionStart" ]; then
    case "${PECOT_HOOK_SOURCE:-}" in
        startup | resume | fork) ;;
        *) exit 0 ;;
    esac
fi

[ -n "${CLAUDE_PROJECT_DIR:-}" ] || exit 0
STATE_DIR="${CLAUDE_PROJECT_DIR}/.pecot/state"

ACTIVE=$(head -n1 "${STATE_DIR}/.pecot-active" 2>/dev/null)
[ -n "$ACTIVE" ] || exit 0
NUMBER="${ACTIVE##*/}"
case "$NUMBER" in
    '' | *[!0-9]*) exit 0 ;;
esac

# 題名ファイルが無い・空・別 Issue のもの（旧版の CLI が書いた .pecot-active だけがある、
# または Issue 切替の途中）のときは番号だけにする。
TITLE=$(head -n1 "${STATE_DIR}/.pecot-session-title" 2>/dev/null)
case "$TITLE" in
    "#${NUMBER}" | "#${NUMBER} "*) ;;
    *) TITLE="#${NUMBER}" ;;
esac

[ "${PECOT_HOOK_SESSION_TITLE:-}" = "$TITLE" ] && exit 0

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
