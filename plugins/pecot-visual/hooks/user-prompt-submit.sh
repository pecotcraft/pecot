#!/usr/bin/env bash
# UserPromptSubmit hook: `/pecot-v:` プロンプト検知時に pecotv-dir-init.sh を呼ぶ。
# pecot-workflow プラグインの user-prompt-submit.sh と同じ「利用検知ベース」設計。
#
# 将来この検知後処理が増える場合は pecot 側のように lib/user-prompt-submit/ へ
# dispatcher 化して個別スクリプトに分離する想定（現在は init 1 本のみ）。
#
# jq の `test()` は正規表現。`^/pecot-v:` の `:` `/` は正規表現メタ文字ではないため
# リテラルとして解釈される。スキル名に `.` `*` 等を含める拡張時は要再考。
set -euo pipefail
INPUT=$(cat)
if echo "$INPUT" | jq -e '.prompt | test("^/pecot-v:")' >/dev/null 2>&1; then
    "${CLAUDE_PLUGIN_ROOT}/hooks/lib/core/pecotv-dir-init.sh" </dev/null >/dev/null 2>&1 || true
fi
