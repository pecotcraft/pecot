#!/bin/bash
# Stop hook (Copilot CLI): PTY ベル + auto-push URL表示 + .pecot 誤配置検知。
# Copilot CLI の hook 出力には terminalSequence が無いため、プロセスツリーを遡って
# PTY に BEL を直接書き込む（pty-bell-sender.sh）。com.github.copilot/hooks/hooks.json の Stop だけが指す。
# JSON を出力しうるサブスクリプションは merge-hook-outputs.sh で単一JSONにマージして返す。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"
echo "$INPUT" | "$SCRIPT_DIR/lib/notification/pty-bell-sender.sh"
echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$SCRIPT_DIR/lib/stop/auto-push.sh" "$SCRIPT_DIR/lib/stop/misplaced-pecot-notice.sh"
