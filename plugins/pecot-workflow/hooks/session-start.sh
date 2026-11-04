#!/bin/bash
# SessionStart: セッション開始時の処理。
# - Git同期 + VSCodeワークスペース情報。
# Claude Code は startup|clear|resume|fork、Copilot CLI は matcher なしで new|resume のとき起動する。
# 出力（素のテキスト）は、merge-hook-outputs.sh で JSON にする。
# Copilot CLI は SessionStart で、トップレベルの additionalContext だけをモデルに渡す。
# 素のテキストは届かない。
# 3 本に分けていた旧エントリは中身が同じだったため、1 本にまとめた。
# session-title は JSON を出す。
# そのため、素テキストを出す session-start-common とは別のスクリプトとして渡す。
# merge-hook-outputs.sh はスクリプトごとに出力を判定する。同じスクリプト内では入り込む。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)
source "$SCRIPT_DIR/lib/core/project-root.sh" "$INPUT"

echo "$INPUT" | "$SCRIPT_DIR/lib/core/merge-hook-outputs.sh" "$SCRIPT_DIR/lib/session-start-common.sh" "$SCRIPT_DIR/lib/core/session-title.sh"
