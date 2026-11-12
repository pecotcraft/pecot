#!/bin/bash
# 外部反映コマンド（gh pr merge）を検出し、ask を要求するコアチェック。
# 入力は HOOK_COMMAND。出力は exit 0 + 空 stdout = 素通し、exit 11 + stdout = ask、exit 2 + stderr = 内部エラー。
# HOOK_COMMAND をセグメントに分け、セグメント先頭（環境変数前置のみ許容）の起動形で判定する。
# time / xargs / { …; } など、別語を前置した形や展開形は捕捉できない（検出抜け）。
# pecot の起動は pecot-cli-deny.sh が deny する。MCP ツールの issue_create / issue_quick / pr_create の ask は mcp-handlers/pecot-post-ask.sh が持つ。
# スラッシュコマンド起点のフラグ（.pecot/state/merge-slash-pending）は存在確認のみで削除しない。消費は MCP ツール pr_cleanup の成功時。
# 正規表現は POSIX ERE の [[:space:]] を使う。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/config-dispatcher.sh"
source "${SCRIPT_DIR}/command-segments.sh"
source "${SCRIPT_DIR}/mcp-guidance.sh"

if [ -z "$HOOK_COMMAND" ]; then
  hook_message error "HOOK_COMMAND environment variable is required" >&2
  exit 2
fi

# 改行区切りを ; と同じ区切りとして扱い、クオートを正規化してから判定する。
HOOK_COMMAND="${HOOK_COMMAND//$'\n'/;}"
HOOK_COMMAND="$(_dequote "$HOOK_COMMAND")"

GH_PR_MERGE_PATTERN="${_SEG_ANCHOR}${_GH}[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)"

# config キー有効かつ、いずれかのセグメントが pattern に一致した時点で ask（exit 11）する。
# skip_pattern は同一セグメント内に一致したら素通し（空なら免除なし）。flag_file が存在すればコマンド全体を素通しする。
# ループ入力は here-string で渡す。
# パイプだとサブシェルになり、exit がスクリプト全体へ及ばず素通しになる。
_external_post_check() {
  local config_key="$1" pattern="$2" skip_pattern="$3" message="$4" flag_file="$5"
  pecot_hook_enabled "$config_key" true || return 0
  local seg
  while IFS= read -r seg; do
    [[ "$seg" =~ $pattern ]] || continue
    if [ -n "$skip_pattern" ] && [[ "$seg" =~ $skip_pattern ]]; then
      continue
    fi
    if [ -n "$flag_file" ] && [ -f "$flag_file" ]; then
      return 0
    fi
    hook_message warning "$message"
    exit 11
  done <<< "$(_split_segments "$HOOK_COMMAND")"
  return 0
}

GH_MSG="$(mcp_guidance_pr_merge)"

# スラッシュコマンド起点の免除フラグ（設置は user-prompt-submit、残骸掃除は session-start）。
# 設置側は CLAUDE_PROJECT_DIR、本スクリプトは HOOK_WORKING_DIR を見る。ずれたときは免除が働かず ask のまま（fail-safe）。
MERGE_SLASH_FLAG="${HOOK_WORKING_DIR}/.pecot/state/merge-slash-pending"

# gh pr merge: 確認フラグ免除なし。/w-merge 起点フラグがあれば素通し（存在確認のみ・削除しない）。
_external_post_check "gh-pr-merge-ask" "$GH_PR_MERGE_PATTERN" "" "$GH_MSG" "$MERGE_SLASH_FLAG"

exit 0
