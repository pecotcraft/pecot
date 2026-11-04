#!/bin/bash
# pecot-skill-compliance: Skill ツール経由の pecot スキル起動時に workflow-compliance を注入
#
# 入力: PECOT_HOOK_SKILL_NAME（hook-input.sh が export 済み。stdin の JSON は読まない）。
# Copilot CLI は名前空間なしの名前（w-help）で届くので、core/skill-name.sh で正規化する。
# stdout: hookSpecificOutput.additionalContext を含む JSON（pecot 系スキル時のみ）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"
source "${SCRIPT_DIR%/*}/core/skill-name.sh"
pecot_hook_enabled "pecot-skill-compliance" true || exit 0

SKILL_NAME=$(pecot_normalize_skill_name "${PECOT_HOOK_SKILL_NAME:-}")

case "$SKILL_NAME" in
    pecot-w|pecot-w:?*)
        MESSAGE=$(cat <<'EOF'
# pecot workflow notes

While running a pecot skill/command:

- Do not create/merge PRs or close issues without explicit user instruction
- Follow the Step order and template format defined in the skill body
- Ask when unclear; do not guess
EOF
)
        jq -n --arg msg "$MESSAGE" '{
          "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": $msg
          }
        }'
        ;;
esac
