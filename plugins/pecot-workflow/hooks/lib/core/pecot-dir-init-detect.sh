#!/bin/bash
# pecot 利用の検知 → .pecot ディレクトリ初期化の起動。
#
# UserPromptSubmit の `/pecot-w:` `/w-` プレフィックスと PreToolUse(Skill) の `pecot-w:` skill を
# 単一の jq 式で判定する。UserPromptSubmit 入力に .tool_input は無く、PreToolUse 入力に
# .prompt は無いため、or 統合による形式上のトリガ面拡大に実害はない。
#
# .prompt 側が名前空間なしの短縮形（/w-help）も見るのは、Claude Code がプラグイン
# コマンドを短縮形でも受け付け、その場合 .prompt に名前空間が付かないため（#939）。
# .tool_input.skill 側は Claude Code では正規名（`^pecot-w:`）で届く。Copilot CLI は名前空間なしの
# 名前（w-help）で届くため、PECOT_HOOK_SKILL_NAME を skill-name.sh で正規化してから判定する。
#
# 配置は hooks/lib/core/pecot-dir-init-detect.sh。
# 呼び出し元: hooks/user-prompt-submit.sh / hooks/pre-tool-use-skill.sh。
#
# stdout へは何も出さない（UserPromptSubmit の stdout は全プロンプトへ文脈注入される）。
# set -e は入れない。pecot_hook_enabled の判定も入れない。
# .pecot 初期化は機構であり、個別ガードの有効・無効設定の対象ではない。
# 前例は pecot-dir-init.sh / merge-hook-outputs.sh。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/config-dispatcher.sh"
source "$SCRIPT_DIR/skill-name.sh"

# .prompt は長くなりうるため export せず、UserPromptSubmit では stdin から読む。
INPUT=$(cat)

SKILL_NAME=$(pecot_normalize_skill_name "${PECOT_HOOK_SKILL_NAME:-}")

if [[ "$SKILL_NAME" == pecot-w:* ]] || echo "$INPUT" | jq -e \
    '(.prompt // "" | test("^/(pecot-w:)?w-"))' \
    >/dev/null 2>&1; then
    "$SCRIPT_DIR/pecot-dir-init.sh" </dev/null >/dev/null 2>&1 || true
fi
exit 0
