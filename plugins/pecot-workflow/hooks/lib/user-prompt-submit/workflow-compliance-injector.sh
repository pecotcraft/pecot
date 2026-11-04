#!/bin/bash
# workflow-compliance-injector: pecot コマンド検出時に強制指示テキストを出力。
#
# 検出対象は、名前空間付き（/pecot-w:w-pr）と、名前空間なしの短縮形（/w-pr）。
# UserPromptSubmit の .prompt にはユーザーの生入力がそのまま渡る。
# Claude Code が受け付ける短縮形入力では、名前空間が付かない（#939）。
# 短縮形側は、コマンド名を列挙せず `w-` プレフィックス（pecot の全コマンドが持つ命名規約）で拾う。
# 列挙すると、コマンド追加時に対象外のまま気づけないため。
# 判定は pecot-dir-init-detect.sh と同一パターン。
#
# ハイフン形（/pecot-a-pr）は捕捉しない。
# Claude Code がコマンド解決時に正規形へ変換し、.prompt には `/pecot-w:w-pr` が渡る。
# そのため、この形は .prompt に現れない（#939 確認）。
#
# 判定は先頭行のみを対象にする（create-slash-flag.sh と同じ方式）。残る誤検知は
# 「先頭行が `/w-` で始まる他プラグインのコマンド」に限られ、その場合の実害は
# 無関係な助言テキストが 1 ターン注入されるだけ（状態変更・ガード免除は伴わない）。
#
# stdin: JSON (.prompt)
# stdout: 指示テキスト（検出時のみ）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
pecot_hook_enabled "workflow-compliance-injector" true || exit 0

INPUT=$(cat)

USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')

# 先頭行のみを判定対象にする（2 行目以降にスラッシュコマンドが現れても対象外）。
FIRST_LINE="${USER_PROMPT%%$'\n'*}"

if [[ "$FIRST_LINE" =~ ^/(pecot-w:)?w- ]]; then
    cat <<'EOF'
# pecot workflow notes

While running a pecot skill/command:

- Do not create/merge PRs or close issues without explicit user instruction
- Follow the Step order and template format defined in the skill body
- Ask when unclear; do not guess
EOF
    echo ""
fi
