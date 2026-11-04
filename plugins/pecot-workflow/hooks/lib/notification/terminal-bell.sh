#!/bin/bash
# terminal-bell: Claude Code の通知音（BEL）を terminalSequence で出す。
#
# Claude Code の Stop / Notification の hook 出力のトップレベル `terminalSequence` は、
# Claude Code が端末へ流す制御列。BEL を渡すと、Windows Terminal の bellStyle 設定で
# タブフラッシュ・通知音・タスクバー通知が動く。PTY を遡って書き込む pty-bell-sender.sh と
# 違い、プロセスツリーを辿らない。Copilot CLI にはこの出力が無いため、Copilot 用の定義は
# stop-copilot.sh（pty-bell-sender.sh）を指す。
#
# 呼び出し元は、hooks/stop.sh と hooks/notification.sh（merge-hook-outputs.sh 経由）。
# 出力は {"terminalSequence":"\u0007"}。
#
# Notification の matcher（permission_prompt|idle_prompt|elicitation_dialog）は、auth_success などを起動しない。
# そのため、通知タイプの判定はここでは行わない。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
# pty-bell-sender: false で通知音を止めている利用者に、更新後また鳴らさないよう両方のキーを見る。
pecot_hook_enabled "pty-bell-sender" true || exit 0
pecot_hook_enabled "terminal-bell" true || exit 0

jq -n '{"terminalSequence": "\u0007"}'
exit 0
