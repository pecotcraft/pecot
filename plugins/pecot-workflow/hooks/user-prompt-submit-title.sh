#!/bin/bash
# UserPromptSubmit hook: 作業対象 Issue のセッション名を Claude Code に渡す。
# user-prompt-submit.sh は、サブスクリプトの素テキストをそのまま echo する構成で、JSON を混ぜられない。
# そのため、sessionTitle は別エントリから、merge-hook-outputs.sh 経由の JSON で出す。
# Claude Code 専用で、Copilot CLI の hook 出力に sessionTitle は無い。
# hooks-copilot.json には載せない。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$SCRIPT_DIR/lib/core"
INPUT=$(cat)
source "$CORE_DIR/project-root.sh" "$INPUT"
echo "$INPUT" | "$CORE_DIR/merge-hook-outputs.sh" "$CORE_DIR/session-title.sh"
