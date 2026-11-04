#!/usr/bin/env bash
# PreToolUse(Skill) hook: `pecot-v:*` スキル起動検知時に pecotv-dir-init.sh を呼ぶ。
# pecot-workflow プラグインの pre-tool-use-skill.sh と同じ「利用検知ベース」設計。
#
# hooks.json の matcher: "Skill" はツール名のみで絞り、tool_input.skill の中身は
# matcher で絞れない。pecot 側 hook と同居する環境では両方の本 script が並列起動し、
# それぞれ jq でスキル名を判定して排他的に動く（公式推奨パターン）。
#
# スキル名は Claude Code では `pecot-v:v-slidev` のように接頭辞付きで届く。
# Copilot CLI 1.0.103 は、同名のスキルが無い限り `v-slidev` のように名前空間なしで届く。
# 接頭辞（`v-`）だけで判定すると、他のプラグインの同名スキルを取り違える。
# そのため名前空間なしの名前は、自プラグインの skills/<名前>/SKILL.md が実在するときだけ、
# 自プラグインのスキルとして扱う。
# （com.github.copilot/hooks/hooks.json の matcher は Copilot のツール名 `skill` を含む `Skill|skill`）
set -euo pipefail
INPUT=$(cat)
SKILL=$(echo "$INPUT" | jq -r '.tool_input.skill // ""' 2>/dev/null) || SKILL=""
if [[ "$SKILL" == pecot-v:* ]] \
    || { [[ "$SKILL" =~ ^[A-Za-z0-9._-]+$ ]] && [ -f "${CLAUDE_PLUGIN_ROOT}/skills/${SKILL}/SKILL.md" ]; }; then
    "${CLAUDE_PLUGIN_ROOT}/hooks/lib/core/pecotv-dir-init.sh" </dev/null >/dev/null 2>&1 || true
fi
