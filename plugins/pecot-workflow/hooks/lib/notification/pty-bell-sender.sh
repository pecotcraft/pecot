#!/bin/bash
# pty-bell-sender: PTYを遡ってBEL文字を送信。
#
# Claude Codeが通知を送る際にBEL文字をPTYに送信。
# Windows TerminalのbellStyle設定により、タブフラッシュ・通知音・タスクバー通知が動作。
#
# フックのstdoutはClaude Codeに捕捉されるため、プロセスツリーを遡って
# Claude CodeのPTY（/dev/pts/*）を特定し、BEL文字を直接書き込む。
#
# stdin: JSON (.notification_type)
# stdout: なし
#
# 対応する通知タイプは次のとおり。
#   permission_prompt  - 許可ダイアログ表示時。
#   idle_prompt        - 入力待ち時。
#   elicitation_dialog - 質問ダイアログ表示時。
#   auth_success       - 認証成功時（通知スキップ）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "pty-bell-sender" true || exit 0

INPUT=$(cat)

# 通知タイプを取得。
NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // "unknown"' 2>/dev/null)

# auth_successは通知不要。
if [ "$NOTIFICATION_TYPE" = "auth_success" ]; then
    exit 0
fi

# プロセスツリーを遡ってClaude CodeのPTYを特定。
PID=$$
for _ in $(seq 1 10); do
    PTY=$(readlink /proc/$PID/fd/1 2>/dev/null)
    if [ -n "$PTY" ] && [[ "$PTY" == /dev/pts/* ]] && [ -c "$PTY" ]; then
        printf '\a' > "$PTY"
        break
    fi
    PID=$(ps -p "$PID" -o ppid= 2>/dev/null | tr -d ' ')
    [ -z "$PID" ] && break
done

exit 0
